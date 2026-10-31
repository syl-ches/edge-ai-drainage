"""Nearest Command Center CCTV resolver (Phase 9B).

The twin does not install cameras: when an Edge-AI node reports rising water it looks up the
nearest existing Command Center feeds for that drainage sector. Mirrors src/utils/cctvStreams.ts
(locked by tests/frontend/fixtures/cctv_golden.json).

Camera records come from public/data/cctv_cameras.json (placeholder inventory, see
scripts/gen_cctv_registry.py). Real stream URLs are never committed: set them at runtime with
CITYCAMP_CCTV_STREAMS='{"CAM-CCL-A": "https://vms-gateway.local/hls/ccl-a.m3u8", ...}'.
Browsers cannot play RTSP, so point these at the VMS's HLS / WebRTC gateway (e.g. MediaMTX).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .lut import haversine_m

DATA_DIR = Path(__file__).resolve().parents[1] / "public" / "data"


def load_registry() -> dict:
    return json.loads((DATA_DIR / "cctv_cameras.json").read_text(encoding="utf-8"))


def stream_overrides() -> dict[str, str]:
    raw = os.environ.get("CITYCAMP_CCTV_STREAMS", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, str) and v}


def cameras() -> list[dict]:
    over = stream_overrides()
    out = []
    for c in load_registry()["cameras"]:
        if not c.get("is_active", True):
            continue
        c = dict(c)
        if c["camera_id"] in over:
            url = over[c["camera_id"]]
            c["stream"] = dict(protocol="hls" if url.endswith(".m3u8") else "http", url=url)
        out.append(c)
    return out


def nearest_cameras(sensor: dict, k: int = 2, cams: list[dict] | None = None) -> list[dict]:
    """The k nearest active cameras to a sensor's surface position, nearest first."""
    pts = cams if cams is not None else cameras()
    p = (sensor["coordinates"][0], sensor["coordinates"][1])
    ranked = sorted(
        ((round(haversine_m(p, (c["lon"], c["lat"])), 1), c["camera_id"], c) for c in pts),
        key=lambda t: (t[0], t[1]),
    )
    radius = load_registry()["meta"]["coverage_radius_m"]
    return [dict(camera=c, distance_m=d, in_coverage=d <= radius) for d, _, c in ranked[:k]]


def nearest_for_all(sensors: list[dict], k: int = 2) -> dict[str, list[dict]]:
    cams = cameras()
    return {
        s["sensor_id"]: [dict(camera_id=r["camera"]["camera_id"], distance_m=r["distance_m"], in_coverage=r["in_coverage"])
                         for r in nearest_cameras(s, k, cams)]
        for s in sensors if s.get("is_active", True)
    }
