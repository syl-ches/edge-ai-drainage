#!/usr/bin/env python3
"""Golden vectors that lock the frontend TypeScript ports to the Python reference (Phase 7B).

    python scripts/gen_frontend_goldens.py           # (re)write tests/frontend/fixtures/*.json
    python scripts/gen_frontend_goldens.py --check   # exit 1 if a committed fixture is stale

  stgnn_golden.json   backend/stgnn.py forecasts for explicit inputs   <-> src/forecast/stgnn.ts
  edge_golden.json    backend/edge_dsp.py run_cycle (no-geometry + bench/aquarium standpipe
                      branches) for raw ultrasonic bursts             <-> src/edge/edgePipeline.ts
  weather_golden.json backend/weather_feed.py Open-Meteo trajectory    <-> src/live/weather.ts
Deterministic: no RNG state leaks between cases, no network, no timestamps.
"""
from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import edge_dsp as dsp  # noqa: E402
from backend.stgnn import ForecastInput, STGNNForecaster  # noqa: E402
from backend.weather_feed import hyetograph_trajectory, load_library, parse_open_meteo  # noqa: E402

FIX = ROOT / "tests" / "frontend" / "fixtures"
DATA = ROOT / "public" / "data"


def _lut():
    return json.loads((DATA / "simulation_lut.json").read_text(encoding="utf-8"))


def stgnn_cases() -> dict:
    lut = _lut()
    f = STGNNForecaster()
    lib = load_library()
    storms = {s["id"]: s for s in lib["storms"]}

    def state(key):
        sc = lut["scenarios"][lut["index"][key]]
        cs = [sc["conduits"][c["id"]] for c in f.conduits]
        caps = {k: v["capacity_pct"] for k, v in sc["sensors"].items()}
        return sc, [c["flow_cms"] for c in cs], [c["velocity_ms"] for c in cs], [c["capacity_ratio"] for c in cs], caps

    cases = []

    def add(name, key, rain, clog, measured=None, persist=None):
        sc, q, v, cap, ref = state(key)
        inp = ForecastInput(rain_mm_hr=[round(x, 4) for x in rain], persist_rain_mm_hr=round(persist if persist is not None else rain[-1], 4),
                            blockage_pct=clog, lagoon_depth_m=sc["lagoon"]["lagoon_water_depth_m"],
                            conduit_flow_cms=q, conduit_velocity_ms=v, conduit_capacity=cap,
                            sensor_capacity_pct=dict(ref, **(measured or {})), sensor_reference_pct=ref,
                            source=dict(kind="TWIN", label=name))
        out = f.forecast(inp)
        cases.append(dict(name=name, input=dict(
            rain_mm_hr=inp.rain_mm_hr, persist_rain_mm_hr=inp.persist_rain_mm_hr, blockage_pct=inp.blockage_pct,
            lagoon_depth_m=inp.lagoon_depth_m, conduit_flow_cms=q, conduit_velocity_ms=v, conduit_capacity=cap,
            sensor_capacity_pct=inp.sensor_capacity_pct, sensor_reference_pct=ref, source=inp.source), output=out))

    add("steady_R25_B0", "R25_B0", [25.0] * 61, 0.0)
    add("steady_R50_B0", "R50_B0", [50.0] * 61, 0.0)
    add("rising_from_dry", "R0_B0", [min(150.0, 2.5 * t) for t in range(61)], 0.0, persist=150.0)
    add("assimilated_hardware_R100_B50", "R100_B50", [100.0] * 61, 50.0, measured={"EN-01": 95.0, "EN-02": 120.0})
    add("cloudburst_R25_B25", "R25_B25", hyetograph_trajectory(storms["AFTERNOON_CLOUDBURST"], 0.0), 25.0)
    add("ompong_R150_B90", "R150_B90", hyetograph_trajectory(storms["OMPONG_2018"], 600.0), 90.0)
    return dict(generator="scripts/gen_frontend_goldens.py", cases=cases)


