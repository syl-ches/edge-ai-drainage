"""Multi-sensor fusion arbitration, FEWS rainfall fusion and the graph-propagated nowcaster.

Honest scope note: the "ST-GNN" here is a physics-weighted spatio-temporal message-passing
model over the 63-conduit DAG (rainfall trend extrapolation -> per-conduit concentration-time
lag -> LUT hydraulics -> ensemble surcharge probability -> downstream-to-upstream backwater
risk propagation). It has no trained weights; it is the scaffold a trained ST-GNN would slot
into once field telemetry exists.
"""
from __future__ import annotations

import math
from collections import deque
from datetime import datetime, timezone

import numpy as np

from .lut import TwinLut, haversine_m

STORM_PERIOD_S = 120.0
VISION_CONFIRM_PCT = 35.0
CHOKE_ELEVATED_PCT = 50.0


def _smooth(a: float, b: float, x: float) -> float:
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def storm_profile(t: float) -> tuple[float, float]:
    """Typhoon build-up / peak / recession over one period, t in [0, 1).
    Identical to src/live/telemetry.ts::stormProfile."""
    rain = 2.0 + 238.0 * math.exp(-(((t - 0.42) / 0.17) ** 2))
    clog = 6.0 + 82.0 * _smooth(0.2, 0.62, t) - 30.0 * _smooth(0.78, 0.98, t)
    return min(rain, 250.0), min(max(clog, 0.0), 95.0)


# =============================================================================
# Multi-sensor fusion arbitrator (EN-08 ultrasonic x EN-09 YOLOv8 x EN-10 choke)
# =============================================================================
def arbitrate(sensors: dict[str, dict], vision_blockage_pct: float, lagoon_overflowing: bool,
              bottleneck: str) -> dict:
    en08, en10 = sensors.get("EN-08", {}), sensors.get("EN-10", {})
    ponding = en08.get("anomaly_class") == "TRASH_BLOCKAGE"
    choke_cap = float(en10.get("capacity_pct", 0.0))
    evidence = [
        f"EN-08 ultrasonic: {en08.get('anomaly_class', '—')} (h/D {en08.get('h_over_d', 0):.2f}, "
        f"σ̃² {en08.get('turbulence_index', 0):.2f})",
        f"EN-09 YOLOv8 vision: {vision_blockage_pct:.0f} % occluded",
        f"EN-10 choke transition: {en10.get('anomaly_class', '—')} ({choke_cap:.0f} % capacity)",
        f"Governing bottleneck: {bottleneck}",
    ]
    if lagoon_overflowing:
        return dict(root_cause="INTAKE_SURCHARGE_OVERFLOW", severity="CRITICAL",
                    action="Lagoon above 1433.0 m rim — activate CDRRMO evacuation advisory for City Camp Proper/Central.",
                    confidence=0.97, evidence=evidence, suppressed_false_alarm=False)
    if ponding and vision_blockage_pct >= VISION_CONFIRM_PCT:
        return dict(root_cause="CONFIRMED_TRASH_RACK_OCCLUSION", severity="CRITICAL",
                    action="Dispatch CEO manual clearing crew to the City Camp Lagoon tunnel intake trash rack.",
                    confidence=round(min(0.6 + vision_blockage_pct / 250.0, 0.98), 2), evidence=evidence,
                    suppressed_false_alarm=False)
    if ponding and choke_cap >= CHOKE_ELEVATED_PCT:
        return dict(root_cause="DOWNSTREAM_ROCK_CHOKE_BACKWATER", severity="WARNING",
                    action="Trash rack is clear — hydraulic bottleneck is inside the 1.5 m × 1.7 m unlined bedrock "
                           "tunnel section. Do not dispatch the rack crew.",
                    confidence=0.86, evidence=evidence, suppressed_false_alarm=True)
    if vision_blockage_pct >= VISION_CONFIRM_PCT:
        return dict(root_cause="DEBRIS_ACCUMULATING_NO_BACKWATER", severity="INFO",
                    action="Debris building on the rack; no hydraulic backwater yet. Schedule clearing before the next rain band.",
                    confidence=0.7, evidence=evidence, suppressed_false_alarm=False)
    return dict(root_cause="NOMINAL", severity="INFO", action="All intake sensors consistent. No action.",
                confidence=0.9, evidence=evidence, suppressed_false_alarm=False)


