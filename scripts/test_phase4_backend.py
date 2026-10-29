#!/usr/bin/env python3
"""Phase 4 / 7B backend verification suite.

    python scripts/test_phase4_backend.py          (uses the project venv's packages)

Covers: edge DSP (thermal comp, median/variance, Kalman), multi-shape hydraulics parity with
the Phase 1 LUT, payload codec parity with the generator and every LUT record, INT8 classifier
discrimination, fusion arbitration (backwater paradox), the numpy LUT interpolator, LoRa
time-on-air, the FastAPI surface (REST, three ingest formats, hardware drive, WS stream), and
Phase 7B: the ST-GNN forecaster (graph, RK4 lagoon, assimilation, generator parity), the
precipitation feeds (Open-Meteo / Tomorrow.io parsing, cache, offline), the historical storm
library, /api/v1/forecast, /api/v1/live/control, ingest scope, and golden-fixture freshness.
"""
from __future__ import annotations

import base64
import importlib.util
import math
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("CITYCAMP_FRAME_HZ", "20")   # fast ticker so the WS test gets frames quickly

from backend import edge_dsp as dsp  # noqa: E402
from backend.intelligence import arbitrate, storm_profile  # noqa: E402
from backend.lut import TwinLut  # noqa: E402
from backend import stgnn  # noqa: E402
from backend.stgnn import ForecastInput, STGNNForecaster  # noqa: E402
from backend.weather_feed import LiveFeed, hyetograph_trajectory, load_library, parse_open_meteo, parse_tomorrow  # noqa: E402

LUT = TwinLut()


