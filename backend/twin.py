"""Closed-loop twin runtime: virtual Edge-AI fleet + hardware ingestion + fusion + ST-GNN forecast.

One `tick()` = one broadcast frame. The rainfall that drives the twin comes from the selected
precipitation source (POST /api/v1/live/control):
  HISTORICAL  PLAYBACK mode: a storm from public/data/precip_library.json replayed on the storm
              clock (the 12 h design typhoon by default, the original playback);
  LIVE_FEED   SCENARIO mode pinned to the live Baguio rate (Open-Meteo / Tomorrow.io);
  TWIN        SCENARIO mode pinned to the requested rainfall / blockage.
Whenever a physical node with scope "full_catchment" has uplinked in the last HARDWARE_HOLD_S
seconds the twin is driven by that node (HARDWARE mode): its measured capacity is inverted
through the LUT to the rainfall that reproduces it. "single_node" uplinks only replace that
sensor's record (and feed the forecaster's assimilation).
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass

import numpy as np

from . import edge_dsp as dsp
from .intelligence import STORM_PERIOD_S, FewsFusion, arbitrate, storm_profile, utc_now_iso
from .lut import TwinLut, haversine_m
from .stgnn import STEPS, ForecastInput, STGNNForecaster
from .weather_feed import DESIGN_STORM_ID, SOURCES, LiveFeed, hyetograph_rate, hyetograph_trajectory, load_library

STORM_MIN_PER_WALL_S = 6.0           # 120 s playback loop == 12 h typhoon
HARDWARE_HOLD_S = 30.0
FORECAST_PERIOD_S = 5.0              # recompute the ST-GNN at most this often (wall s) unless inputs change
EN07_MAST_MM = 7300.0                # lagoon staff-gauge mast above the 1426.5 m invert
EN08_MAST_MM = 5900.0                # intake mast above the 1428.0 m rack sill
CROWN_MOUNT_CLEARANCE_MM = 300.0     # beyond A02YYUW range from the lid: bolt to the crown
LID_LOSS_DB = 18.0                   # cast-iron manhole lid
DEEP_SHAFT_LOSS_DB = 30.0            # crown-mounted sensor in a > 4.4 m shaft / rock tunnel
JETSON_BLOCKAGE_THRESHOLD = 50.0


@dataclass
class DistanceRig:
    """Server-side edge pipeline for boards that only send raw distance / fill readings."""
    kalman: dsp.KalmanState
    window: list
    last: float


DISTANCE_RIG_RESET_S = 10.0          # a gap longer than this restarts the rig's Kalman filter
BENCH_FULL_PCT_FRACTION = dsp.STANDPIPE_FULL_BORE_FRACTION


@dataclass
class HardwareUplink:
    sensor: dict
    received: float
    scope: str = "full_catchment"


class TwinRuntime:
    def __init__(self, lut: TwinLut | None = None, seed: int = 20240917, feed: LiveFeed | None = None):
        self.lut = lut or TwinLut()
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.mode = "PLAYBACK"
        self.precip_source = "HISTORICAL"
        self.library = load_library()
        self.storms = {s["id"]: s for s in self.library["storms"]}
        self.storm_id = DESIGN_STORM_ID
        self.feed = feed or LiveFeed()
        self.fixed_rain, self.fixed_clog = 25.0, 0.0
        self.clock_s = 0.0
        self.seq = 0
        self.hardware: dict[str, HardwareUplink] = {}
        self.distance_rigs: dict[str, DistanceRig] = {}
        self.fews = FewsFusion(self.lut)
        self.forecaster = STGNNForecaster(self.lut.network, self.library, self.lut.tunnel_limit)
        self._fc: dict | None = None
        self._fc_key: tuple | None = None
        self._fc_t = 0.0
        self.nodes: dict[str, dsp.EdgeNode] = {}
        self.sensors_meta = {s["sensor_id"]: s for s in self.lut.network["sensors"] if s["is_active"]}
        self.eui_to_id = {s["device_eui"].upper(): sid for sid, s in self.sensors_meta.items()}
        self._build_fleet()
        self.latest: dict | None = None
        self.dirty = False

    # ------------------------------------------------------------------ fleet
    def _build_fleet(self) -> None:
        net = self.lut.network
        conduits = {c["id"]: c for c in net["conduits"]}
        gw = max((n for n in net["nodes"]), key=lambda n: n["rim_elev_m"])   # highest ridge manhole site
        self.gateway = dict(node_id=gw["id"], lon=gw["coordinates"][0], lat=gw["coordinates"][1], elev=gw["rim_elev_m"])
        for k, (sid, s) in enumerate(self.sensors_meta.items()):
            pg = s["pipe_geometry"]
            dist = haversine_m((s["coordinates"][0], s["coordinates"][1]), (self.gateway["lon"], self.gateway["lat"]))
            geom, obstruction = None, 0.0
            if s["attached_kind"] == "CONDUIT":
                c = conduits[s["attached_to"]]
                geom = dsp.ConduitGeom(c["shape"], c["geometry"]["rise_m"], c["geometry"]["span_m"],
                                       c["geometry"]["haunch_m"] or 0.0, c["manning_n"], c["slope"])
                full = c["geometry"]["rise_m"]
                mount = (s["coordinates"][2] - pg["invert_elev_m"]) * 1000.0
                obstruction = LID_LOSS_DB
                if mount > dsp.MAX_RANGE_MM - 100.0:
                    mount = full * 1000.0 + CROWN_MOUNT_CLEARANCE_MM
                    obstruction = DEEP_SHAFT_LOSS_DB
            elif s["attached_kind"] == "STORAGE":
                full, mount = net["lagoon"]["max_depth_m"], EN07_MAST_MM
            else:
                full, mount = net["orifices"][0]["height_m"], EN08_MAST_MM
            cfg = dsp.EdgeNodeConfig(sid, s["device_eui"], s["hardware"], full, mount, geom, dist, obstruction, s["vbat_v"])
            self.nodes[sid] = dsp.EdgeNode(cfg, rng=random.Random(self.seed + k))

    # ------------------------------------------------------------------ control
    def set_scenario(self, mode: str, rain: float | None = None, clog: float | None = None) -> None:
        """Legacy control: PLAYBACK replays the selected storm, SCENARIO pins rain / blockage."""
        self.mode = mode
        self.precip_source = "HISTORICAL" if mode == "PLAYBACK" else "TWIN"
        if rain is not None:
            self.fixed_rain = float(np.clip(rain, 0, 250))
        if clog is not None:
            self.fixed_clog = float(np.clip(clog, 0, 95))
        if mode == "PLAYBACK":
            self.hardware.clear()
        self._fc_key = None

    def set_control(self, source: str, storm_id: str | None = None, rain: float | None = None,
                    clog: float | None = None) -> dict:
        """Select the precipitation source that drives the twin and the ST-GNN forecast."""
        if source not in SOURCES:
            raise ValueError(f"unknown precip_source {source!r}")
        if clog is not None:
            self.fixed_clog = float(np.clip(clog, 0, 95))
        if source == "HISTORICAL":
            sid = storm_id or self.storm_id
            if sid not in self.storms:
                raise ValueError(f"unknown storm_id {sid!r}")
            self.storm_id, self.mode, self.clock_s = sid, "PLAYBACK", 0.0
        else:
            self.mode = "SCENARIO"
            if rain is not None:
                self.fixed_rain = float(np.clip(rain, 0, 250))
            if source == "LIVE_FEED":
                self.feed.refresh_async()
        self.precip_source = source
        self._fc_key = None
        self.dirty = True
        return self.control_state()

    def control_state(self) -> dict:
        return dict(precip_source=self.precip_source, storm_id=self.storm_id, mode=self.mode,
                    rainfall_mm_hr=self.fixed_rain, trash_rack_blockage_pct=self.fixed_clog,
                    feed=self.feed.snapshot() if self.precip_source == "LIVE_FEED" else None,
                    storms=[dict(id=s["id"], label=s["label"], duration_min=s["duration_min"], peak_mm_hr=s["peak_mm_hr"],
                                 total_mm=s["total_mm"], synthetic=s["synthetic"], note=s["note"])
                            for s in self.library["storms"]])

    def resolve_sensor(self, ident: str | None) -> str | None:
        if not ident:
            return None
        key = ident.strip()
        if key.upper() in self.eui_to_id:
            return self.eui_to_id[key.upper()]
        up = key.upper()
        return up if up in self.sensors_meta else None

    def ingest(self, sensor_id: str, word: int, extras: dict, rssi: float | None, snr: float | None,
               scope: str = "full_catchment") -> dict:
        """Accept a physical uplink (LoRaWAN webhook, Wi-Fi POST, USB serial bridge or browser rig)."""
        d = dsp.unpack_payload(word)
        meta = self.sensors_meta[sensor_id]
        node = self.nodes[sensor_id]
        full = node.cfg.full_scale_m
        h_over_d = float(extras.get("h_over_d", d["depth_mm"] / 1000.0 / full))
        state, wake, uplink, current = dsp.fsm_next(h_over_d, d["dh_dt_mm_min"], d["anom_code"],
                                                    bench_demo=bool(extras.get("bench_demo", True)))
        lora = dsp.lora_link(node.cfg.gateway_distance_m, node.cfg.obstruction_db, self.seq, node.rng)
        if rssi is not None:
            lora["rssi_dbm"] = float(rssi)
        if snr is not None:
            lora["snr_db"] = float(snr)
        kal = float(extras.get("kalman_filtered_depth_mm", d["depth_mm"]))
        sensor = dict(
            sensor_id=sensor_id, device_eui=meta["device_eui"], origin="HARDWARE",
            transport=extras.get("transport"), dist_mm=extras.get("dist_mm"),
            temperature_c=float(extras.get("temperature_c", 14.0)),
            raw_burst_mm=[float(x) for x in extras.get("raw_burst_mm", [])][:10],
            raw_unfiltered_depth_mm=float(extras.get("raw_unfiltered_depth_mm", d["depth_mm"])),
            median_depth_mm=float(extras.get("median_depth_mm", d["depth_mm"])),
            kalman_filtered_depth_mm=kal, true_depth_mm=kal,
            dh_dt_mm_min=float(extras.get("dh_dt_mm_min", d["dh_dt_mm_min"])),
            sigma_d2_mm2=float(extras.get("sigma_d2_mm2", 0.0)),
            turbulence_index=float(extras.get("turbulence_index", 0.0)),
            h_over_d=round(h_over_d, 4),
            flow_cms=extras.get("flow_cms"), velocity_ms=extras.get("velocity_ms"),
            froude_number=extras.get("froude_number"), specific_energy_m=extras.get("specific_energy_m"),
            capacity_pct=float(d["cap_pct"]), anomaly_class=d["anomaly_class"], anomaly_code=d["anom_code"],
            anomaly_scores={}, saturated_fields=list(extras.get("saturated_fields", [])),
            vbat_v=d["vbat_v"], payload_hex=dsp.payload_hex(word), payload_b64=dsp.payload_b64(word),
            payload_uint32=word, fsm_state=dsp.FSM_STATES[state], current_ua=current,
            next_wake_s=wake, uplink_interval_s=uplink, lora=lora,
        )
        if meta["hardware"] == "JETSON_YOLO_TRASHRACK":
            sensor["blockage_pct"] = float(d["cap_pct"])
        self.hardware[sensor_id] = HardwareUplink(sensor, time.monotonic(), scope)
        self.dirty = True
        return sensor

    def ingest_distance(self, sensor_id: str, dist_mm: float | None, fill_pct: float | None, tank_height_mm: float,
                        temperature_c: float, extras: dict, scope: str = "single_node") -> dict:
        """Raw HC-SR04 / A02YYUW reading (or a fill %) from a bench / aquarium rig over Wi-Fi or USB.

        The same bench-standpipe edge pipeline as the firmware runs here (100 % = 74 % of the
        sensor-to-floor height, x60 time compression), then the packed word is ingested like any
        uplink. Boards that already ran the pipeline should send `payload_hex` instead.
        """
        if dist_mm is None and fill_pct is None:
            raise ValueError("dist_mm, fill_pct or payload_hex required")
        tank = float(np.clip(tank_height_mm, 50.0, 3000.0))
        if dist_mm is None:
            dist_mm = tank - float(fill_pct) / 100.0 * BENCH_FULL_PCT_FRACTION * tank
        d = float(np.clip(dist_mm, 20.0, tank))
        now = time.monotonic()
        rig = self.distance_rigs.get(sensor_id)
        if rig is None or now - rig.last > DISTANCE_RIG_RESET_S:
            rig = DistanceRig(dsp.KalmanState(), [], now - 1.0)
            self.distance_rigs[sensor_id] = rig
        dt_min = max(now - rig.last, 1e-3) / 60.0
        rig.last = now
        rig.window = (rig.window + [d])[-dsp.BURST_LEN:]
        burst = [rig.window[0]] * (dsp.BURST_LEN - len(rig.window)) + rig.window
        node = self.nodes[sensor_id]
        cfg = dsp.EdgeNodeConfig(sensor_id, node.cfg.device_eui, node.cfg.hardware, node.cfg.full_scale_m, 0.0, None,
                                 node.cfg.gateway_distance_m, node.cfg.obstruction_db, node.cfg.vbat_v)
        res = dsp.run_cycle(cfg, rig.kalman, burst, temperature_c, dt_min, bench_demo=True, standpipe=True,
                            pipe_height_mm=tank)
        extras = dict(extras, temperature_c=temperature_c, raw_burst_mm=burst, h_over_d=res["h_over_d"],
                      raw_unfiltered_depth_mm=res["raw_depth_mm"], median_depth_mm=res["measured_depth_mm"],
                      kalman_filtered_depth_mm=res["depth_mm"], dh_dt_mm_min=res["dh_dt_mm_min"],
                      sigma_d2_mm2=res["sigma_d2"], turbulence_index=res["turbulence"],
                      saturated_fields=list(res["saturated"]))
        rec = self.ingest(sensor_id, res["payload"], extras, None, None, scope=scope)
        return dict(sensor=rec, fill_pct=round(res["cap_pct"], 1), dist_mm=round(res["d_med_mm"], 1),
                    anomaly_class=dsp.ANOMALY_NAMES[res["anomaly_code"]])

    # ------------------------------------------------------------------ drivers
    def _playback_period_s(self) -> float:
        return self.storms[self.storm_id]["duration_min"] / STORM_MIN_PER_WALL_S

    def _source_rain(self) -> tuple[float, float]:
        if self.mode == "PLAYBACK":
            period = self._playback_period_s()
            if self.storm_id == DESIGN_STORM_ID:
                return storm_profile(self.clock_s / period)
            return hyetograph_rate(self.storms[self.storm_id], self.clock_s * STORM_MIN_PER_WALL_S), self.fixed_clog
        if self.precip_source == "LIVE_FEED":
            snap = self.feed.snapshot()
            if snap.get("current_mm_hr") is not None:
                self.fixed_rain = float(np.clip(snap["current_mm_hr"], 0, 250))
        return self.fixed_rain, self.fixed_clog

    def _hardware_drive(self, hw: dict[str, dict], rain: float, clog: float, mode: str):
        override = None
        if "EN-09" in hw:
            clog = float(np.clip(hw["EN-09"]["blockage_pct"], 0, 95))
        hydraulic = [sid for sid in hw if self.sensors_meta[sid]["hardware"] != "JETSON_YOLO_TRASHRACK"]
        drivers = [sid for sid in hydraulic if self.hardware[sid].scope == "full_catchment"]
        if drivers:
            sid = drivers[0]
            rain = self.lut.invert_rain_for_sensor(sid, hw[sid]["capacity_pct"], clog)
            mode = "HARDWARE"
            override = dict(sensor_id=sid, age_s=round(time.monotonic() - self.hardware[sid].received, 1), scope="full_catchment")
        elif hydraulic:
            sid = hydraulic[0]
            override = dict(sensor_id=sid, age_s=round(time.monotonic() - self.hardware[sid].received, 1), scope="single_node")
        return rain, clog, mode, override

    def drive_preview(self) -> dict:
        """Cheap (no DSP / forecast) view of what the next frame's scenario will be."""
        rain, clog = self._source_rain()
        rain, clog, mode, override = self._hardware_drive(self._active_hardware(), rain, clog, self.mode)
        return dict(mode=mode, rainfall_mm_hr=round(rain, 2), trash_rack_blockage_pct=round(clog, 2),
                    scope=override["scope"] if override else None)

    def _active_hardware(self) -> dict[str, dict]:
        now = time.monotonic()
        for sid in [s for s, h in self.hardware.items() if now - h.received > HARDWARE_HOLD_S]:
            del self.hardware[sid]
        return {sid: h.sensor for sid, h in self.hardware.items()}

    def rain_trajectory(self, rain: float, mode: str) -> tuple[list[float], dict]:
        """Basin rainfall for minutes 0..60 of the forecast, and the source description."""
        if mode == "HARDWARE":
            return [rain] * (STEPS + 1), dict(kind="HARDWARE", label="Hardware-driven rainfall (persisted)")
        if mode == "PLAYBACK":
            storm = self.storms[self.storm_id]
            if self.storm_id == DESIGN_STORM_ID:
                period = self._playback_period_s()
                traj = [storm_profile(((self.clock_s + t / STORM_MIN_PER_WALL_S) % period) / period)[0] for t in range(STEPS + 1)]
            else:
                traj = hyetograph_trajectory(storm, self.clock_s * STORM_MIN_PER_WALL_S)
            return traj, dict(kind="HISTORICAL", label=storm["label"], storm_id=storm["id"],
                              storm_minute=round(self.clock_s * STORM_MIN_PER_WALL_S, 1))
        if self.precip_source == "LIVE_FEED":
            snap = self.feed.snapshot()
            traj = snap.get("trajectory_mm_hr")
            if traj:
                traj = [rain] + [float(x) for x in traj[1:STEPS + 1]]
                return traj, dict(kind="LIVE_FEED", label=f"{snap['provider']} live nowcast", provider=snap["provider"],
                                  status=snap["status"], observed_at=snap.get("observed_at"))
            return [rain] * (STEPS + 1), dict(kind="LIVE_FEED", label="Live feed offline (persisted)", status="OFFLINE")
        return [rain] * (STEPS + 1), dict(kind="TWIN", label="Twin scenario rainfall (persisted)")

    def _forecast(self, rain: float, clog: float, lag, sensors: dict, truth: dict, mode: str) -> dict:
        now = time.monotonic()
        key = (mode, self.precip_source, self.storm_id, tuple(sorted(self.hardware)), round(rain, 1), round(clog, 1))
        structural = self._fc_key is None or key[:4] != self._fc_key[:4]
        if self._fc is not None and not structural and (key == self._fc_key or now - self._fc_t < FORECAST_PERIOD_S):
            return self._fc
        traj, source = self.rain_trajectory(rain, mode)
        flows, vels, caps = self.lut.conduit_state(rain, clog)
        inp = ForecastInput(
            rain_mm_hr=traj, persist_rain_mm_hr=traj[-1], blockage_pct=clog, lagoon_depth_m=lag.depth_m,
            conduit_flow_cms=flows, conduit_velocity_ms=vels, conduit_capacity=caps,
            sensor_capacity_pct={sid: float(s["capacity_pct"]) for sid, s in sensors.items()},
            sensor_reference_pct={sid: float(t["capacity_pct"]) for sid, t in truth.items()},
            source=source,
        )
        fc = self.forecaster.forecast(inp)
        fc["generated_at"] = utc_now_iso()
        self._fc, self._fc_key, self._fc_t = fc, key, now
        return fc

    def forecast_now(self) -> dict:
        frame = self.latest or self.tick(0.0)
        return frame["forecast"]

    # ------------------------------------------------------------------ frame
    def tick(self, dt_wall_s: float) -> dict:
        self.seq += 1
        hw = self._active_hardware()
        if self.mode == "PLAYBACK":
            self.clock_s = (self.clock_s + dt_wall_s) % self._playback_period_s()
        rain, clog = self._source_rain()
        rain, clog, mode, override = self._hardware_drive(hw, rain, clog, self.mode)

        dt_min = dt_wall_s * STORM_MIN_PER_WALL_S
        truth = self.lut.sensor_truth(rain, clog)
        lag = self.lut.lagoon(rain, clog)
        sensors: dict[str, dict] = {}
        for k, (sid, node) in enumerate(self.nodes.items()):
            if sid in hw:
                sensors[sid] = hw[sid]
                continue
            temp = 13.5 + 1.2 * math.sin(self.seq / 40.0 + k)
            t = truth[sid]
            if node.cfg.hardware == "JETSON_YOLO_TRASHRACK":
                sensors[sid] = self._vision_frame(node, t, clog, lag.is_overflowing, temp)
            else:
                sensors[sid] = node.step(t["depth_mm"], t["turbulence"], temp, dt_min)

        vision = float(sensors["EN-09"].get("blockage_pct", clog)) if "EN-09" in sensors else clog
        fusion = arbitrate(sensors, vision, lag.is_overflowing, lag.bottleneck)
        forecast = self._forecast(rain, clog, lag, sensors, truth, mode)

        traj = forecast["rain_trajectory_mm_hr"]

        def basin_rain_at(lag_s: float) -> float:
            # FEWS stations sit up/down-wind: sample the trajectory lag_s storm-seconds ahead/behind.
            m = min(max(-lag_s * STORM_MIN_PER_WALL_S, 0.0), float(STEPS))   # wall-s -> storm-min
            return traj[int(round(m))]

        stations = self.fews.stations(basin_rain_at, self.rng)
        subs, basin = self.fews.subcatchments(stations)
        horizons = [dict(minutes=h["minutes"], rainfall_mm_hr=round(h["rainfall_mm_hr"], 1),
                         lagoon_depth_m=h["lagoon_depth_m"], surcharge_probability_pct=h["surcharge_probability_pct"],
                         time_to_overflow_min=h["time_to_overflow_min"], surcharged_conduits=h["conduits_over_capacity"])
                    for h in forecast["horizons"]]

        frame = dict(
            type="twin_frame", seq=self.seq, ts=utc_now_iso(), mode=mode,
            storm_clock_s=round(self.clock_s, 2),
            storm_period_s=round(self._playback_period_s(), 2) if self.mode == "PLAYBACK" else STORM_PERIOD_S,
            scenario=dict(rainfall_mm_hr=round(rain, 2), trash_rack_blockage_pct=round(clog, 2)),
            lagoon=dict(depth_m=round(lag.depth_m, 3), surface_elev_m=round(lag.surface_elev_m, 3),
                        time_to_overflow_min=None if lag.time_to_overflow_min is None else round(lag.time_to_overflow_min, 1),
                        bottleneck=lag.bottleneck, orifice_head_loss_m=round(lag.head_loss_m, 4)),
            sensors=sensors, fusion=fusion,
            nowcast=dict(generated_at=forecast["generated_at"], basin_rainfall_mm_hr=round(basin, 1), fews=stations,
                         subcatchments=subs, horizons=horizons),
            hardware_override=override,
            precip_source=self.precip_source, storm_id=self.storm_id, forecast=forecast,
        )
        self.latest = frame
        self.dirty = False
        return frame

    def _vision_frame(self, node: dsp.EdgeNode, truth: dict, clog: float, overflow: bool, temp: float) -> dict:
        """Jetson YOLOv8 trash-rack node: visual occlusion % (noisy) in cap_code, staff-gauge depth."""
        node.seq += 1
        p_hat = float(np.clip(clog + node.rng.gauss(0.0, 2.5), 0.0, 95.0))
        depth = max(truth["depth_mm"] + node.rng.gauss(0.0, 15.0), 0.0)
        code = 4 if overflow else (2 if p_hat >= JETSON_BLOCKAGE_THRESHOLD else 0)
        word = dsp.pack_payload(depth, 0.0, p_hat, code, node.cfg.vbat_v)
        state, wake, uplink, current = dsp.fsm_next(depth / 1000.0 / node.cfg.full_scale_m, 0.0, code)
        return dict(
            sensor_id=node.cfg.sensor_id, device_eui=node.cfg.device_eui, origin="VIRTUAL", temperature_c=round(temp, 2),
            raw_burst_mm=[], raw_unfiltered_depth_mm=round(depth, 1), median_depth_mm=round(depth, 1),
            kalman_filtered_depth_mm=round(depth, 1), true_depth_mm=round(truth["depth_mm"], 1), dh_dt_mm_min=0.0,
            sigma_d2_mm2=0.0, turbulence_index=0.0, h_over_d=round(depth / 1000.0 / node.cfg.full_scale_m, 4),
            flow_cms=None, velocity_ms=None, froude_number=None, specific_energy_m=None,
            capacity_pct=round(p_hat, 1), anomaly_class=dsp.ANOMALY_NAMES[code], anomaly_code=code,
            anomaly_scores={"TRASH_BLOCKAGE": round(p_hat / 100.0, 3)},
            saturated_fields=dsp.saturated_fields(depth, 0.0, p_hat), vbat_v=node.cfg.vbat_v,
            payload_hex=dsp.payload_hex(word), payload_b64=dsp.payload_b64(word), payload_uint32=word,
            fsm_state=dsp.FSM_STATES[state], current_ua=current, next_wake_s=wake, uplink_interval_s=uplink,
            lora=dsp.lora_link(node.cfg.gateway_distance_m, node.cfg.obstruction_db, node.seq, node.rng),
            blockage_pct=round(p_hat, 1),
        )