# =============================================================================
# FEWS station fusion
# =============================================================================
# Approximate (synthetic) station sites bounding the basin; replace with CDRRMO/PAGASA metadata.
FEWS_STATIONS = (
    ("FEWS City Camp Lagoon", 120.5863, 16.4093, 1433.0),
    ("FEWS Ferguson Road", 120.5935, 16.4185, 1480.0),
    ("FEWS Irisan", 120.5590, 16.4220, 1390.0),
    ("FEWS Brookspoint", 120.6010, 16.4070, 1500.0),
)
OROGRAPHIC_LAPSE_PER_100M = 0.04      # +4 % rainfall per 100 m of elevation
SUBCATCHMENT_OF_CORRIDOR = {
    "URQ": "Rock Quarry", "MRQ": "Rock Quarry", "QOP": "Rock Quarry", "LRQ": "Rock Quarry",
    "LEF": "Lourdes Extension", "DHR": "Lourdes Extension",
    "LGD": "Legarda/Kisad", "KSD": "Legarda/Kisad", "GSF": "Legarda/Kisad", "CCC": "Legarda/Kisad",
    "CCP": "City Camp Proper",
}
# Storm cells track in from the ENE: stations further downwind see the rain later (storm-clock s).
WIND_FROM_DEG = 67.5


class FewsFusion:
    def __init__(self, lut: TwinLut):
        groups: dict[str, list] = {}
        for n in lut.network["nodes"]:
            code = n["id"].split("-")[0]
            sub = SUBCATCHMENT_OF_CORRIDOR.get(code)
            if sub and n["catchment_area_ha"] > 0:
                groups.setdefault(sub, []).append(n)
        self.subs = {}
        for name, nodes in groups.items():
            area = sum(x["catchment_area_ha"] for x in nodes)
            lon = sum(x["coordinates"][0] * x["catchment_area_ha"] for x in nodes) / area
            lat = sum(x["coordinates"][1] * x["catchment_area_ha"] for x in nodes) / area
            elev = sum(x["rim_elev_m"] * x["catchment_area_ha"] for x in nodes) / area
            self.subs[name] = dict(lon=lon, lat=lat, elev=elev, area=area)
        wx, wy = math.sin(math.radians(WIND_FROM_DEG)), math.cos(math.radians(WIND_FROM_DEG))
        lon0, lat0 = FEWS_STATIONS[0][1], FEWS_STATIONS[0][2]
        self.lags = []
        for _, lon, lat, _ in FEWS_STATIONS:
            dx = (lon - lon0) * 106_760.0
            dy = (lat - lat0) * 110_600.0
            self.lags.append(-(dx * wx + dy * wy) / 1000.0 * 1.5)   # 1.5 storm-s per km upwind

    def stations(self, basin_rain_at, rng: np.random.Generator) -> list[dict]:
        out = []
        for (name, _, _, elev), lag in zip(FEWS_STATIONS, self.lags):
            r = basin_rain_at(lag) * (1.0 + OROGRAPHIC_LAPSE_PER_100M * (elev - 1433.0) / 100.0)
            r *= float(np.exp(rng.normal(0.0, 0.04)))
            out.append(dict(station=name, elevation_m=elev, rainfall_mm_hr=round(max(r, 0.0), 1)))
        return out

    def subcatchments(self, stations: list[dict]) -> tuple[dict[str, float], float]:
        res, tot, wsum = {}, 0.0, 0.0
        for name, s in self.subs.items():
            num = den = 0.0
            for st, (_, lon, lat, elev) in zip(stations, FEWS_STATIONS):
                d = max(haversine_m((lon, lat), (s["lon"], s["lat"])), 100.0)
                w = 1.0 / (d * d)
                corr = 1.0 + OROGRAPHIC_LAPSE_PER_100M * (s["elev"] - elev) / 100.0
                num += w * st["rainfall_mm_hr"] * corr
                den += w
            res[name] = round(num / den, 1)
            tot += res[name] * s["area"]
            wsum += s["area"]
        return res, tot / wsum


