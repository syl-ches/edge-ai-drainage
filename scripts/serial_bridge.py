#!/usr/bin/env python3
"""USB-serial -> FastAPI bridge for the physical XIAO ESP32-S3 node (and a virtual standpipe).

Physical board (USB-C, 115200 baud, firmware prints `[EDGE_TX] {json}` every cycle):
    python scripts/serial_bridge.py                       # auto-detect the XIAO port
    python scripts/serial_bridge.py --port COM5           # or /dev/ttyACM0
    python scripts/serial_bridge.py --port COM5 --node EN-03 --bench   # also sends console commands

No hardware yet? Exercise the exact same workflow with the firmware-identical Python pipeline:
    python scripts/serial_bridge.py --virtual-standpipe                    # pour 0 -> 85 cm, then drain
    python scripts/serial_bridge.py --virtual-standpipe --water-cm 78 --mode surge
    python scripts/serial_bridge.py --virtual-standpipe --water-cm 60 --mode blockage --node EN-08

Frames are POSTed to http://localhost:8000/api/v1/ingest/lorawan over one keep-alive HTTP
connection (sub-10 ms forwarding on localhost); the live terminal dashboard shows raw vs
Kalman depth, the 32-bit word and the HTTP status.
"""
from __future__ import annotations

import argparse
import http.client
import json
import math
import random
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import edge_dsp as dsp  # noqa: E402

PREFIX = "[EDGE_TX] "
ESPRESSIF_VID = 0x303A
FW_VERSION = "virtual-1.0"


def parse_edge_tx(line: str) -> dict | None:
    """Extract the JSON object from one firmware console line, or None for other output."""
    i = line.find(PREFIX)
    if i < 0:
        return None
    try:
        obj = json.loads(line[i + len(PREFIX):].strip())
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) and "payload_hex" in obj and "device_eui" in obj else None


class Forwarder:
    """Persistent keep-alive HTTP POST to the ingest endpoint."""

    def __init__(self, url: str):
        u = urlparse(url)
        self.host, self.port, self.path = u.hostname or "localhost", u.port or 80, u.path or "/"
        self.conn: http.client.HTTPConnection | None = None

    def post(self, body: dict) -> tuple[int, float, dict]:
        data = json.dumps(body).encode()
        for attempt in range(2):
            try:
                if self.conn is None:
                    self.conn = http.client.HTTPConnection(self.host, self.port, timeout=2.0)
                t0 = time.perf_counter()
                self.conn.request("POST", self.path, body=data, headers={"Content-Type": "application/json"})
                resp = self.conn.getresponse()
                payload = resp.read()
                ms = (time.perf_counter() - t0) * 1000.0
                try:
                    parsed = json.loads(payload or b"{}")
                except json.JSONDecodeError:
                    parsed = {}
                return resp.status, ms, parsed
            except (OSError, http.client.HTTPException):
                self.conn = None
                if attempt:
                    return 0, 0.0, {}
        return 0, 0.0, {}


# ------------------------------------------------------------------------- virtual standpipe
class VirtualStandpipe:
    """A 1 m PVC standpipe with the A02YYUW in the top cap, run through the firmware pipeline."""

    def __init__(self, node: str = "EN-08", water_cm: float | None = None, mode: str = "fill",
                 pipe_height_mm: float = 1000.0, seed: int | None = None, hz: float = 1.0):
        from backend.twin import TwinRuntime
        rt = TwinRuntime()
        if node not in rt.nodes:
            raise SystemExit(f"unknown node {node}; choose EN-01..EN-10")
        self.cfg = rt.nodes[node].cfg
        self.mode, self.target, self.pipe = mode, water_cm, pipe_height_mm
        self.rng = random.Random(seed)
        self.kalman = dsp.KalmanState()
        self.dt_min = 1.0 / 60.0 / hz
        self.t = 0.0
        self.hz = hz
        self.seq = 0
        self.level_mm = 0.0

    def _level(self) -> float:
        if self.target is not None:
            goal = self.target * 10.0
            rate = 6.0 if self.mode == "fill" else 25.0           # mm per cycle: pour fast, then hold
            self.level_mm += max(min(goal - self.level_mm, rate), -rate)
            return self.level_mm
        period = 90.0                                            # fill 0 -> 85 cm in 60 s, drain in 30 s
        x = (self.t % period) / period
        self.level_mm = 850.0 * (x / (2 / 3) if x < 2 / 3 else (1 - x) / (1 / 3))
        return self.level_mm

    def next_line(self) -> str:
        self.seq += 1
        level = self._level()
        temp = 14.0 + 0.4 * math.sin(self.t / 30.0)
        if self.mode == "surge":
            chop, p_spike = 22.0, 0.12                           # turbulent pouring
        elif self.mode == "blockage":
            chop, p_spike = 1.0, 0.0                             # valve shut, water pooled flat
        else:
            chop, p_spike = 6.0, 0.02
        raw = []
        for k in range(dsp.BURST_LEN):
            d = self.pipe - level + chop * math.sin(self.t * 3.1 + k * 1.7) + self.rng.gauss(0.0, 1.5)
            if self.rng.random() < p_spike:
                d -= self.rng.uniform(80.0, 300.0)
            d = max(d, dsp.BLIND_ZONE_MM)
            raw.append(d * dsp.SPEED_OF_SOUND_REF / dsp.speed_of_sound(temp))
        res = dsp.run_cycle(self.cfg, self.kalman, raw, temp, self.dt_min, False, True, True, self.pipe)
        rec = dsp.edge_tx_record(self.cfg, raw, temp, self.cfg.vbat_v, True, True, self.pipe, res, self.seq, FW_VERSION)
        self.t += 1.0 / self.hz
        return PREFIX + json.dumps(rec, separators=(",", ":"))


