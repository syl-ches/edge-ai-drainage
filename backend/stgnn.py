"""Physics-informed spatio-temporal graph forecaster (ST-GNN) for the City Camp catchment.

Honest scope: deterministic and physics-informed, with NO trained weights. It is a graph
neural network in structure (message passing over the drainage graph with learned-shape gates),
but every weight is derived from hydraulics, so it runs before any field telemetry exists and
is the scaffold trained weights would replace.

Graph (built once from public/data/city_camp_network.json + precip_library.json):
  * nodes = the 65 network nodes; edges = the 63 conduits (+ the rack link lagoon -> TUN-J00,
    which is integrated by the lagoon block, not by a gate).
  * spatial graph convolution: A_hydro[j, i] = g_c for conduit c: i -> j, with the temporal gate
    g_c = 1 - exp(-dt / tau_c), tau_c = L_c / c_c, kinematic celerity c_c = 5/3 * V_c,
    V_c = max(V_now, 0.25 * V_full) and V_full = Q_full / A_full from Manning on the steep-slope
    S = sin(atan(S0)). Each node aggregates its upstream messages plus local rational-method
    runoff C * i * f_FEWS * A / 360 (+ baseflow), where f_FEWS is the inverse-distance,
    orographic-lapse weight of the 4 FEWS gauges at that node (area-normalised).
  * node state W_c = in-transit storage of the conduit leaving each node (linear-reservoir
    cascade, exact exponential gate -> unconditionally stable at dt = 1 min), initialised at
    steady state from the live LUT/edge state and nudged by the 10 sensors (assimilation).
  * the 3 ha lagoon is integrated with 4th-order Runge-Kutta mass balance: graph inflow + direct
    rain - min(Q_rack(h, p), Q_choke) - rim spill - seepage, with the Kirschmer rack loss
    xi(p) = xi_clean (1 - p)^-2 solved inside Q_rack (same equations as the generator).
  * 9-member rainfall ensemble (fixed normal quantiles, spread growing with lead time) gives
    the 90 % bands and surcharge probabilities. Horizons +15 / +30 / +60 min; the lagoon is
    then integrated lagoon-only to 12 h for the time to overflow.

Mirrored line-for-line by src/forecast/stgnn.ts; tests/frontend/fixtures/stgnn_golden.json
locks the two together (scripts/gen_frontend_goldens.py).
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parents[1] / "public" / "data"

G = 9.80665
DT_S = 60.0
STEPS = 60
HORIZONS_MIN = (15, 30, 60)
OVERFLOW_HORIZON_MIN = 720
TAIL_DT_MIN = 5            # lagoon-only tail step; crossing time interpolated linearly
# Mirrors scripts/generate_citycamp_twin_data.py (checked by scripts/test_phase4_backend.py).
BASEFLOW_CMS_PER_HA = 0.0005
LAGOON_SEEPAGE_CMS = 0.01
SPILL_WEIR_COEFF = 1.70
SPILL_CREST_LENGTH_M = 60.0
RACK_TABLE_N = 721
RACK_TABLE_H_M = 9.0
# Graph / ensemble hyper-parameters (physics-derived, not trained).
CELERITY_FACTOR = 5.0 / 3.0
MIN_CELERITY_MS = 0.3
VFULL_FLOOR = 0.25
ENSEMBLE_Z = (-1.5932, -0.9674, -0.5895, -0.2822, 0.0, 0.2822, 0.5895, 0.9674, 1.5932)
CENTRAL = 4
SIGMA0 = 0.10
SIGMA_PER_HOUR = 0.30
ASSIM_MIN, ASSIM_MAX = 0.25, 4.0
CAP_MAX = 1.27
PCT_MAX = 127.0
ALARM_PCT = 80.0
SURCHARGE_PCT = 100.0
MODEL_NAME = "STGNN-PHYS-v1"


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def sigma_at(minute: float) -> float:
    return SIGMA0 + SIGMA_PER_HOUR * minute / 60.0


def percentile(sorted_vals: list[float], q: float) -> float:
    pos = q * (len(sorted_vals) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def fews_factors(nodes: list[dict], library: dict) -> list[float]:
    """Orographic-lapse inverse-distance weight of the 4 FEWS gauges at each node, normalised so
    the runoff-area-weighted basin mean is 1 (the basin rainfall stays the catchment mean)."""
    lapse = library["orographic_lapse_per_100m"]
    zref = library["reference_elevation_m"]
    power = library["idw_power"]
    out = []
    for n in nodes:
        num = den = 0.0
        for s in library["fews_stations"]:
            d = max(haversine_m((n["coordinates"][0], n["coordinates"][1]), (s["lon"], s["lat"])), 100.0)
            w = 1.0 / d ** power
            station = 1.0 + lapse * (s["elevation_m"] - zref) / 100.0
            local = 1.0 + lapse * (n["rim_elev_m"] - s["elevation_m"]) / 100.0
            num += w * station * local
            den += w
        out.append(num / den)
    area = sum(n["catchment_area_ha"] for n in nodes if n["type"] != "STORAGE")
    mean = sum(f * n["catchment_area_ha"] for f, n in zip(out, nodes) if n["type"] != "STORAGE") / area
    return [f / mean for f in out]


def station_rain(library: dict, basin_mm_hr: float) -> list[dict]:
    lapse = library["orographic_lapse_per_100m"]
    zref = library["reference_elevation_m"]
    return [dict(station=s["station"], elevation_m=s["elevation_m"],
                 factor=round(1.0 + lapse * (s["elevation_m"] - zref) / 100.0, 4),
                 rainfall_mm_hr=round(max(basin_mm_hr, 0.0) * (1.0 + lapse * (s["elevation_m"] - zref) / 100.0), 2))
            for s in library["fews_stations"]]


@dataclass
class ForecastInput:
    rain_mm_hr: list[float]                 # basin rainfall at minutes 0..60 (61 values)
    persist_rain_mm_hr: float               # assumed after +60 min (time-to-overflow tail)
    blockage_pct: float
    lagoon_depth_m: float
    conduit_flow_cms: list[float]           # network conduit order (active)
    conduit_velocity_ms: list[float]
    conduit_capacity: list[float]           # capacity_ratio
    sensor_capacity_pct: dict[str, float]   # current measured fullness per sensor (edge / hardware)
    sensor_reference_pct: dict[str, float]  # what the LUT state expects at that sensor right now
    source: dict = field(default_factory=dict)


class STGNNForecaster:
    def __init__(self, network: dict | None = None, library: dict | None = None, tunnel_limit_cms: float | None = None):
        network = network or json.loads((DATA_DIR / "city_camp_network.json").read_text(encoding="utf-8"))
        library = library or json.loads((DATA_DIR / "precip_library.json").read_text(encoding="utf-8"))
        if tunnel_limit_cms is None:
            lut = json.loads((DATA_DIR / "simulation_lut.json").read_text(encoding="utf-8"))
            tunnel_limit_cms = float(lut["meta"]["tunnel_conveyance_limit_cms"])
        self.network, self.library = network, library
        self.q_choke = float(tunnel_limit_cms)
        self.nodes = [n for n in network["nodes"] if n["is_active"]]
        self.conduits = [c for c in network["conduits"] if c["is_active"]]
        self.sensors = [s for s in network["sensors"] if s["is_active"]]
        nid = {n["id"]: i for i, n in enumerate(self.nodes)}
        self.n_nodes, self.n_cond = len(self.nodes), len(self.conduits)
        self.from_idx = np.array([nid[c["from_node"]] for c in self.conduits])
        self.to_idx = np.array([nid[c["to_node"]] for c in self.conduits])
        self.length = np.array([c["length_m"] for c in self.conduits], float)
        self.q_full = np.array([c["q_full_cms"] for c in self.conduits], float)
        self.v_full = np.array([c["q_full_cms"] / c["geometry"]["area_full_m2"] for c in self.conduits], float)
        self.slope_sin = np.array([c["slope_eff_sin"] for c in self.conduits], float)
        self.cid = {c["id"]: k for k, c in enumerate(self.conduits)}
        lag = network["lagoon"]
        self.lagoon_idx = nid[lag["node_id"]]
        rack = network["orifices"][0]
        self.rack = rack
        # exact bar geometry (the JSON's xi_clean / bar_open_ratio are rounded to 4 dp)
        t, b = rack["bar_thickness_m"], rack["bar_clear_spacing_m"]
        self.rack_open = b / (b + t)
        self.xi_clean = rack["kirschmer_beta"] * (t / b) ** (4.0 / 3.0) * math.sin(math.radians(rack["bar_angle_deg"]))
        self.intake_idx = nid[rack["to_node"]]
        self.lag_area, self.lag_bottom = lag["area_m2"], lag["bottom_area_m2"]
        self.lag_max, self.lag_pool, self.lag_invert = lag["max_depth_m"], lag["permanent_pool_depth_m"], lag["invert_elev_m"]
        self.frustum_a = (self.lag_area - self.lag_bottom) / (2.0 * self.lag_max)
        self.full_volume = self.lag_bottom * self.lag_max + self.frustum_a * self.lag_max ** 2
        self.f_fews = fews_factors(self.nodes, library)
        runoff = np.array([0.0 if n["type"] == "STORAGE" else n["runoff_coeff"] * n["catchment_area_ha"] * f / 360.0
                           for n, f in zip(self.nodes, self.f_fews)])
        base = np.array([0.0 if n["type"] == "STORAGE" else BASEFLOW_CMS_PER_HA * n["catchment_area_ha"] for n in self.nodes])
        self.runoff_per_mmhr, self.baseflow = runoff, base
        self.to_onehot = np.zeros((self.n_cond, self.n_nodes))
        self.to_onehot[np.arange(self.n_cond), self.to_idx] = 1.0
        # upstream conduit subtree of each conduit (incl. itself) and contributing area
        incoming: dict[int, list[int]] = {}
        for k in range(self.n_cond):
            incoming.setdefault(int(self.to_idx[k]), []).append(k)
        self.subtree: list[list[int]] = []
        for k in range(self.n_cond):
            seen, stack = [], [k]
            while stack:
                c = stack.pop()
                seen.append(c)
                stack.extend(incoming.get(int(self.from_idx[c]), []))
            self.subtree.append(sorted(seen))
        self.upstream_area_ha = np.array([sum(self.nodes[int(self.from_idx[c])]["catchment_area_ha"] for c in sub)
                                          for sub in self.subtree])
        self._rack_cache: dict[float, np.ndarray] = {}
        self.rack_h = np.array([k * RACK_TABLE_H_M / (RACK_TABLE_N - 1) for k in range(RACK_TABLE_N)])

    # ------------------------------------------------------------------ hydraulics (generator)
    def _rack_direct(self, h: np.ndarray, p: float) -> np.ndarray:
        """Weir below the soffit, orifice above, blended over 0.2 H (generator::_rack_direct)."""
        r = self.rack
        hp = np.maximum(h, 0.0)
        b_eff = r["width_m"] * self.rack_open * (1.0 - p)
        weir = (2.0 / 3.0) * r["discharge_coeff"] * math.sqrt(2.0 * G) * b_eff * hp ** 1.5
        orifice = r["discharge_coeff"] * b_eff * r["height_m"] * np.sqrt(2.0 * G * np.maximum(hp - r["height_m"] / 2.0, 0.0))
        w = np.minimum((hp - r["height_m"]) / (0.2 * r["height_m"]), 1.0)
        return np.where(h <= 0.0, 0.0, np.where(hp <= r["height_m"], weir, (1.0 - w) * weir + w * orifice))

    def rack_table(self, p: float) -> np.ndarray:
        """Q_rack(h) on a 721-point stage grid: Q = Q_direct(h - xi(p) V^2 / 2g) solved by
        60-step bisection (generator::rack_flow), with xi(p) = xi_clean (1 - p)^-2."""
        key = math.floor(p * 200.0 + 0.5) / 200.0
        if key not in self._rack_cache:
            hs = self.rack_h
            xi = self.xi_clean / (1.0 - key) ** 2
            hi = self._rack_direct(hs, key)
            lo = np.zeros_like(hs)
            wet = hs > 0.0
            width = self.rack["width_m"] * np.minimum(np.where(wet, hs, 1.0), self.rack["height_m"])
            for _ in range(60):
                mid = 0.5 * (lo + hi)
                v_app = mid / width
                resid = mid - self._rack_direct(hs - xi * v_app * v_app / (2.0 * G), key)
                hi = np.where(resid > 0.0, mid, hi)
                lo = np.where(resid > 0.0, lo, mid)
            self._rack_cache[key] = np.where(wet, 0.5 * (lo + hi), 0.0)
        return self._rack_cache[key]

    def lagoon_volume(self, h):
        h = np.asarray(h, float)
        return np.where(h <= self.lag_max, self.lag_bottom * h + self.frustum_a * h * h,
                        self.full_volume + self.lag_area * (h - self.lag_max))

    def lagoon_depth(self, v):
        v = np.maximum(np.asarray(v, float), 0.0)
        b = self.lag_bottom
        below = (-b + np.sqrt(b * b + 4.0 * self.frustum_a * v)) / (2.0 * self.frustum_a)
        return np.where(v <= self.full_volume, below, self.lag_max + (v - self.full_volume) / self.lag_area)

    def lagoon_area(self, h):
        h = np.asarray(h, float)
        return np.where(h >= self.lag_max, self.lag_area,
                        self.lag_bottom + (self.lag_area - self.lag_bottom) * np.maximum(h, 0.0) / self.lag_max)

    def _lagoon_rate(self, vol, q_in_graph, rain, table, q_choke):
        h = self.lagoon_depth(vol)
        hs = h - self.lag_pool
        q_rack = np.where(hs > 0.0, np.interp(hs, self.rack_h, table), 0.0)
        q_out = np.minimum(q_rack, q_choke)
        spill = np.where(h > self.lag_max, SPILL_WEIR_COEFF * SPILL_CREST_LENGTH_M * np.maximum(h - self.lag_max, 0.0) ** 1.5, 0.0)
        seep = np.where(vol > 0.0, LAGOON_SEEPAGE_CMS, 0.0)
        direct = rain * self.f_fews[self.lagoon_idx] * self.lagoon_area(h) / 3.6e6
        return q_in_graph + direct - q_out - spill - seep, q_out

    def _rk4(self, vol, q_in_graph, rain, table, q_choke, dt=DT_S):
        k1, q1 = self._lagoon_rate(vol, q_in_graph, rain, table, q_choke)
        k2, q2 = self._lagoon_rate(vol + 0.5 * dt * k1, q_in_graph, rain, table, q_choke)
        k3, q3 = self._lagoon_rate(vol + 0.5 * dt * k2, q_in_graph, rain, table, q_choke)
        k4, q4 = self._lagoon_rate(vol + dt * k3, q_in_graph, rain, table, q_choke)
        vol = np.maximum(vol + dt / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4), 0.0)
        return vol, (q1 + 2.0 * q2 + 2.0 * q3 + q4) / 6.0

    def adjacency(self, velocity_ms: list[float]) -> np.ndarray:
        """Dense A_hydro (65 x 65): A[j, i] = temporal gate of conduit i -> j at dt = 1 min."""
        g = self._gates(np.asarray(velocity_ms, float))
        a = np.zeros((self.n_nodes, self.n_nodes))
        a[self.to_idx, self.from_idx] = g
        return a

    def _gates(self, v_now: np.ndarray) -> np.ndarray:
        cel = np.maximum(CELERITY_FACTOR * np.maximum(v_now, VFULL_FLOOR * self.v_full), MIN_CELERITY_MS)
        return 1.0 - np.exp(-DT_S * cel / self.length)

    # ------------------------------------------------------------------ forecast
    def forecast(self, inp: ForecastInput) -> dict:
        assert len(inp.rain_mm_hr) == STEPS + 1
        p = min(max(inp.blockage_pct, 0.0), 95.0) / 100.0
        table = self.rack_table(p)               # p quantised to 0.5 % inside
        q_choke = self.q_choke
        q_now = np.asarray(inp.conduit_flow_cms, float)
        cap_now = np.asarray(inp.conduit_capacity, float)
        g = self._gates(np.asarray(inp.conduit_velocity_ms, float))

        # assimilation: a persistent measured / expected fullness ratio means the sensor's upstream
        # subtree delivers more (or less) runoff than the LUT assumes; scale its in-transit storage
        # and its nodes' runoff by that ratio (largest subtrees first: the most local sensor wins).
        mult = np.ones(self.n_cond)
        node_mult = np.ones(self.n_nodes)
        cond_sensors = [s for s in self.sensors if s["attached_kind"] == "CONDUIT" and s["attached_to"] in self.cid]
        for s in sorted(cond_sensors, key=lambda s: -len(self.subtree[self.cid[s["attached_to"]]])):
            k = self.cid[s["attached_to"]]
            measured = inp.sensor_capacity_pct.get(s["sensor_id"])
            expected = inp.sensor_reference_pct.get(s["sensor_id"])
            if measured is None or expected is None or expected <= 1.0:
                continue
            ratio = min(max(measured / expected, ASSIM_MIN), ASSIM_MAX)
            mult[self.subtree[k]] = ratio
            node_mult[self.from_idx[self.subtree[k]]] = ratio
        runoff = self.runoff_per_mmhr * node_mult
        baseflow = self.baseflow * node_mult

        zs = np.array(ENSEMBLE_Z)
        m = len(zs)
        w = np.tile(q_now * mult * DT_S / g, (m, 1))                              # (M, C) steady state
        vol = np.full(m, float(self.lagoon_volume(inp.lagoon_depth_m)))
        depth_series = np.empty((m, STEPS + 1))
        flow_series = np.empty((m, STEPS + 1, self.n_cond))
        depth_series[:, 0] = self.lagoon_depth(vol)
        flow_series[:, 0, :] = w * g / DT_S
        q_in_lagoon = np.zeros(m)
        for t in range(STEPS):
            rain = inp.rain_mm_hr[t] * np.exp(zs * sigma_at(t))                     # (M,)
            out = w * g / DT_S
            inflow = rain[:, None] * runoff[None, :] + baseflow[None, :] + out @ self.to_onehot
            q_in_lagoon = inflow[:, self.lagoon_idx]
            vol, q_rack = self._rk4(vol, q_in_lagoon, rain, table, q_choke)
            inflow[:, self.intake_idx] += q_rack                                    # rack-link message
            w = w + DT_S * (inflow[:, self.from_idx] - out)
            depth_series[:, t + 1] = self.lagoon_depth(vol)
            flow_series[:, t + 1, :] = w * g / DT_S

        # lagoon-only tail to 12 h (rain persists, graph inflow frozen at +60 min)
        overflow_min = np.full(m, np.nan)
        for k in range(m):
            hit = np.nonzero(depth_series[k] >= self.lag_max)[0]
            if hit.size:
                overflow_min[k] = float(hit[0])
        tail_rain = inp.persist_rain_mm_hr * np.exp(zs * sigma_at(STEPS))
        tail_q = q_in_lagoon.copy()
        t = STEPS
        # With constant forcing the bowl relaxes monotonically toward the stage where inflow equals
        # outflow, so a member can only overflow if it is still rising AND would still be rising
        # with the bowl brim-full; everything else is skipped (identical result, ~20x faster).
        full_rate, _ = self._lagoon_rate(np.full(m, self.full_volume), tail_q, tail_rain, table, q_choke)
        while t < OVERFLOW_HORIZON_MIN and np.isnan(overflow_min).any():
            rate, _ = self._lagoon_rate(vol, tail_q, tail_rain, table, q_choke)
            if not np.any(np.isnan(overflow_min) & (rate > 0.0) & (full_rate > 0.0)):
                break
            h_prev = self.lagoon_depth(vol)
            vol, _ = self._rk4(vol, tail_q, tail_rain, table, q_choke, TAIL_DT_MIN * DT_S)
            h = self.lagoon_depth(vol)
            newly = np.isnan(overflow_min) & (h >= self.lag_max)
            frac = (self.lag_max - h_prev) / np.maximum(h - h_prev, 1e-12)
            overflow_min = np.where(newly, t + TAIL_DT_MIN * np.clip(frac, 0.0, 1.0), overflow_min)
            t += TAIL_DT_MIN

        # conduit capacity and sensor fullness per member / minute
        cap_series = np.clip(cap_now[None, None, :] + (flow_series - q_now[None, None, :]) / self.q_full[None, None, :], 0.0, CAP_MAX)
        sensor_ids = [s["sensor_id"] for s in self.sensors]
        sensor_series: dict[str, np.ndarray] = {}
        for s in self.sensors:
            sid = s["sensor_id"]
            now = float(inp.sensor_capacity_pct.get(sid, 0.0))
            if s["hardware"] == "JETSON_YOLO_TRASHRACK":
                series = np.full((m, STEPS + 1), now)
            elif s["attached_kind"] == "CONDUIT" and s["attached_to"] in self.cid:
                k = self.cid[s["attached_to"]]
                series = now + 100.0 * (cap_series[:, :, k] - cap_series[:, :1, k])
            elif s["attached_kind"] == "STORAGE":
                series = now + 100.0 * (depth_series - depth_series[:, :1]) / self.lag_max
            else:
                series = now + 100.0 * (depth_series - depth_series[:, :1]) / self.rack["height_m"]
            sensor_series[sid] = np.clip(series, 0.0, PCT_MAX)
        hydraulic = [s["sensor_id"] for s in self.sensors if s["hardware"] != "JETSON_YOLO_TRASHRACK"]

        t_ovf = overflow_min[CENTRAL]
        horizons = []
        for hzn in HORIZONS_MIN:
            d = depth_series[:, hzn]
            ds = sorted(float(x) for x in d)
            sensors = {}
            for sid in sensor_ids:
                v = sensor_series[sid][:, hzn]
                vs = sorted(float(x) for x in v)
                sensors[sid] = dict(capacity_pct=round(float(v[CENTRAL]), 1), p05=round(percentile(vs, 0.05), 1),
                                    p95=round(percentile(vs, 0.95), 1),
                                    surcharge_probability_pct=round(100.0 * float(np.mean(v >= SURCHARGE_PCT)), 1))
            any_sur = np.zeros(m, bool)
            for sid in hydraulic:
                any_sur |= sensor_series[sid][:, hzn] >= SURCHARGE_PCT
            any_sur |= d >= self.lag_max
            crit = max(hydraulic, key=lambda sid: (float(sensor_series[sid][CENTRAL, hzn]), -hydraulic.index(sid)))
            hit = np.nonzero(sensor_series[crit][CENTRAL, :] >= ALARM_PCT)[0]
            horizons.append(dict(
                minutes=hzn,
                rainfall_mm_hr=round(float(inp.rain_mm_hr[hzn]), 2),
                lagoon_depth_m=round(float(d[CENTRAL]), 3),
                lagoon_depth_p05_m=round(percentile(ds, 0.05), 3),
                lagoon_depth_p95_m=round(percentile(ds, 0.95), 3),
                surface_elev_m=round(self.lag_invert + float(d[CENTRAL]), 3),
                surface_elev_p05_m=round(self.lag_invert + percentile(ds, 0.05), 3),
                surface_elev_p95_m=round(self.lag_invert + percentile(ds, 0.95), 3),
                time_to_overflow_min=None if math.isnan(t_ovf) else round(max(t_ovf - hzn, 0.0), 1),
                surcharge_probability_pct=round(100.0 * float(any_sur.mean()), 1),
                conduits_over_capacity=int((cap_series[CENTRAL, hzn, :] >= 1.0).sum()),
                next_bottleneck=dict(sensor_id=crit, capacity_pct=round(float(sensor_series[crit][CENTRAL, hzn]), 1),
                                     minutes_to_critical=None if hit.size == 0 else int(hit[0])),
                sensors=sensors,
            ))
        return dict(
            model=MODEL_NAME, step_min=1, members=m,
            graph=dict(nodes=self.n_nodes, edges=self.n_cond),
            source=inp.source,
            rain_trajectory_mm_hr=[round(float(x), 2) for x in inp.rain_mm_hr],
            time_to_overflow_min=None if math.isnan(t_ovf) else round(float(t_ovf), 1),
            horizons=horizons,
        )
