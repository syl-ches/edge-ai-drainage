#!/usr/bin/env python3
"""Phase 4 backend verification suite.

    python scripts/test_phase4_backend.py          (uses the project venv's packages)

Covers: edge DSP (thermal comp, median/variance, Kalman), multi-shape hydraulics parity with
the Phase 1 LUT, payload codec parity with the generator and every LUT record, INT8 classifier
discrimination, fusion arbitration (backwater paradox), the numpy LUT interpolator, LoRa
time-on-air, and the FastAPI surface (REST, three ingest formats, hardware drive, WS stream).
"""
from __future__ import annotations

import base64
import importlib.util
import math
import os
import random
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("CITYCAMP_FRAME_HZ", "20")   # fast ticker so the WS test gets frames quickly

from backend import edge_dsp as dsp  # noqa: E402
from backend.intelligence import arbitrate, storm_profile  # noqa: E402
from backend.lut import TwinLut  # noqa: E402

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