# =============================================================================
# Graph-propagated nowcaster (+15 / +30 / +60 min)
# =============================================================================
class Nowcaster:
    HORIZONS_MIN = (15, 30, 60)
    ENSEMBLE = 31
    LAGOON_TAU_MIN = 45.0
    BACKWATER_GAMMA = 0.6

    def __init__(self, lut: TwinLut):
        self.lut = lut
        self.history: deque[tuple[float, float]] = deque(maxlen=24)
        conduits = [c for c in lut.network["conduits"] if c["is_active"]]
        self.tc = np.array([c["tc_min"] for c in conduits])
        idx = {c["id"]: i for i, c in enumerate(conduits)}
        by_from = {c["from_node"]: idx[c["id"]] for c in conduits}
        # downstream neighbour of each conduit (-1 at storage / outfall)
        self.down = np.array([by_from.get(c["to_node"], -1) for c in conduits])
        # topological order downstream-first for backwater message passing
        depth = np.zeros(len(conduits), int)
        for i in range(len(conduits)):
            j, d = i, 0
            while self.down[j] >= 0 and d < 100:
                j, d = self.down[j], d + 1
            depth[i] = d
        self.order = np.argsort(depth)

    def observe(self, storm_min: float, basin_rain: float) -> None:
        self.history.append((storm_min, basin_rain))

    def _trend(self) -> tuple[float, float]:
        if len(self.history) < 3:
            r = self.history[-1][1] if self.history else 0.0
            return r, 0.0
        t = np.array([h[0] for h in self.history])
        r = np.array([h[1] for h in self.history])
        if np.ptp(t) < 1e-6:
            return float(r[-1]), 0.0
        slope = float(np.polyfit(t - t[-1], r, 1)[0])
        return float(r[-1]), slope

    def forecast(self, clog: float, lagoon_depth_now: float, seed: int) -> list[dict]:
        r_now, slope = self._trend()
        rng = np.random.default_rng(seed)
        out = []
        for h in self.HORIZONS_MIN:
            # damped trend extrapolation, then lag each conduit by its concentration time
            lead = np.maximum(h - self.tc, 0.0)
            r_eff = np.clip(r_now + slope * lead * np.exp(-lead / 120.0), 0.0, 250.0)
            mult = np.exp(rng.normal(0.0, 0.12 * math.sqrt(h / 15.0), self.ENSEMBLE))
            rains = np.clip(mult[:, None] * r_eff[None, :], 0.0, 250.0)          # (M, C)
            m, c = rains.shape
            # Surcharge == pressurized (the LUT status rule); capacity > 1 alone is not enough
            # because Q_full < Q < Q_max is still free-surface flow (e.g. the rock choke).
            press = self.lut.conduit_pressurized(rains.ravel(), np.full(m * c, clog))  # (M*C, C)
            own = press[np.arange(m * c), np.tile(np.arange(c), m)].reshape(m, c)
            surch = own >= 0.5
            p_c = surch.mean(axis=0)
            for i in self.order:                                                   # downstream first
                d = self.down[i]
                if d >= 0:
                    p_c[i] = max(p_c[i], self.BACKWATER_GAMMA * p_c[d])
            r_basin = float(np.clip(r_now + slope * h * math.exp(-h / 120.0), 0.0, 250.0))
            lag = self.lut.lagoon(r_basin, clog)
            depth = lag.depth_m + (lagoon_depth_now - lag.depth_m) * math.exp(-h / self.LAGOON_TAU_MIN)
            p_any = float(surch.any(axis=1).mean())
            if depth > self.lut.max_depth:
                p_any = max(p_any, 0.99)
            out.append(dict(minutes=h, rainfall_mm_hr=round(r_basin, 1), lagoon_depth_m=round(depth, 3),
                            surcharge_probability_pct=round(100.0 * p_any, 1),
                            time_to_overflow_min=0.0 if depth > self.lut.max_depth else (
                                None if lag.time_to_overflow_min is None else round(lag.time_to_overflow_min, 1)),
                            surcharged_conduits=int(round(float(surch.sum(axis=1).mean())))))
        return out


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
