"""Closed-loop twin runtime: virtual Edge-AI fleet + hardware ingestion + fusion + nowcast.

One `tick()` = one broadcast frame. In PLAYBACK mode the storm clock advances through the
typhoon profile; in SCENARIO mode rainfall/blockage are pinned; whenever a physical node has
uplinked in the last HARDWARE_HOLD_S seconds the twin is driven by that node (HARDWARE mode):
its measured capacity is inverted through the LUT to the rainfall that reproduces it.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass

import numpy as np

from . import edge_dsp as dsp
from .intelligence import STORM_PERIOD_S, FewsFusion, Nowcaster, arbitrate, storm_profile, utc_now_iso
from .lut import TwinLut, haversine_m

STORM_MIN_PER_WALL_S = 6.0           # 120 s playback loop == 12 h typhoon
HARDWARE_HOLD_S = 30.0
EN07_MAST_MM = 7300.0                # lagoon staff-gauge mast above the 1426.5 m invert
EN08_MAST_MM = 5900.0                # intake mast above the 1428.0 m rack sill
CROWN_MOUNT_CLEARANCE_MM = 300.0     # beyond A02YYUW range from the lid: bolt to the crown
LID_LOSS_DB = 18.0                   # cast-iron manhole lid
DEEP_SHAFT_LOSS_DB = 30.0            # crown-mounted sensor in a > 4.4 m shaft / rock tunnel
JETSON_BLOCKAGE_THRESHOLD = 50.0


@dataclass
class HardwareUplink:
    sensor: dict
    received: float


class TwinRuntime:
    def __init__(self, lut: TwinLut | None = None, seed: int = 20240917):
        self.lut = lut or TwinLut()
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.mode = "PLAYBACK"
        self.fixed_rain, self.fixed_clog = 25.0, 0.0
        self.clock_s = 0.0
        self.seq = 0
        self.hardware: dict[str, HardwareUplink] = {}
        self.fews = FewsFusion(self.lut)
        self.nowcaster = Nowcaster(self.lut)
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
        self.mode = mode
        if rain is not None:
            self.fixed_rain = float(np.clip(rain, 0, 250))
        if clog is not None:
            self.fixed_clog = float(np.clip(clog, 0, 95))
        if mode == "PLAYBACK":
            self.hardware.clear()

    def resolve_sensor(self, ident: str | None) -> str | None:
        if not ident:
            return None
        key = ident.strip()
        if key.upper() in self.eui_to_id:
            return self.eui_to_id[key.upper()]
        up = key.upper()
        return up if up in self.sensors_meta else None

    def ingest(self, sensor_id: str, word: int, extras: dict, rssi: float | None, snr: float | None) -> dict:
        """Accept a physical uplink (LoRaWAN webhook, Wi-Fi POST or USB serial bridge)."""
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
        self.hardware[sensor_id] = HardwareUplink(sensor, time.monotonic())
        self.dirty = True
        return sensor

    def drive_preview(self) -> dict:
        """Cheap (no DSP / nowcast) view of what the next frame's scenario will be."""
        hw = self._active_hardware()
        rain, clog = (storm_profile(self.clock_s / STORM_PERIOD_S) if self.mode == "PLAYBACK"
                      else (self.fixed_rain, self.fixed_clog))
        mode = self.mode
        if "EN-09" in hw:
            clog = float(np.clip(hw["EN-09"]["blockage_pct"], 0, 95))
        drivers = [sid for sid in hw if self.sensors_meta[sid]["hardware"] != "JETSON_YOLO_TRASHRACK"]
        if drivers:
            rain = self.lut.invert_rain_for_sensor(drivers[0], hw[drivers[0]]["capacity_pct"], clog)
            mode = "HARDWARE"
        return dict(mode=mode, rainfall_mm_hr=round(rain, 2), trash_rack_blockage_pct=round(clog, 2))

    def _active_hardware(self) -> dict[str, dict]:
        now = time.monotonic()
        for sid in [s for s, h in self.hardware.items() if now - h.received > HARDWARE_HOLD_S]:
            del self.hardware[sid]
        return {sid: h.sensor for sid, h in self.hardware.items()}

    # ------------------------------------------------------------------ frame
    def tick(self, dt_wall_s: float) -> dict:
        self.seq += 1
        hw = self._active_hardware()
        if self.mode == "PLAYBACK":
            self.clock_s = (self.clock_s + dt_wall_s) % STORM_PERIOD_S
            rain, clog = storm_profile(self.clock_s / STORM_PERIOD_S)
        else:
            rain, clog = self.fixed_rain, self.fixed_clog
        mode = self.mode
        override = None
        drivers = [sid for sid in hw if self.sensors_meta[sid]["hardware"] != "JETSON_YOLO_TRASHRACK"]
        if "EN-09" in hw:
            clog = float(np.clip(hw["EN-09"]["blockage_pct"], 0, 95))
        if drivers:
            sid = drivers[0]
            rain = self.lut.invert_rain_for_sensor(sid, hw[sid]["capacity_pct"], clog)
            mode = "HARDWARE"
            override = dict(sensor_id=sid, age_s=round(time.monotonic() - self.hardware[sid].received, 1))

        dt_min = dt_wall_s * STORM_MIN_PER_WALL_S
        storm_min = self.seq * dt_min
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

        def basin_rain_at(lag_s: float) -> float:
            if mode != "PLAYBACK":
                return rain
            return storm_profile(((self.clock_s - lag_s) % STORM_PERIOD_S) / STORM_PERIOD_S)[0]

        stations = self.fews.stations(basin_rain_at, self.rng)
        subs, basin = self.fews.subcatchments(stations)
        self.nowcaster.observe(storm_min, basin)
        horizons = self.nowcaster.forecast(clog, lag.depth_m, seed=self.seed + self.seq)

        frame = dict(
            type="twin_frame", seq=self.seq, ts=utc_now_iso(), mode=mode,
            storm_clock_s=round(self.clock_s, 2), storm_period_s=STORM_PERIOD_S,
            scenario=dict(rainfall_mm_hr=round(rain, 2), trash_rack_blockage_pct=round(clog, 2)),
            lagoon=dict(depth_m=round(lag.depth_m, 3), surface_elev_m=round(lag.surface_elev_m, 3),
                        time_to_overflow_min=None if lag.time_to_overflow_min is None else round(lag.time_to_overflow_min, 1),
                        bottleneck=lag.bottleneck, orifice_head_loss_m=round(lag.head_loss_m, 4)),
            sensors=sensors, fusion=fusion,
            nowcast=dict(generated_at=utc_now_iso(), basin_rainfall_mm_hr=round(basin, 1), fews=stations,
                         subcatchments=subs, horizons=horizons),
            hardware_override=override,
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
