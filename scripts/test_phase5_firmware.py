#!/usr/bin/env python3
"""Phase 5 firmware verification: native C++ build of edge_core.hpp + parity with edge_dsp.py.

    python scripts/test_phase5_firmware.py [--cxx "zig c++"] [--keep]

1. Static checks: constants/enums in edge_core.hpp == backend/edge_dsp.py, no heap/STL
   containers in the header, node_profiles.hpp regenerated from the backend fleet.
2. Native build (g++ / clang++ / c++ / `zig c++` / $CXX), -Wall -Wextra -Werror
   -fno-exceptions -fno-rtti, in double (exact-parity) and float (ESP32-S3) precision;
   both run the built-in --selftest (golden vectors, UART checksum + blind zone, median
   splash rejection, Kalman convergence, FLASH_SURGE vs TRASH_BLOCKAGE, standpipe sweep).
3. Differential vectors: thousands of random inputs through every core function, C++ vs
   Python (integers bit-exact, reals to 1e-9 relative).
4. End-to-end: a C++-generated standpipe surge [EDGE_TX] frame -> serial-bridge parser ->
   POST /api/v1/ingest/lorawan -> EN-08 updated as HARDWARE in the live twin state.

If no C++ compiler is found, steps 2-3 fall back to the Python reference + static checks
and the run is reported as PARTIAL (exit code 0, clearly labelled).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("CITYCAMP_FRAME_HZ", "0")       # no background ticker in the e2e test

from backend import edge_dsp as dsp  # noqa: E402
from backend.twin import TwinRuntime  # noqa: E402

FW = ROOT / "firmware" / "citycamp_edge_node"
HEADER = FW / "include" / "edge_core.hpp"
HARNESS = FW / "test" / "test_edge_core.cpp"
SHAPE_CODE = {"CIRCULAR": 0, "RECT_CLOSED": 1, "ARCH": 2}

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")


def close(a: float, b: float, rel: float = 1e-9, abs_: float = 1e-9) -> bool:
    return abs(a - b) <= max(abs_, rel * max(abs(a), abs(b)))


# ----------------------------------------------------------------------------- static checks
def static_checks() -> None:
    print("Static checks")
    text = HEADER.read_text(encoding="utf-8")
    consts = dict(re.findall(r"constexpr (?:real|int|std::size_t) ([A-Z0-9_]+) = ([-0-9.e]+);", text))
    mismatched = []
    for name, val in consts.items():
        if hasattr(dsp, name) and not close(float(getattr(dsp, name)), float(val), 1e-12):
            mismatched.append(f"{name}: hpp {val} vs py {getattr(dsp, name)}")
    shared = [n for n in consts if hasattr(dsp, n)]
    record(f"{len(shared)} shared constants identical", not mismatched and len(shared) >= 25, "; ".join(mismatched))
    arrays_ok = (re.search(r"FSM_WAKE_S\[3\] = \{900, 120, 15\}", text) and re.search(r"FSM_UPLINK_S\[3\] = \{3600, 300, 60\}", text)
                 and dsp.FSM_WAKE_S == (900, 120, 15) and dsp.FSM_UPLINK_S == (3600, 300, 60))
    record("FSM tables identical", bool(arrays_ok))
    enum = dict((k, int(v)) for k, v in re.findall(r"ANOMALY_([A-Z_]+) = (\d)", text))
    record("anomaly enum codes == CLAUDE.md §10", enum == dsp.ANOMALY_CODES, str(enum))
    code = re.sub(r"//.*", "", text)
    banned = [t for t in (r"\bnew\b", r"\bdelete\b", r"malloc", r"calloc", r"std::vector", r"std::string", r"std::map",
                          r"<vector>", r"<string>", r"<map>", r"<memory>", r"\bthrow\b") if re.search(t, code)]
    record("zero heap / no STL containers / no exceptions in edge_core.hpp", not banned, ", ".join(banned))
    gen = subprocess.run([sys.executable, str(ROOT / "scripts" / "gen_firmware_profiles.py"), "--check"], capture_output=True, text=True)
    record("node_profiles.hpp matches backend fleet", gen.returncode == 0, gen.stdout.strip())


# ----------------------------------------------------------------------------- compiler
def find_compiler(explicit: str | None) -> list[str] | None:
    for cand in filter(None, [explicit, os.environ.get("CXX")]):
        parts = shlex.split(cand, posix=os.name != "nt")
        parts[0] = parts[0].strip('"')
        if shutil.which(parts[0]) or Path(parts[0]).exists():
            return parts
    for exe in ("g++", "clang++", "c++"):
        if shutil.which(exe):
            return [exe]
    if shutil.which("zig"):
        return ["zig", "c++"]
    return None


def build(cxx: list[str], out: Path, double: bool) -> tuple[bool, str]:
    cmd = cxx + ["-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-exceptions", "-fno-rtti",
                 f"-I{FW / 'include'}", str(HARNESS), "-o", str(out)]
    if double:
        cmd.insert(len(cxx), "-DEDGE_CORE_USE_DOUBLE")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    # zig's bundled libunwind prints its own warnings on first build; only our sources matter.
    ours = [ln for ln in (proc.stderr or "").splitlines() if "edge_core" in ln or "test_edge_core" in ln or "node_profiles" in ln]
    return proc.returncode == 0 and out.exists(), "\n".join(ours[:20]) or (proc.stderr or "")[-800:]


# ----------------------------------------------------------------------------- vectors
class Vectors:
    def __init__(self, seed: int = 20240917):
        self.rng = random.Random(seed)
        self.lines: list[str] = []
        self.expect: list = []
        self.rt = TwinRuntime()
        self.cfgs = [n.cfg for n in self.rt.nodes.values()]
        self.geoms = [dsp.ConduitGeom(c["shape"], c["geometry"]["rise_m"], c["geometry"]["span_m"],
                                      c["geometry"]["haunch_m"] or 0.0, c["manning_n"], c["slope"])
                      for c in self.rt.lut.network["conduits"]]

    def add(self, line: str, kind: str, exp) -> None:
        self.lines.append(line)
        self.expect.append((kind, exp, line))

    def build(self) -> None:
        r = self.rng
        for _ in range(2500):
            a = (r.uniform(-100, 6500), r.uniform(-300, 300), r.uniform(-10, 160), r.randrange(8), r.uniform(2.7, 4.5))
            self.add("PACK %.17g %.17g %.17g %d %.17g" % a, "PACK", dsp.payload_hex(dsp.pack_payload(*a)))
        for _ in range(200):
            w = r.getrandbits(32)
            self.add(f"B64 {w}", "B64", dsp.payload_b64(w))
        for _ in range(200):
            d, t = r.uniform(30, 4500), r.uniform(5, 30)
            self.add(f"THERM {d!r} {t!r}", "REALS", [dsp.thermal_compensate(d, t)])
        for _ in range(400):
            n = r.randint(1, 10)
            base = r.uniform(100, 4000)
            s = [base + r.gauss(0, r.uniform(0.5, 40)) - (r.uniform(100, 600) if r.random() < 0.1 else 0) for _ in range(n)]
            self.add("STATS %d %s" % (n, " ".join(repr(x) for x in s)), "REALS", list(dsp.median_and_variance(s)))
        for _ in range(150):
            st = dsp.KalmanState()
            steps = [(r.uniform(0, 3000), r.uniform(0, 5000), r.choice([0.0, 1 / 60, 0.5, 2.0, 15.0])) for _ in range(r.randint(1, 40))]
            for z, s2, dt in steps:
                dsp.kalman_step(st, z, s2, dt)
            self.add("KALMAN %d %s" % (len(steps), " ".join("%r %r %r" % x for x in steps)), "REALS",
                     [st.h, st.v, st.p00, st.p01, st.p11])
        for g in self.geoms[::3] + [dsp.ConduitGeom("CIRCULAR", 0.9, 0.9, 0, 0.013, 0.2)]:
            for y in (0.0, g.rise_m * r.random(), g.rise_m * 0.938, g.rise_m, g.rise_m * 1.2):
                a, p, t = dsp.section_props(g, y)
                qm, ratio = dsp.q_max(g)
                h = dsp.hydraulics_at_depth(g, y)
                exp = [a, p, t, dsp.manning_q(g, y), dsp.q_full(g), qm, ratio, h.flow_cms, h.velocity_ms,
                       h.froude or 0.0, 1 if h.froude is not None else 0, h.specific_energy_m, h.capacity_pct, 1 if h.pressurized else 0]
                self.add(f"HYD {SHAPE_CODE[g.shape]} {g.rise_m!r} {g.span_m!r} {g.haunch_m!r} {g.manning_n!r} {g.slope!r} {y!r}",
                         "MIXED", exp)
        for _ in range(3000):
            h, v, s, e = r.uniform(0, 1.4), r.uniform(-60, 80), r.uniform(0, 9), r.uniform(0, 8)
            hasfr = r.random() < 0.8
            fr, vb, fault = r.uniform(0, 3), r.uniform(3.0, 4.2), r.random() < 0.05
            f = dsp.quantize_features(h, v, s, e)
            code = dsp.classify_quantized(f, fr if hasfr else None, vb, fault)
            self.add(f"CLS {h!r} {v!r} {s!r} {e!r} {int(hasfr)} {fr!r} {vb!r} {int(fault)}", "INTS",
                     [code, f.q_h, f.q_v, f.q_s, f.q_e])
        for _ in range(400):
            if r.random() < 0.5:
                frame = dsp.make_a02yyuw_frame(r.uniform(0, 6000))
            else:
                frame = bytes([r.choice([0xFF, 0xFF, 0xFE]), r.getrandbits(8), r.getrandbits(8), r.getrandbits(8)])
            st, dist = dsp.parse_a02yyuw_frame(frame)
            self.add("UART " + " ".join(str(b) for b in frame), "MIXED", [st, dist])
        for _ in range(600):
            h, v, code, bench = r.uniform(0, 1.3), r.uniform(-30, 60), r.randrange(7), r.random() < 0.3
            s, wake, up, cur = dsp.fsm_next(h, v, code, bench)
            self.add(f"FSM {h!r} {v!r} {code} {int(bench)}", "MIXED", [s, wake, up, cur])
        for sf in range(7, 13):
            self.add(f"TOA {sf}", "REALS", [dsp.lora_time_on_air_ms(sf)])
        for _ in range(100):
            w, ph, rise = r.uniform(-10, 1000), r.uniform(500, 1500), r.uniform(0.6, 2.7)
            self.add(f"STAND {w!r} {ph!r} {rise!r}", "REALS", [dsp.standpipe_scaled_depth_mm(w, ph, rise)])
        for _ in range(600):
            idx = r.randrange(len(self.cfgs))
            cfg = self.cfgs[idx]
            standpipe = r.random() < 0.35
            ph = r.uniform(800, 1200)
            base = r.uniform(40, ph - 10) if standpipe else r.uniform(10, cfg.mount_mm + 600)
            raw = [max(base + r.gauss(0, r.uniform(1, 40)) - (r.uniform(100, 500) if r.random() < 0.08 else 0), 0.0)
                   for _ in range(dsp.BURST_LEN)]
            temp, dt, vb = r.uniform(10, 18), r.choice([1 / 60, 0.5, 2.0, 3.0]), r.uniform(3.0, 4.2)
            fault, bench = r.random() < 0.05, r.random() < 0.4
            init = r.random() < 0.8
            ks = dsp.KalmanState(r.uniform(0, 3000), r.uniform(-20, 40), r.uniform(1, 500), r.uniform(-20, 20), r.uniform(1, 100), init)
            ks0 = (ks.h, ks.v, ks.p00, ks.p01, ks.p11, int(ks.initialized))
            res = dsp.run_cycle(cfg, ks, raw, temp, dt, fault, bench, standpipe, ph, vb)
            flags = sum(1 << k for k, nm in enumerate(("depth_mm", "dh_dt_mm_min", "cap_pct", "blind_zone", "below_range"))
                        if nm in res["saturated"])
            exp = [res["d_med_mm"], res["sigma_d2"], res["turbulence"], res["measured_depth_mm"], res["raw_depth_mm"],
                   res["depth_mm"], res["dh_dt_mm_min"], res["h_over_d"], res["he_m"], res["cap_pct"], res["anomaly_code"],
                   res["fsm_state"], res["wake_s"], res["uplink_s"], dsp.payload_hex(res["payload"]), flags,
                   ks.h, ks.v, ks.p00, ks.p01, ks.p11]
            line = "CYCLE %d %d %s %r %r %r %d %d %d %r %r %r %r %r %r %d" % (
                idx, len(raw), " ".join(repr(x) for x in raw), temp, dt, vb, int(fault), int(bench), int(standpipe), ph, *ks0)
            self.add(line, "CYCLE", exp)


def compare(kind: str, exp, got: str) -> bool:
    toks = got.split()
    if kind in ("PACK", "B64"):
        return got.strip() == exp
    if kind == "INTS":
        return [int(t) for t in toks] == exp
    if kind == "REALS":
        return len(toks) == len(exp) and all(close(float(t), e, 1e-9, 1e-9) for t, e in zip(toks, exp))
    if kind in ("MIXED", "CYCLE"):
        if len(toks) != len(exp):
            return False
        for t, e in zip(toks, exp):
            if isinstance(e, str):
                if t != e:
                    return False
            elif isinstance(e, bool) or isinstance(e, int):
                if int(float(t)) != int(e):
                    return False
            elif not close(float(t), float(e), 1e-9, 1e-8):
                return False
        return True
    return False


def run_vectors(exe: Path, vec: Vectors) -> None:
    proc = subprocess.run([str(exe), "--vectors"], input="\n".join(vec.lines) + "\n", capture_output=True, text=True, timeout=600)
    out = proc.stdout.splitlines()
    by_kind: dict[str, list[int]] = {}
    bad: list[str] = []
    for (kind, exp, line), got in zip(vec.expect, out):
        ok = compare(kind, exp, got)
        cmd = line.split()[0]
        stats = by_kind.setdefault(cmd, [0, 0])
        stats[0 if ok else 1] += 1
        if not ok and len(bad) < 5:
            bad.append(f"{line[:90]}...\n      py:  {exp}\n      cpp: {got}")
    complete = len(out) == len(vec.lines)
    for cmd, (ok, nok) in by_kind.items():
        record(f"C++ == Python: {cmd:<6} {ok:>5} vectors", nok == 0 and complete, f"{nok} mismatches" if nok else "")
    if bad:
        print("    first mismatches:\n    " + "\n    ".join(bad))


# ----------------------------------------------------------------------------- e2e
def e2e(edge_tx_line: str) -> None:
    from fastapi.testclient import TestClient
    from backend.main import app
    import serial_bridge
    frame = serial_bridge.parse_edge_tx(edge_tx_line)
    record("serial bridge parses [EDGE_TX] frame", frame is not None and frame.get("device_eui") == "EN-08")
    with TestClient(app) as client:
        r = client.post("/api/v1/ingest/lorawan", json=frame)
        record("POST /api/v1/ingest/lorawan accepts firmware frame", r.status_code == 200, r.text[:160])
        state = client.get("/api/v1/sensors/EN-08").json()
        record("EN-08 updated as HARDWARE with the firmware payload",
               state.get("origin") == "HARDWARE" and state.get("payload_hex") == frame["payload_hex"],
               f"{state.get('origin')} {state.get('payload_hex')} vs {frame['payload_hex']}")
        live = client.get("/api/v1/state").json()
        record("twin driven by hardware (mode HARDWARE)", live["mode"] == "HARDWARE" and live["hardware_override"]["sensor_id"] == "EN-08",
               f"mode {live['mode']}, rain {live['scenario']['rainfall_mm_hr']} mm/hr")
        client.post("/api/v1/scenario", json={"mode": "PLAYBACK"})


def python_edge_tx_line() -> str:
    """Fallback e2e frame produced by the Python mirror (identical JSON schema)."""
    import serial_bridge
    return serial_bridge.VirtualStandpipe("EN-08", water_cm=82.0, mode="surge", seed=1).next_line()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cxx", help='C++ compiler command, e.g. "g++" or "zig c++"')
    ap.add_argument("--keep", action="store_true", help="keep build directory")
    args = ap.parse_args()

    static_checks()
    cxx = find_compiler(args.cxx)
    native = cxx is not None
    tmp = Path(tempfile.mkdtemp(prefix="edge_core_"))
    line = None
    if native:
        print(f"Native build with: {' '.join(cxx)}")
        exe_d, exe_f = tmp / "edge_double.exe", tmp / "edge_float.exe"
        for exe, dbl in ((exe_d, True), (exe_f, False)):
            ok, log = build(cxx, exe, dbl)
            record(f"compile ({'double' if dbl else 'float/ESP32'}) -Wall -Wextra -Werror -fno-exceptions -fno-rtti", ok, log if not ok else "")
            if ok:
                st = subprocess.run([str(exe), "--selftest"], capture_output=True, text=True)
                record(f"--selftest ({'double' if dbl else 'float'})", st.returncode == 0, st.stdout.strip().splitlines()[-1] if st.stdout else st.stderr)
        if exe_d.exists():
            vec = Vectors()
            vec.build()
            run_vectors(exe_d, vec)
            surge_raw = " ".join(["160.0", "152.5", "171.2", "148.0", "158.3", "166.1", "149.4", "155.0", "163.7", "150.2"])
            cmd = f"EDGETX 7 10 {surge_raw} 14.2 0.016666666666666666 3.96 0 1 1 1000.0 980.0 45.0 50.0 3.0 20.0 1\n"
            out = subprocess.run([str(exe_d), "--vectors"], input=cmd, capture_output=True, text=True).stdout.strip()
            record("C++ format_edge_tx emits [EDGE_TX] JSON", out.startswith("[EDGE_TX] {") and json.loads(out[10:]).get("device_eui") == "EN-08", out[:100])
            line = out
            cpp = json.loads(out[len("[EDGE_TX] "):])
            vs = Vectors().rt.nodes["EN-08"].cfg
            ks = dsp.KalmanState(980.0, 45.0, 50.0, 3.0, 20.0, True)
            raw = [float(x) for x in surge_raw.split()]
            res = dsp.run_cycle(vs, ks, raw, 14.2, 1 / 60, False, True, True, 1000.0, 3.96)
            py = dsp.edge_tx_record(vs, raw, 14.2, 3.96, True, True, 1000.0, res, 1, "host-test")
            same_keys = set(cpp) == set(py)
            same_vals = all(cpp[k] == py[k] for k in ("device_eui", "device_eui_hex", "payload_hex", "payload_b64", "anomaly_class", "fsm_state", "saturated_fields"))
            record("[EDGE_TX] JSON schema: C++ == Python mirror", same_keys and same_vals,
                   f"keys only in C++: {sorted(set(cpp) - set(py))}, only in Python: {sorted(set(py) - set(cpp))}")
            ok_main, errs = True, ""
            for variant in ("-DLORAWAN_ENABLED=1", "-DBENCH_DEMO_MODE=1", '-DFW_VERSION="ci"'):
                proc = subprocess.run(cxx + ["-std=c++17", "-c", "-Wall", "-Wextra", "-Werror", f"-I{FW / 'test' / 'host_stubs'}",
                                             f"-I{FW / 'include'}", variant, str(FW / "src" / "main.cpp"), "-o", str(tmp / "main.o")],
                                      capture_output=True, text=True)
                if proc.returncode != 0:
                    ok_main = False
                    errs = " | ".join(ln for ln in proc.stderr.splitlines() if "main.cpp" in ln or "error" in ln)[:600]
            record("firmware src/main.cpp compiles against Arduino/RadioLib API stubs (3 variants, -Werror)", ok_main,
                   "" if ok_main else errs)
    else:
        print("No C++ compiler found (g++/clang++/c++/zig/$CXX). Running fallback verifier only.")
        record("fallback: Python reference golden vectors", dsp.pack_payload(5115, -1, 127, 7, 4.2) == 0xFFFFFFFF)
    print("End-to-end ingest")
    e2e(line or python_edge_tx_line())
    if not args.keep:
        shutil.rmtree(tmp, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    total = len(results)
    print("=" * 72)
    status = "PASS" if not failed else "FAIL"
    if not native and not failed:
        status = "PARTIAL (no native C++ compiler: static + Python fallback only)"
    print(f"Phase 5 firmware verification: {status} — {total - len(failed)}/{total} checks")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
