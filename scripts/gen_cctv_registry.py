#!/usr/bin/env python3
"""Command Center CCTV camera registry for the nearest-feed resolver (Phase 9B).

    python scripts/gen_cctv_registry.py           # (re)write public/data/cctv_cameras.json
    python scripts/gen_cctv_registry.py --check   # exit 1 if the committed registry is stale

The platform is middleware over the Baguio Smart City Command Center / CDRRMO video management
system: it does not install cameras, it resolves each Edge-AI node to the nearest existing feeds.
The real camera inventory is not public, so every record here is a PLACEHOLDER (source_type
SYNTHETIC_OSMNX, stream null) to be replaced by the Command Center's registry (hot-swap rule,
CLAUDE.md §2.6: insert the official record, set the placeholder's is_active false).

The two City Camp Lagoon cameras are posed in the intake-compound frame of src/intake/compound.ts
(x across the channel, y downstream along the lagoon rim, z = 0 at the 1428.0 m sill; the rack toe
is the EN-08 / EN-09 mount). The CCTV replay renderer uses `local_pose`, the resolver uses lon/lat.
Deterministic: no RNG, no network, no timestamps.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
OUT = DATA / "cctv_cameras.json"
R_EARTH = 6371008.8
SILL_ASL = 1428.0


def _offset(lon: float, lat: float, east: float, north: float) -> tuple[float, float]:
    dlat = math.degrees(north / R_EARTH)
    dlon = math.degrees(east / (R_EARTH * math.cos(math.radians(lat))))
    return round(lon + dlon, 7), round(lat + dlat, 7)


def _heading(east: float, north: float) -> float:
    return round((math.degrees(math.atan2(east, north)) + 360.0) % 360.0, 1)


def build() -> dict:
    net = json.loads((DATA / "city_camp_network.json").read_text(encoding="utf-8"))
    a = net["meta"]["anchor"]
    rack = net["orifices"][0]["coordinates"]
    # Compound axes (src/three/layers/intake.ts::intakeAxes): right = outward from the bowl,
    # fwd = outward rotated +90 degrees (the channel runs along the lagoon rim).
    rx = math.radians(rack[0] - a["lon"]) * R_EARTH * math.cos(math.radians(a["lat"]))
    ry = math.radians(rack[1] - a["lat"]) * R_EARTH
    k = math.hypot(rx, ry)
    out = (rx / k, ry / k)
    fwd = (-out[1], out[0])

    def world(x: float, y: float) -> tuple[float, float]:
        return x * out[0] + y * fwd[0], x * out[1] + y * fwd[1]

    def lagoon_cam(cid, name, sector, pos, target, fov):
        e, n = world(pos[0], pos[1])
        lon, lat = _offset(rack[0], rack[1], e, n)
        te, tn = world(target[0] - pos[0], target[1] - pos[1])
        horiz = math.hypot(target[0] - pos[0], target[1] - pos[1])
        return dict(
            camera_id=cid, name=name, osd_label=name, sector=sector, vms="BAGUIO_SMART_CITY_COMMAND_CENTER",
            lon=lon, lat=lat, elev_m=round(SILL_ASL + pos[2], 2), heading_deg=_heading(te, tn),
            pitch_deg=round(math.degrees(math.atan2(target[2] - pos[2], horiz)), 1), fov_deg=fov,
            scene=cid.split("-", 1)[1].replace("-", "_"), local_pose=dict(position=list(pos), target=list(target)),
            stream=None, registry_status="PLACEHOLDER", source_type="SYNTHETIC_OSMNX", is_active=True,
        )

    cams = [
        # Pole on the lagoon-side walkway 12.0 m from the screen toe, looking down the channel at the
        # sloped bar screen, its cage, the transverse weir and the staff gauge on the outer wall.
        lagoon_cam("CAM-CCL-A", "City Camp Lagoon A", "Intake & trash-rack channel",
                   (-3.75, -11.4, 7.2), (1.0, -2.5, 1.0), 78),
        # Mast on the lagoon-side walkway looking across the channel at the side-drain outfall, the
        # wet access road, the green covered court and the red-roofed station.
        lagoon_cam("CAM-CCL-B", "City Camp Lagoon B", "Covered court & access road approach",
                   (-3.9, -24.0, 9.0), (17.0, -9.0, 5.0), 72),
    ]
    # Street cameras near the other nodes (placeholders: deterministic offsets from the mount).
    street = [
        ("CAM-GSF-01", "Guisad Surong slope", "EN-01"),
        ("CAM-URQ-01", "Upper Rock Quarry rd", "EN-02"),
        ("CAM-LGD-01", "Legarda Rd outlet", "EN-03"),
        ("CAM-DHR-01", "Dominican Hill Rd", "EN-04"),
        ("CAM-KSD-01", "Kisad Rd", "EN-05"),
        ("CAM-QOP-01", "Queen of Peace Rd outlet", "EN-06"),
        ("CAM-ASN-01", "Asin Rd tunnel corridor", "EN-10"),
    ]
    sensors = {s["sensor_id"]: s for s in net["sensors"]}
    for i, (cid, name, sid) in enumerate(street):
        s = sensors[sid]
        ang = math.radians(40.0 + 97.0 * i)
        dist = 22.0 + 6.0 * (i % 3)
        lon, lat = _offset(s["coordinates"][0], s["coordinates"][1], dist * math.sin(ang), dist * math.cos(ang))
        cams.append(dict(
            camera_id=cid, name=name, osd_label=name, sector=f"{s['name']} street corridor", vms="BAGUIO_SMART_CITY_COMMAND_CENTER",
            lon=lon, lat=lat, elev_m=round(s["coordinates"][2] + 6.0, 2), heading_deg=_heading(-math.sin(ang), -math.cos(ang)),
            pitch_deg=-25.0, fov_deg=70, scene=None, local_pose=None, stream=None,
            registry_status="PLACEHOLDER", source_type="SYNTHETIC_OSMNX", is_active=True,
        ))
    return dict(
        meta=dict(
            schema_version=1,
            vms="Baguio Smart City Command Center / CDRRMO VMS (RTSP / ONVIF via an HLS or WebRTC gateway)",
            coverage_radius_m=250.0,
            disclaimer=("Placeholder camera inventory. Positions are illustrative, streams are not configured. "
                        "Replace with the Command Center registry before operational use."),
        ),
        cameras=cams,
    )


def main() -> int:
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        ok = OUT.exists() and OUT.read_text(encoding="utf-8") == text
        print("cctv_cameras.json", "up to date" if ok else "STALE")
        return 0 if ok else 1
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