def load_generator():
    spec = importlib.util.spec_from_file_location("gen", ROOT / "scripts" / "generate_citycamp_twin_data.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class CodecTests(unittest.TestCase):
    def test_golden_vectors(self):
        self.assertEqual(dsp.pack_payload(5115, -1, 127, 7, 4.20), 0xFFFFFFFF)
        self.assertEqual(dsp.pack_payload(5115, 127, 127, 7, 4.20), 0xFFDFFFFF)
        self.assertEqual(dsp.pack_payload(0, -128, 0, 0, 3.00), 0x00200000)

    def test_parity_with_generator_and_every_lut_record(self):
        gen = load_generator()
        rng = random.Random(3)
        for _ in range(3000):
            args = (rng.uniform(-50, 6000), rng.uniform(-300, 300), rng.uniform(-5, 150), rng.randrange(8), rng.uniform(2.8, 4.4))
            self.assertEqual(dsp.pack_payload(*args), gen.pack_telemetry_payload(*args))
        n = 0
        for s in LUT.lut["scenarios"] + LUT.lut["reference_scenarios"]:
            for t in s["sensors"].values():
                w = dsp.pack_payload(t["depth_mm"], t["dh_dt_mm_min"], t["capacity_pct"], t["anomaly_code"], t["vbat_v"])
                self.assertEqual(dsp.payload_hex(w), t["payload_hex"])
                n += 1
        self.assertEqual(n, 500)

    def test_hex_b64_roundtrip(self):
        for w in (0, 1, 0x8A4F321C, 0xFFFFFFFF):
            self.assertEqual(dsp.parse_payload(dsp.payload_hex(w)), w)
            self.assertEqual(dsp.parse_payload(dsp.payload_b64(w)), w)


class DspTests(unittest.TestCase):
    def test_thermal_compensation(self):
        # At 13.5 C sound is slower than the sensor's 343.2 m/s assumption -> raw reads long.
        c = 331.3 + 0.606 * 13.5
        self.assertAlmostEqual(dsp.thermal_compensate(1000.0, 13.5), 1000.0 * c / 343.2, places=9)
        self.assertLess(dsp.thermal_compensate(1000.0, 13.5), 1000.0)

    def test_uart_frames(self):
        self.assertEqual(dsp.parse_a02yyuw_frame(dsp.make_a02yyuw_frame(1234)), (dsp.UART_OK, 1234.0))
        self.assertEqual(dsp.parse_a02yyuw_frame(bytes([0xFF, 0x04, 0xD2, 0x00]))[0], dsp.UART_BAD_CHECKSUM)
        self.assertEqual(dsp.parse_a02yyuw_frame(bytes([0xFE, 0x04, 0xD2, 0xD5]))[0], dsp.UART_BAD_HEADER)
        self.assertEqual(dsp.parse_a02yyuw_frame(dsp.make_a02yyuw_frame(20))[0], dsp.UART_BLIND_ZONE)
        self.assertEqual(dsp.parse_a02yyuw_frame(dsp.make_a02yyuw_frame(4600))[0], dsp.UART_OUT_OF_RANGE)

    def test_median_rejects_splash(self):
        burst = [1000.0, 1001, 999, 1000, 450, 1002, 998, 1000, 1001, 999]    # one splash echo
        med, var, turb = dsp.median_and_variance(burst)
        self.assertAlmostEqual(med, 1000.0, delta=1.0)
        self.assertGreater(var, 1000.0)                                        # raw variance keeps the spike
        self.assertAlmostEqual(turb, math.log1p(var), places=12)

    def test_kalman_converges_under_splashing(self):
        # 20 independent storms rising 6 mm/min with 8 mm noise and 5 % splash spikes (whose
        # burst variance inflates R). Design target (KF_Q = 9): dh/dt sigma ~1.8 mm/min.
        dv, dh = [], []
        for seed in range(20):
            rng = random.Random(seed)
            st = dsp.KalmanState()
            truth = 500.0
            for _ in range(120):
                truth += 3.0                                                    # 3 mm per 0.5 min = 6 mm/min
                z = truth + rng.gauss(0, 8) + (-300 if rng.random() < 0.05 else 0)
                dsp.kalman_step(st, z, 64.0 if abs(z - truth) < 50 else 40000.0, 0.5)
            dv.append(st.v - 6.0)
            dh.append(st.h - truth)
        mean_v = sum(dv) / len(dv)
        sd_v = (sum((x - mean_v) ** 2 for x in dv) / len(dv)) ** 0.5
        self.assertLess(abs(mean_v), 1.0)
        self.assertLess(sd_v, 2.5)
        self.assertLess(max(abs(x) for x in dh), 20.0)


class HydraulicsTests(unittest.TestCase):
    def test_circular_paradox(self):
        g = dsp.ConduitGeom("CIRCULAR", 1.0, 1.0, 0.0, 0.013, 0.02)
        qmax, ratio = dsp.q_max(g)
        self.assertAlmostEqual(ratio, 0.938, delta=0.002)
        self.assertAlmostEqual(qmax / dsp.q_full(g), 1.076, delta=0.003)

    def test_parity_with_phase1_conduits(self):
        for c in LUT.network["conduits"]:
            g = dsp.ConduitGeom(c["shape"], c["geometry"]["rise_m"], c["geometry"]["span_m"],
                                c["geometry"]["haunch_m"] or 0.0, c["manning_n"], c["slope"])
            self.assertAlmostEqual(dsp.q_full(g) / c["q_full_cms"], 1.0, delta=2e-3, msg=c["id"])
            self.assertAlmostEqual(dsp.q_max(g)[0] / c["q_max_cms"], 1.0, delta=2e-3, msg=c["id"])

    def test_froude_and_energy(self):
        g = dsp.ConduitGeom("RECT_CLOSED", 2.7, 2.5, 0.152, 0.013, 0.005)
        h = dsp.hydraulics_at_depth(g, 0.6)
        self.assertGreater(h.froude, 1.0)                                     # supercritical apron at normal depth
        self.assertAlmostEqual(h.specific_energy_m, 0.6 + h.velocity_ms ** 2 / (2 * dsp.G), places=9)
        self.assertTrue(dsp.hydraulics_at_depth(g, 3.0).pressurized)


class ClassifierTests(unittest.TestCase):
    def cls(self, h, v, s2, he=0.5, fr=0.5, vb=4.0, fault=False):
        return dsp.classify_quantized(dsp.quantize_features(h, v, math.log1p(s2), he), fr, vb, fault)

    def test_flash_vs_blockage(self):
        self.assertEqual(self.cls(0.45, 40.0, 400.0), 1)                       # steep rise + chop
        self.assertEqual(self.cls(0.72, 0.5, 9.0), 2)                          # deep, flat, quiet
        self.assertEqual(self.cls(0.72, 0.5, 400.0), 0)                        # deep but choppy: not ponding
        self.assertEqual(self.cls(0.3, 1.0, 20.0, fr=1.8), 3)
        self.assertEqual(self.cls(1.05, 0.0, 5.0), 4)
        self.assertEqual(self.cls(0.2, 0.0, 5.0, fault=True), 5)
        self.assertEqual(self.cls(0.2, 0.0, 5.0, vb=3.2), 6)
        self.assertEqual(self.cls(1.05, 0.0, 5.0, vb=3.2), 4)                  # battery never masks a surcharge


class LoraFsmTests(unittest.TestCase):
    def test_time_on_air(self):
        self.assertAlmostEqual(dsp.lora_time_on_air_ms(7), 51.456, delta=0.01)
        self.assertLess(dsp.lora_time_on_air_ms(10), dsp.DWELL_LIMIT_MS)

    def test_fsm(self):
        self.assertEqual(dsp.fsm_next(0.01, 0.0, 0)[0], 0)
        self.assertEqual(dsp.fsm_next(0.3, 3.0, 0)[0], 1)
        self.assertEqual(dsp.fsm_next(0.3, 30.0, 1)[0], 2)
        self.assertEqual(dsp.fsm_next(0.3, 30.0, 1, bench_demo=True)[1:3], (1, 1))

    def test_standpipe_scaling(self):
        self.assertAlmostEqual(dsp.standpipe_scaled_depth_mm(740.0, 1000.0, 0.6), 600.0)
        self.assertAlmostEqual(dsp.standpipe_scaled_depth_mm(850.0, 1000.0, 0.6) / 600.0, 850 / 740)


class IntelligenceTests(unittest.TestCase):
    def test_storm_profile_matches_frontend_shape(self):
        r0, c0 = storm_profile(0.0)
        rp, cp = storm_profile(0.42)
        self.assertLess(r0, 5.0)
        self.assertGreater(rp, 235.0)
        self.assertLess(c0, cp)

    def test_backwater_paradox_resolution(self):
        en08 = dict(anomaly_class="TRASH_BLOCKAGE", h_over_d=0.62, turbulence_index=2.9)
        en10_hi = dict(anomaly_class="TRASH_BLOCKAGE", capacity_pct=62.0)
        v = arbitrate({"EN-08": en08, "EN-10": en10_hi}, 4.0, False, "ROCK_TUNNEL_CHOKE_4.44_CMS")
        self.assertEqual(v["root_cause"], "DOWNSTREAM_ROCK_CHOKE_BACKWATER")
        self.assertTrue(v["suppressed_false_alarm"])
        v = arbitrate({"EN-08": en08, "EN-10": en10_hi}, 60.0, False, "TRASH_RACK_ORIFICE")
        self.assertEqual(v["root_cause"], "CONFIRMED_TRASH_RACK_OCCLUSION")
        v = arbitrate({"EN-08": en08}, 10.0, True, "TRASH_RACK_ORIFICE")
        self.assertEqual(v["root_cause"], "INTAKE_SURCHARGE_OVERFLOW")

    def test_lut_interpolator_matches_grid(self):
        for s in LUT.lut["scenarios"]:
            r, b = s["rainfall_mm_hr"], s["trash_rack_blockage_pct"]
            lag = LUT.lagoon(r, b)
            self.assertAlmostEqual(lag.depth_m, s["lagoon"]["lagoon_water_depth_m"], places=9)
            self.assertAlmostEqual(lag.orifice_flow_cms, s["lagoon"]["orifice_flow_cms"], delta=2e-3)
            self.assertAlmostEqual(lag.head_loss_m, s["lagoon"]["orifice_head_loss_m"], delta=2e-3)
            self.assertEqual(lag.control, s["lagoon"]["outflow_control"])
            truth = LUT.sensor_truth(r, b)
            for sid, t in s["sensors"].items():
                self.assertAlmostEqual(truth[sid]["depth_mm"], t["depth_mm"], places=6)
        ref = next(x for x in LUT.lut["reference_scenarios"] if x["key"] == "R200_B85")
        self.assertAlmostEqual(LUT.lagoon(200, 85).head_loss_m, ref["lagoon"]["orifice_head_loss_m"], delta=0.01)

    def test_hardware_inversion(self):
        target = LUT.sensor_truth(150, 0)["EN-03"]["capacity_pct"]
        r = LUT.invert_rain_for_sensor("EN-03", target, 0)
        self.assertAlmostEqual(LUT.sensor_truth(r, 0)["EN-03"]["capacity_pct"], target, delta=3.0)


def _scenario(key):
    sc = LUT.lut["scenarios"][LUT.lut["index"][key]]
    return sc


class STGNNTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.f = STGNNForecaster(LUT.network, load_library(), LUT.tunnel_limit)

    def _input(self, key, rain, clog, measured=None, persist=None):
        sc = _scenario(key)
        cs = [sc["conduits"][c["id"]] for c in self.f.conduits]
        ref = {k: v["capacity_pct"] for k, v in sc["sensors"].items()}
        return ForecastInput(rain_mm_hr=list(rain), persist_rain_mm_hr=persist if persist is not None else rain[-1],
                             blockage_pct=clog, lagoon_depth_m=sc["lagoon"]["lagoon_water_depth_m"],
                             conduit_flow_cms=[c["flow_cms"] for c in cs], conduit_velocity_ms=[c["velocity_ms"] for c in cs],
                             conduit_capacity=[c["capacity_ratio"] for c in cs],
                             sensor_capacity_pct=dict(ref, **(measured or {})), sensor_reference_pct=ref,
                             source=dict(kind="TWIN", label=key))

    def test_graph_is_the_drainage_network(self):
        a = self.f.adjacency([1.0] * self.f.n_cond)
        self.assertEqual(a.shape, (65, 65))
        nz = a[a > 0]
        self.assertEqual(nz.size, 63)
        self.assertTrue(((nz > 0) & (nz < 1)).all())
        self.assertAlmostEqual(float(self.f.upstream_area_ha.max()),
                               sum(n["catchment_area_ha"] for n in LUT.network["nodes"] if n["id"].startswith(("LRQ", "TUN"))), delta=1e3)

    def test_constants_and_rack_match_generator(self):
        gen = load_generator()
        self.assertEqual(stgnn.BASEFLOW_CMS_PER_HA, gen.BASEFLOW_CMS_PER_HA)
        self.assertEqual(stgnn.LAGOON_SEEPAGE_CMS, gen.LAGOON_SEEPAGE_CMS)
        self.assertEqual(stgnn.SPILL_WEIR_COEFF, gen.SPILL_WEIR_COEFF)
        self.assertEqual(stgnn.SPILL_CREST_LENGTH_M, gen.SPILL_CREST_LENGTH_M)
        for p in (0.0, 0.5, 0.9):
            table = self.f.rack_table(p)
            for k in (40, 160, 320, 600):
                self.assertAlmostEqual(float(table[k]), gen.rack_flow(float(self.f.rack_h[k]), p), places=6)
        for h in (0.0, 1.5, 4.0, 6.5, 6.9):
            self.assertAlmostEqual(float(self.f.lagoon_volume(h)), gen.lagoon_volume(h), places=6)
            self.assertAlmostEqual(float(self.f.lagoon_depth(gen.lagoon_volume(h))), h, places=9)

    def test_steady_rain_keeps_the_network_steady(self):
        out = self.f.forecast(self._input("R25_B0", [25.0] * 61, 0.0))
        now = {k: v["capacity_pct"] for k, v in _scenario("R25_B0")["sensors"].items()}
        for sid in ("EN-01", "EN-02", "EN-03", "EN-04", "EN-05", "EN-06"):
            self.assertAlmostEqual(out["horizons"][-1]["sensors"][sid]["capacity_pct"], now[sid], delta=0.6)

    def test_rk4_overflow_time_matches_generator_mass_balance(self):
        out = self.f.forecast(self._input("R50_B0", [50.0] * 61, 0.0))
        lut_remaining = _scenario("R50_B0")["lagoon"]["estimated_time_to_overflow_min"] - 180.0
        self.assertAlmostEqual(out["time_to_overflow_min"], lut_remaining, delta=3.0)
        h = out["horizons"]
        self.assertEqual([x["minutes"] for x in h], [15, 30, 60])
        self.assertTrue(h[0]["lagoon_depth_m"] < h[1]["lagoon_depth_m"] < h[2]["lagoon_depth_m"])

    def test_bounds_probabilities_and_bottleneck(self):
        out = self.f.forecast(self._input("R25_B25", hyetograph_trajectory(
            {s["id"]: s for s in load_library()["storms"]}["AFTERNOON_CLOUDBURST"], 0.0), 25.0))
        for h in out["horizons"]:
            self.assertLessEqual(h["lagoon_depth_p05_m"], h["lagoon_depth_m"])
            self.assertLessEqual(h["lagoon_depth_m"], h["lagoon_depth_p95_m"])
            self.assertTrue(0.0 <= h["surcharge_probability_pct"] <= 100.0)
            self.assertIn(h["next_bottleneck"]["sensor_id"], [f"EN-{i:02d}" for i in range(1, 11) if i != 9])
            self.assertEqual(len(h["sensors"]), 10)
        self.assertIsNotNone(out["time_to_overflow_min"])         # a 150 mm/h cloudburst on a 3 m bowl

    def test_assimilation_pulls_the_subtree_toward_the_sensor(self):
        base = self.f.forecast(self._input("R50_B0", [50.0] * 61, 0.0))
        hot = self.f.forecast(self._input("R50_B0", [50.0] * 61, 0.0, measured={"EN-01": 95.0}))
        self.assertGreater(hot["horizons"][0]["sensors"]["EN-01"]["capacity_pct"], base["horizons"][0]["sensors"]["EN-01"]["capacity_pct"] + 20)
        self.assertAlmostEqual(hot["horizons"][0]["sensors"]["EN-04"]["capacity_pct"],
                               base["horizons"][0]["sensors"]["EN-04"]["capacity_pct"], delta=0.5)

    def test_storm_library_and_goldens_are_fresh(self):
        lib = load_library()
        self.assertEqual([s["id"] for s in lib["storms"]],
                         ["DESIGN_TYPHOON_12H", "OMPONG_2018", "KRISTINE_EGAY_OROGRAPHIC", "AFTERNOON_CLOUDBURST", "HABAGAT_MONSOON"])
        self.assertEqual([s["elevation_m"] for s in lib["fews_stations"]], [1430.0, 1465.0, 1485.0, 1445.0])
        design = lib["storms"][0]
        for t in (0.0, 0.25, 0.42, 0.8):
            self.assertAlmostEqual(hyetograph_trajectory(design, t * 720.0)[0], storm_profile(t)[0], delta=6.0)
        for script in ("gen_precip_library.py", "gen_frontend_goldens.py"):
            r = subprocess.run([sys.executable, str(ROOT / "scripts" / script), "--check"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{script}: {r.stdout}{r.stderr} (re-run it and commit the output)")


SAMPLE_OM = {
    "current": {"time": "2026-10-27T14:15", "interval": 900, "temperature_2m": 18.6, "precipitation": 1.2,
                "rain": 1.2, "showers": 0.0, "weather_code": 63},
    "minutely_15": {"time": ["2026-10-27T14:30", "2026-10-27T14:45"], "precipitation": [2.0, 3.5]},
    "hourly": {"time": ["2026-10-27T15:00", "2026-10-27T16:00"], "precipitation": [9.0, 3.0]},
}


class WeatherFeedTests(unittest.TestCase):
    def test_open_meteo_trajectory(self):
        d = parse_open_meteo(SAMPLE_OM)
        t = d["trajectory_mm_hr"]
        self.assertEqual(len(t), 61)
        self.assertAlmostEqual(d["current_mm_hr"], 4.8)
        self.assertEqual((t[0], t[10], t[20], t[40], t[60]), (4.8, 8.0, 14.0, 9.0, 3.0))

    def test_tomorrow_parse(self):
        mins = [{"time": f"2026-10-27T06:{k:02d}:00Z", "values": {"precipitationIntensity": 0.5 * k, "temperature": 19.0}} for k in range(30)]
        d = parse_tomorrow({"timelines": {"minutely": mins}})
        self.assertEqual(d["provider"], "TOMORROW_IO")
        self.assertEqual(len(d["trajectory_mm_hr"]), 61)
        self.assertEqual(d["trajectory_mm_hr"][29], 14.5)
        self.assertEqual(d["trajectory_mm_hr"][60], 14.5)

    def test_cache_and_offline_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "feed.json"
            offline = LiveFeed(cache, fetch=lambda *a, **k: (_ for _ in ()).throw(OSError("no network")))
            offline.refresh()
            snap = offline.snapshot()
            self.assertEqual(snap["status"], "OFFLINE")
            ok = LiveFeed(cache, fetch=lambda *a, **k: SAMPLE_OM)
            ok.refresh()
            self.assertEqual(ok.snapshot()["status"], "LIVE")
            self.assertTrue(cache.exists())
            warm = LiveFeed(cache, fetch=lambda *a, **k: (_ for _ in ()).throw(OSError("no network")))
            self.assertEqual(warm.snapshot()["current_mm_hr"], 4.8)        # disk cache survives restarts


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from backend.main import app
        cls.client_cm = TestClient(app)
        cls.client = cls.client_cm.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_cm.__exit__(None, None, None)

    def test_health_state_schema(self):
        from backend.schemas import TwinFrame
        self.assertEqual(self.client.get("/api/v1/health").json()["status"], "ok")
        frame = TwinFrame.model_validate(self.client.get("/api/v1/state").json())
        self.assertEqual(sorted(frame.sensors), [f"EN-{i:02d}" for i in range(1, 11)])
        self.assertEqual([h.minutes for h in frame.nowcast.horizons], [15, 30, 60])
        self.assertEqual(len(frame.nowcast.fews), 4)
        self.assertEqual(self.client.get("/api/v1/network").json()["meta"]["counts"]["conduits"], 63)

    def test_forecast_endpoint_and_frame(self):
        from backend.schemas import Forecast, TwinFrame
        fc = Forecast.model_validate(self.client.get("/api/v1/forecast").json())
        self.assertEqual(fc.model, "STGNN-PHYS-v1")
        self.assertEqual([h.minutes for h in fc.horizons], [15, 30, 60])
        self.assertEqual(fc.graph, {"nodes": 65, "edges": 63})
        self.assertEqual(len(fc.rain_trajectory_mm_hr), 61)
        frame = TwinFrame.model_validate(self.client.get("/api/v1/state").json())
        self.assertEqual(sorted(frame.forecast.horizons[0].sensors), [f"EN-{i:02d}" for i in range(1, 11)])

    def test_live_control_sources(self):
        from backend.main import runtime
        from backend.schemas import TwinFrame
        storms = self.client.get("/api/v1/live/control").json()["storms"]
        self.assertEqual(len(storms), 5)
        r = self.client.post("/api/v1/live/control", json={"precip_source": "HISTORICAL", "storm_id": "OMPONG_2018"})
        self.assertEqual(r.status_code, 200, r.text)
        frame = TwinFrame.model_validate(runtime.tick(0.5))
        self.assertEqual((frame.mode, frame.precip_source, frame.storm_id), ("PLAYBACK", "HISTORICAL", "OMPONG_2018"))
        self.assertEqual(frame.forecast.source.kind, "HISTORICAL")
        self.assertEqual(frame.storm_period_s, 240.0)
        self.assertEqual(self.client.post("/api/v1/live/control", json={"precip_source": "HISTORICAL", "storm_id": "NOPE"}).status_code, 422)
        # live feed with an injected (offline-safe) fetcher
        old_feed = runtime.feed
        with tempfile.TemporaryDirectory() as tmp:
            runtime.feed = LiveFeed(Path(tmp) / "f.json", fetch=lambda *a, **k: SAMPLE_OM)
            runtime.feed.refresh()
            self.client.post("/api/v1/live/control", json={"precip_source": "LIVE_FEED", "trash_rack_blockage_pct": 10})
            frame = TwinFrame.model_validate(runtime.tick(0.5))
            self.assertEqual((frame.mode, frame.precip_source), ("SCENARIO", "LIVE_FEED"))
            self.assertAlmostEqual(frame.scenario.rainfall_mm_hr, 4.8)
            self.assertEqual(frame.forecast.source.kind, "LIVE_FEED")
            self.assertEqual(frame.forecast.rain_trajectory_mm_hr[10], 8.0)
        runtime.feed = old_feed
        self.client.post("/api/v1/live/control", json={"precip_source": "HISTORICAL", "storm_id": "DESIGN_TYPHOON_12H"})
        self.client.post("/api/v1/scenario", json={"mode": "PLAYBACK"})

    def test_ingest_scope_single_node_vs_full_catchment(self):
        from backend.main import runtime
        runtime.hardware.clear()
        self.client.post("/api/v1/scenario", json={"mode": "SCENARIO", "rainfall_mm_hr": 25, "trash_rack_blockage_pct": 0})
        word = dsp.pack_payload(1100.0, 40.0, 92.0, 1, 4.0)
        r = self.client.post("/api/v1/ingest/lorawan", json={"device_eui": "EN-02", "payload_hex": dsp.payload_hex(word), "scope": "single_node"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["scope"], r.json()["twin"]["mode"]), ("single_node", "SCENARIO"))
        frame = runtime.tick(0.5)
        self.assertEqual(frame["mode"], "SCENARIO")
        self.assertEqual(frame["hardware_override"]["scope"], "single_node")
        self.assertEqual(frame["sensors"]["EN-02"]["origin"], "HARDWARE")
        self.assertEqual(frame["scenario"]["rainfall_mm_hr"], 25)
        r = self.client.post("/api/v1/ingest/lorawan", json={"device_eui": "EN-02", "payload_hex": dsp.payload_hex(word), "scope": "full_catchment"})
        self.assertEqual(r.json()["twin"]["mode"], "HARDWARE")
        self.client.post("/api/v1/scenario", json={"mode": "PLAYBACK"})

    def test_ingest_distance_rig(self):
        from backend.main import runtime
        runtime.hardware.clear()
        runtime.distance_rigs.clear()
        self.client.post("/api/v1/scenario", json={"mode": "SCENARIO", "rainfall_mm_hr": 25, "trash_rack_blockage_pct": 0})
        # an ESP32 / Uno aquarium rig 85 % full: single-node by default, the twin keeps its weather
        for _ in range(12):
            r = self.client.post("/api/v1/ingest/distance", json={"device_eui": "EN-08", "fill_pct": 85, "tank_height_mm": 300})
            self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["scope"], body["twin"]["mode"]), ("single_node", "SCENARIO"))
        self.assertAlmostEqual(body["capacity_pct"], 85.0, delta=2.0)
        self.assertEqual(body["anomaly_class"], "TRASH_BLOCKAGE")          # flat pool above h/D 0.60
        frame = runtime.tick(0.5)
        self.assertEqual(frame["mode"], "SCENARIO")
        self.assertEqual(frame["sensors"]["EN-08"]["origin"], "HARDWARE")
        self.assertEqual(frame["hardware_override"]["scope"], "single_node")
        # raw distance from a 300 mm tank (50 mm air gap -> 250 mm water -> 113 %)
        for _ in range(12):
            r = self.client.post("/api/v1/ingest/distance", json={"device_eui": "02BA6C1000000003", "dist_mm": 50})
        self.assertEqual(r.json()["sensor_id"], "EN-03")
        self.assertGreater(r.json()["capacity_pct"], 100)
        self.assertEqual(r.json()["anomaly_class"], "SURCHARGED")
        # a board that already packed its word (universal sketch Wi-Fi body)
        word = dsp.pack_payload(1800.0, 4.0, 90.0, 2, 4.05)
        r = self.client.post("/api/v1/ingest/distance", json={"device_eui": "EN-08", "payload_hex": dsp.payload_hex(word),
                                                               "dist_mm": 70.0, "fill_pct": 90.0, "tank_height_mm": 300})
        self.assertEqual((r.json()["payload_hex"], r.json()["capacity_pct"]), (dsp.payload_hex(word), 90.0))
        # full-catchment coupling drives the whole twin
        r = self.client.post("/api/v1/ingest/distance", json={"device_eui": "EN-08", "fill_pct": 85, "scope": "full_catchment"})
        self.assertEqual(r.json()["twin"]["mode"], "HARDWARE")
        self.assertEqual(self.client.post("/api/v1/ingest/distance", json={"device_eui": "EN-08"}).status_code, 422)
        self.assertEqual(self.client.post("/api/v1/ingest/distance", json={"device_eui": "EN-77", "fill_pct": 5}).status_code, 404)
        runtime.hardware.clear()
        self.client.post("/api/v1/scenario", json={"mode": "PLAYBACK"})

    def test_decode(self):
        r = self.client.post("/api/v1/decode", json={"payload_hex": "0xFFC036CF"}).json()
        self.assertEqual((r["depth_mm"], r["anomaly_class"], r["vbat_v"]), (5115, "SURCHARGED", 4.2))
        self.assertEqual(self.client.post("/api/v1/decode", json={"payload_hex": "zz"}).status_code, 422)

    def test_scenario_and_ws_stream(self):
        from backend.schemas import TwinFrame
        self.client.post("/api/v1/scenario", json={"mode": "SCENARIO", "rainfall_mm_hr": 25, "trash_rack_blockage_pct": 0})
        with self.client.websocket_connect("/ws/live") as ws:
            frames = [TwinFrame.model_validate_json(ws.receive_text()) for _ in range(25)]
        last = frames[-1]
        self.assertEqual(last.mode, "SCENARIO")
        self.assertEqual(last.scenario.rainfall_mm_hr, 25)
        self.assertEqual(last.lagoon.bottleneck, "ROCK_TUNNEL_CHOKE_4.44_CMS")
        self.assertEqual(last.fusion.root_cause, "DOWNSTREAM_ROCK_CHOKE_BACKWATER")
        self.assertTrue(last.fusion.suppressed_false_alarm)
        self.client.post("/api/v1/scenario", json={"mode": "PLAYBACK"})

    def test_ingest_formats_and_hardware_drive(self):
        word = dsp.pack_payload(1700.0, 1.0, 85.0, 2, 3.96)
        r = self.client.post("/api/v1/ingest/lorawan", json={
            "device_eui": "EN-08", "payload_hex": dsp.payload_hex(word),
            "raw_unfiltered_depth_mm": 1500.0, "kalman_filtered_depth_mm": 1701.2, "temperature_c": 13.8})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["sensor_id"], "EN-08")
        self.assertEqual(body["twin"]["mode"], "HARDWARE")
        state = self.client.get("/api/v1/sensors/EN-08").json()
        self.assertEqual((state["origin"], state["payload_hex"], state["kalman_filtered_depth_mm"]),
                         ("HARDWARE", dsp.payload_hex(word), 1701.2))
        # base64 + real EUI
        r = self.client.post("/api/v1/ingest/lorawan", json={"device_eui": "02BA6C1000000003", "payload_b64": dsp.payload_b64(word)})
        self.assertEqual(r.json()["sensor_id"], "EN-03")
        # The Things Stack v3 webhook
        ttn = {"end_device_ids": {"dev_eui": "02BA6C1000000001"},
               "uplink_message": {"f_port": 10, "frm_payload": base64.b64encode(word.to_bytes(4, "big")).decode(),
                                  "rx_metadata": [{"rssi": -97, "snr": 7.25}]}}
        r = self.client.post("/api/v1/ingest/lorawan", json=ttn)
        self.assertEqual(r.json()["sensor_id"], "EN-01")
        self.assertEqual(self.client.get("/api/v1/sensors/EN-01").json()["lora"]["rssi_dbm"], -97)
        self.assertEqual(self.client.post("/api/v1/ingest/lorawan", json={"device_eui": "EN-99", "payload_hex": "0x0"}).status_code, 404)
        self.client.post("/api/v1/scenario", json={"mode": "PLAYBACK"})


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result.wasSuccessful() else 1)