# ------------------------------------------------------------------------- serial
def autodetect_port() -> str | None:
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    ports = list(list_ports.comports())
    for p in ports:
        if p.vid == ESPRESSIF_VID or any(k in (p.description or "") for k in ("XIAO", "ESP32", "USB JTAG")):
            return p.device
    return ports[0].device if len(ports) == 1 else None


def dashboard_row(frame: dict, status: int, ms: float, reply: dict) -> str:
    twin = reply.get("twin", {})
    return (f"{frame['device_eui']:<6} raw {frame['raw_unfiltered_depth_mm']:>7.1f} mm  "
            f"kalman {frame['kalman_filtered_depth_mm']:>7.1f} mm  dh/dt {frame['dh_dt_mm_min']:>6.1f}  "
            f"cap {frame['capacity_pct']:>5.1f}%  {frame['payload_hex']}  {frame['anomaly_class']:<14} "
            f"HTTP {status or '---'} {ms:5.1f} ms  twin {twin.get('mode', '-'):<8} "
            f"{twin.get('rainfall_mm_hr', float('nan')):>6.1f} mm/hr  {reply.get('fusion', '')}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", help="serial port (default: auto-detect XIAO ESP32-S3)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--url", default="http://localhost:8000/api/v1/ingest/lorawan")
    ap.add_argument("--node", default=None, help="NODE command to send / virtual node id (default EN-08)")
    ap.add_argument("--bench", action="store_true", help="send SCALE ON + BENCH ON to the board on connect")
    ap.add_argument("--virtual-standpipe", action="store_true", help="simulate the PVC rig instead of a board")
    ap.add_argument("--water-cm", type=float, default=None, help="virtual: hold this water level (cm)")
    ap.add_argument("--mode", choices=("fill", "surge", "blockage"), default="fill", help="virtual: pouring style")
    ap.add_argument("--hz", type=float, default=1.0, help="virtual: frames per second")
    ap.add_argument("--count", type=int, default=0, help="stop after N frames (0 = run until Ctrl+C)")
    ap.add_argument("--scope", choices=("single_node", "full_catchment"), default="full_catchment",
                    help="single_node: only this sensor follows the board; full_catchment: the board drives the whole twin")
    args = ap.parse_args()

    fwd = Forwarder(args.url)
    sent = 0
    print(f"Forwarding [EDGE_TX] frames -> {args.url}   (Ctrl+C to stop)")
    try:
        if args.virtual_standpipe:
            sim = VirtualStandpipe(args.node or "EN-08", args.water_cm, args.mode, hz=args.hz)
            while True:
                frame = parse_edge_tx(sim.next_line())
                status, ms, reply = fwd.post(dict(frame, scope=args.scope))
                print(dashboard_row(frame, status, ms, reply), flush=True)
                sent += 1
                if args.count and sent >= args.count:
                    break
                time.sleep(1.0 / args.hz)
            return 0

        try:
            import serial
        except ImportError:
            print("pyserial is required for a physical board: pip install pyserial")
            return 2
        port = args.port or autodetect_port()
        if not port:
            print("No XIAO ESP32-S3 serial port found. Pass --port COMx (or /dev/ttyACM0), or use --virtual-standpipe.")
            return 2
        with serial.Serial(port, args.baud, timeout=1) as ser:
            print(f"Connected to {port} @ {args.baud}")
            if args.node:
                ser.write(f"NODE {args.node}\n".encode())
            if args.bench:
                ser.write(b"SCALE ON\nBENCH ON\n")
            while True:
                line = ser.readline().decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                frame = parse_edge_tx(line)
                if frame is None:
                    print(f"  {line}")
                    continue
                status, ms, reply = fwd.post(dict(frame, scope=args.scope))
                print(dashboard_row(frame, status, ms, reply), flush=True)
                sent += 1
                if args.count and sent >= args.count:
                    break
    except KeyboardInterrupt:
        pass
    print(f"\n{sent} frames forwarded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
