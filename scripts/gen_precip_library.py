#!/usr/bin/env python3
"""Writes public/data/precip_library.json: the FEWS gauge table and the historical Baguio
storm hyetograph library shared by the backend ST-GNN forecaster and the frontend fallback.

Deterministic (no RNG, no network). The storms are SYNTHETIC DESIGN HYETOGRAPHS shaped after
each event's reported character (duration, banding, peak timing) for demonstration. They are
not PAGASA / FEWS gauge records. Replace `rate_mm_hr` with digitised gauge data when available.

    python scripts/gen_precip_library.py
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data" / "precip_library.json"
STEP_MIN = 10


def gauss(t: float, mu: float, sd: float, amp: float) -> float:
    return amp * math.exp(-(((t - mu) / sd) ** 2))


def smooth(a: float, b: float, x: float) -> float:
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def design_typhoon(t_h: float) -> float:
    # backend/intelligence.py::storm_profile over 12 h (t in [0, 1)).
    t = t_h / 12.0
    return min(2.0 + 238.0 * math.exp(-(((t - 0.42) / 0.17) ** 2)), 250.0)


def ompong(t_h: float) -> float:
    # Outer rain bands, then the eyewall passage north of Baguio with two intense bands.
    env = smooth(0.0, 4.0, t_h) * (1.0 - smooth(18.0, 24.0, t_h))
    bands = gauss(t_h, 6.0, 0.9, 48) + gauss(t_h, 10.0, 0.8, 92) + gauss(t_h, 11.6, 0.6, 118) + gauss(t_h, 14.2, 1.0, 66)
    return 6.0 * env + bands


def kristine_egay(t_h: float) -> float:
    # Southwest-monsoon enhanced orographic lift over the Cordillera: long, sustained, pulsing.
    env = smooth(0.0, 5.0, t_h) * (1.0 - smooth(24.0, 30.0, t_h))
    pulses = 14.0 * (0.5 + 0.5 * math.sin(2.0 * math.pi * t_h / 2.6))
    return env * (32.0 + pulses) + gauss(t_h, 16.0, 1.4, 52)


def cloudburst(t_h: float) -> float:
    # Afternoon convective cell: rapid rise to a ~150 mm/h peak at 35 min, fast recession.
    t_min = t_h * 60.0
    if t_min <= 0:
        return 0.0
    k, theta = 3.2, 15.5      # gamma-shaped, mode = (k-1)*theta = 34 min
    shape = (t_min / ((k - 1) * theta)) ** (k - 1) * math.exp(-(t_min - (k - 1) * theta) / theta)
    return 150.0 * shape


def habagat(t_h: float) -> float:
    # Steady southwest monsoon: persistent moderate rain with a mid-event enhancement.
    return (17.0 + 5.0 * math.sin(2.0 * math.pi * t_h / 6.0)) * smooth(0.0, 2.0, t_h) * (1.0 - smooth(22.0, 24.0, t_h)) \
        + gauss(t_h, 12.0, 1.8, 22)


STORMS = [
    ("DESIGN_TYPHOON_12H", "12 h Design Typhoon (twin default replay)", 720, design_typhoon,
     "The backend PLAYBACK storm (storm_profile): Gaussian build-up / peak / recession over 12 h."),
    ("OMPONG_2018", "Typhoon Ompong 2018 Baguio Peak Hyetograph", 1440, ompong,
     "Typhoon Ompong (Mangkhut), 14-15 Sep 2018: outer bands, then two intense eyewall bands passing north of Baguio."),
    ("KRISTINE_EGAY_OROGRAPHIC", "Typhoon Kristine / Egay Cordillera Orographic Downpour", 1800, kristine_egay,
     "Habagat-enhanced orographic rainfall of Egay (Doksuri, Jul 2023) / Kristine (Trami, Oct 2024): long sustained pulsing downpour."),
    ("AFTERNOON_CLOUDBURST", "Baguio Afternoon Convective Cloudburst", 180, cloudburst,
     "Short, violent afternoon thunderstorm cell typical of the Baguio wet season."),
    ("HABAGAT_MONSOON", "Steady Southwest Habagat Monsoon", 1440, habagat,
     "Persistent southwest-monsoon rain with a mid-event enhancement."),
]

# Station sites approximate (synthetic) gauge locations bounding the basin; elevations per the
# project brief. Replace with CDRRMO / PAGASA FEWS metadata before operational use.
FEWS_STATIONS = [
    dict(station="FEWS City Camp Lagoon", lon=120.5863, lat=16.4093, elevation_m=1430.0),
    dict(station="FEWS Ferguson Rd", lon=120.5935, lat=16.4185, elevation_m=1465.0),
    dict(station="FEWS Irisan", lon=120.5590, lat=16.4220, elevation_m=1485.0),
    dict(station="FEWS Brookspoint", lon=120.6010, lat=16.4070, elevation_m=1445.0),
]


def build() -> dict:
    storms = []
    for sid, label, dur, fn, note in STORMS:
        rates = [round(max(min(fn(k * STEP_MIN / 60.0), 250.0), 0.0), 1) for k in range(dur // STEP_MIN + 1)]
        total = sum(0.5 * (a + b) * STEP_MIN / 60.0 for a, b in zip(rates, rates[1:]))
        storms.append(dict(id=sid, label=label, duration_min=dur, step_min=STEP_MIN, peak_mm_hr=max(rates),
                           total_mm=round(total, 1), synthetic=True, note=note, rate_mm_hr=rates))
    return dict(
        schema_version="1.0.0",
        provenance="SYNTHETIC design hyetographs shaped after reported event character; not gauge records.",
        reference_elevation_m=1430.0,
        orographic_lapse_per_100m=0.04,
        idw_power=2,
        fews_stations=FEWS_STATIONS,
        storms=storms,
    )


def main() -> int:
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        ok = OUT.exists() and OUT.read_text(encoding="utf-8") == text
        print("precip_library.json", "up to date" if ok else "STALE")
        return 0 if ok else 1
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(STORMS)} storms)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