def edge_cases() -> dict:
    out = []
    rng = random.Random(20240917)

    def run(name, full_scale_m, mount_mm, standpipe, pipe_height_mm, bursts, dt_min, temp_c=24.0, vbat=4.05):
        cfg = dsp.EdgeNodeConfig(name, "02BA6C10000000FF", "XIAO_ESP32S3_A02YYUW", full_scale_m, mount_mm, None, 500.0, 0.0, vbat)
        kal = dsp.KalmanState()
        steps = []
        for raw in bursts:
            res = dsp.run_cycle(cfg, kal, raw, temp_c, dt_min, bench_demo=True, standpipe=standpipe, pipe_height_mm=pipe_height_mm)
            steps.append(dict(raw_mm=raw, d_med_mm=res["d_med_mm"], sigma_d2=res["sigma_d2"], turbulence=res["turbulence"],
                              measured_depth_mm=res["measured_depth_mm"], depth_mm=res["depth_mm"], dh_dt_mm_min=res["dh_dt_mm_min"],
                              h_over_d=res["h_over_d"], cap_pct=res["cap_pct"], anomaly_code=res["anomaly_code"],
                              fsm_state=res["fsm_state"], payload_hex=dsp.payload_hex(res["payload"]),
                              saturated=res["saturated"]))
        out.append(dict(name=name, config=dict(full_scale_m=full_scale_m, mount_mm=mount_mm, standpipe=standpipe,
                                               pipe_height_mm=pipe_height_mm, dt_min=dt_min, temp_c=temp_c, vbat_v=vbat),
                        steps=steps))

    def burst(d, noise):
        return [round(d + rng.gauss(0.0, noise), 1) for _ in range(dsp.BURST_LEN)]

    # aquarium tank (sensor 400 mm above the floor -> 100 % at 296 mm of water), 1 s cadence
    level = [0.0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.82, 0.9, 0.95, 1.0, 1.05, 1.08, 1.08, 1.08]
    run("aquarium_fill_and_pour", 1.2, 0.0, True, 400.0,
        [burst(400.0 - lv * 296.0, 1.5 if k < 5 else 16.0) for k, lv in enumerate(level)], 1.0 / 60.0)
    run("aquarium_flat_pool", 3.5, 0.0, True, 400.0, [burst(400.0 - 0.82 * 296.0, 0.8) for _ in range(12)], 1.0 / 60.0)
    # real manhole geometry (lid-mounted 2.6 m above invert of a 1.2 m pipe), 2 min cadence
    run("manhole_rising", 1.2, 2600.0, False, 1000.0, [burst(2600.0 - d, 3.0) for d in (100, 160, 260, 420, 640, 900, 1150, 1250)], 2.0)
    run("blind_zone_and_out_of_range", 0.9, 1500.0, False, 1000.0, [burst(20.0, 0.5), burst(25.0, 0.5), burst(4700.0, 2.0)], 1.0)
    return dict(generator="scripts/gen_frontend_goldens.py", cases=out)


SAMPLE_OPEN_METEO = {
    "current": {"time": "2026-10-27T14:15", "interval": 900, "temperature_2m": 18.6, "precipitation": 1.2,
                "rain": 1.2, "showers": 0.0, "weather_code": 63, "wind_speed_10m": 11.2},
    "minutely_15": {"time": ["2026-10-27T14:15", "2026-10-27T14:30", "2026-10-27T14:45", "2026-10-27T15:00",
                             "2026-10-27T15:15", "2026-10-27T15:30"],
                    "precipitation": [1.2, 2.0, 3.5, 1.0, 0.4, None]},
    "hourly": {"time": ["2026-10-27T14:00", "2026-10-27T15:00", "2026-10-27T16:00"], "precipitation": [6.0, 9.0, 3.0]},
}


def weather_cases() -> dict:
    no_m15 = json.loads(json.dumps(SAMPLE_OPEN_METEO))
    no_m15.pop("minutely_15")
    return dict(cases=[dict(name="minutely_15", payload=SAMPLE_OPEN_METEO, output=parse_open_meteo(SAMPLE_OPEN_METEO)),
                       dict(name="hourly_only", payload=no_m15, output=parse_open_meteo(no_m15))])


def _dump(obj) -> str:
    def clean(x):
        if isinstance(x, float):
            return None if math.isnan(x) else x
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [clean(v) for v in x]
        return x
    return json.dumps(clean(obj), indent=1) + "\n"


FILES = {"stgnn_golden.json": stgnn_cases, "edge_golden.json": edge_cases, "weather_golden.json": weather_cases}


def main() -> int:
    check = "--check" in sys.argv
    FIX.mkdir(parents=True, exist_ok=True)
    stale = []
    for name, fn in FILES.items():
        text = _dump(fn())
        path = FIX / name
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(name)
        else:
            path.write_text(text, encoding="utf-8", newline="\n")
            print(f"wrote {path.relative_to(ROOT)}")
    if check:
        print("fixtures", "STALE: " + ", ".join(stale) if stale else "up to date")
        return 1 if stale else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
