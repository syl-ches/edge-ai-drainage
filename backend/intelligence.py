"""Multi-sensor fusion arbitration and FEWS rainfall fusion.

The +15/+30/+60 min forecaster lives in backend/stgnn.py (physics-informed ST-GNN).
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np

from .lut import DATA_DIR, TwinLut, haversine_m

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
    # Backwater at the intake: the flat-pool signature, or a pool already deeper than full scale
    # (the edge classifier ranks SURCHARGED above TRASH_BLOCKAGE, so deep ponding reads SURCHARGED).
    ponding = en08.get("anomaly_class") in ("TRASH_BLOCKAGE", "SURCHARGED")
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
# Station table shared with the forecaster and the frontend (public/data/precip_library.json;
# approximate synthetic sites, replace with CDRRMO / PAGASA metadata).
_LIBRARY = json.loads((DATA_DIR / "precip_library.json").read_text(encoding="utf-8"))
FEWS_STATIONS = tuple((s["station"], s["lon"], s["lat"], s["elevation_m"]) for s in _LIBRARY["fews_stations"])
OROGRAPHIC_LAPSE_PER_100M = _LIBRARY["orographic_lapse_per_100m"]   # +4 % rainfall per 100 m
FEWS_REFERENCE_ELEV_M = _LIBRARY["reference_elevation_m"]
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
            r = basin_rain_at(lag) * (1.0 + OROGRAPHIC_LAPSE_PER_100M * (elev - FEWS_REFERENCE_ELEV_M) / 100.0)
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


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
