"""FastAPI live backend for the City Camp Lagoon digital twin.

Run (no Docker needed):
    uvicorn backend.main:app --host 0.0.0.0 --port 8000

Endpoints
    WS   /ws/live                    TwinFrame JSON broadcast at FRAME_HZ (default 2 Hz)
    GET  /api/v1/health
    GET  /api/v1/state               latest TwinFrame
    GET  /api/v1/network             city_camp_network.json
    GET  /api/v1/lut/meta            LUT axes + metadata
    GET  /api/v1/sensors/{id}        latest telemetry for one Edge-AI node
    POST /api/v1/scenario            {"mode": "PLAYBACK"|"SCENARIO", "rainfall_mm_hr", "trash_rack_blockage_pct"}
    GET  /api/v1/live/control        precipitation source + historical storm library
    POST /api/v1/live/control        {"precip_source": "LIVE_FEED"|"HISTORICAL"|"TWIN", "storm_id", ...}
    GET  /api/v1/forecast            ST-GNN +15/+30/+60 min forecast (also in every WS frame)
    POST /api/v1/ingest/lorawan      physical uplink (direct JSON, base64 or TTS v3 webhook;
                                     "scope": "single_node" | "full_catchment")
    POST /api/v1/ingest/distance     bench / aquarium rig: {"device_eui", "dist_mm" | "fill_pct",
                                     "tank_height_mm", "scope" (default single_node)} or payload_hex
    POST /api/v1/decode              decode a 4-byte payload
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import edge_dsp as dsp
from .lut import DATA_DIR, TwinLut
from .schemas import DecodeRequest, DistanceIngestRequest, IngestRequest, LiveControlRequest, ScenarioRequest
from .twin import TwinRuntime

FRAME_HZ = float(os.environ.get("CITYCAMP_FRAME_HZ", "2"))   # 0 disables the background ticker
FRAME_PERIOD_S = 1.0 / FRAME_HZ if FRAME_HZ > 0 else 0.5

runtime = TwinRuntime(TwinLut())
clients: set[WebSocket] = set()


async def _broadcast(text: str) -> None:
    dead = []
    for ws in list(clients):
        try:
            await ws.send_text(text)
        except Exception:  # client went away mid-send
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def _ticker() -> None:
    period = FRAME_PERIOD_S
    loop = asyncio.get_running_loop()
    next_t = loop.time()
    while True:
        frame = runtime.tick(period)
        if clients:
            await _broadcast(json.dumps(frame, separators=(",", ":")))
        next_t += period
        await asyncio.sleep(max(0.0, next_t - loop.time()))


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.tick(FRAME_PERIOD_S)   # a frame exists before the first client connects
    task = asyncio.create_task(_ticker()) if FRAME_HZ > 0 else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="City Camp Lagoon Digital Twin — Live Backend", version="0.7.0", lifespan=lifespan)
# Prototype deployment: the PWA is opened from phones on the venue LAN via QR, so allow all origins.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/v1/health")
def health() -> dict:
    return dict(status="ok", frame_hz=FRAME_HZ, seq=runtime.seq, mode=runtime.mode, clients=len(clients),
                sensors=len(runtime.nodes), gateway=runtime.gateway, precip_source=runtime.precip_source,
                storm_id=runtime.storm_id)


@app.get("/api/v1/state")
def state() -> dict:
    if runtime.latest is None or (runtime.dirty and FRAME_HZ <= 0):
        return runtime.tick(0.0 if runtime.latest else FRAME_PERIOD_S)
    return runtime.latest


@app.get("/api/v1/network")
def network() -> FileResponse:
    return FileResponse(DATA_DIR / "city_camp_network.json", media_type="application/json")


@app.get("/api/v1/lut/meta")
def lut_meta() -> dict:
    return dict(meta=runtime.lut.lut["meta"], axes=runtime.lut.lut["axes"])


@app.get("/api/v1/sensors/{sensor_id}")
def sensor(sensor_id: str) -> dict:
    sid = runtime.resolve_sensor(sensor_id)
    if sid is None:
        raise HTTPException(404, f"unknown sensor {sensor_id}")
    if sid in runtime.hardware:                                # freshest physical uplink, no frame wait
        return runtime.hardware[sid].sensor
    frame = runtime.latest or runtime.tick(FRAME_PERIOD_S)
    return frame["sensors"][sid]


@app.post("/api/v1/scenario")
def set_scenario(req: ScenarioRequest) -> dict:
    runtime.set_scenario(req.mode, req.rainfall_mm_hr, req.trash_rack_blockage_pct)
    return dict(mode=runtime.mode, rainfall_mm_hr=runtime.fixed_rain, trash_rack_blockage_pct=runtime.fixed_clog)


@app.get("/api/v1/live/control")
def live_control_state() -> dict:
    return runtime.control_state()


@app.post("/api/v1/live/control")
def live_control(req: LiveControlRequest) -> dict:
    try:
        return runtime.set_control(req.precip_source, req.storm_id, req.rainfall_mm_hr, req.trash_rack_blockage_pct)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/v1/forecast")
def forecast() -> dict:
    if runtime.latest is None or (runtime.dirty and FRAME_HZ <= 0):
        runtime.tick(0.0 if runtime.latest else FRAME_PERIOD_S)
    return runtime.latest["forecast"]


@app.post("/api/v1/decode")
def decode(req: DecodeRequest) -> dict:
    raw = req.payload_hex or req.payload_b64
    if not raw:
        raise HTTPException(422, "payload_hex or payload_b64 required")
    try:
        word = dsp.parse_payload(raw)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return dict(payload_hex=dsp.payload_hex(word), payload_b64=dsp.payload_b64(word), **dsp.unpack_payload(word))


@app.post("/api/v1/ingest/lorawan")
def ingest(req: IngestRequest) -> dict:
    extras = req.model_extra or {}
    ident = req.sensor_id or req.device_eui
    raw = req.payload_hex or req.payload_b64
    rssi = snr = None
    if req.end_device_ids or req.uplink_message:              # The Things Stack v3 webhook
        ident = ident or (req.end_device_ids or {}).get("dev_eui") or (req.end_device_ids or {}).get("device_id")
        up = req.uplink_message or {}
        raw = raw or up.get("frm_payload")
        meta = (up.get("rx_metadata") or [{}])[0]
        rssi, snr = meta.get("rssi"), meta.get("snr")
    sid = runtime.resolve_sensor(ident)
    if sid is None:
        raise HTTPException(404, f"unknown device {ident!r}")
    if not raw:
        raise HTTPException(422, "payload_hex, payload_b64 or uplink_message.frm_payload required")
    try:
        word = dsp.parse_payload(raw)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    sensor_rec = runtime.ingest(sid, word, extras, rssi, snr, scope=req.scope)
    # Fast path (< 10 ms bridge budget): the background ticker broadcasts the full frame; here we
    # only report how the uplink drives the twin and the last fusion verdict.
    last = runtime.latest or {}
    return dict(status="ok", sensor_id=sid, scope=req.scope, decoded=dsp.unpack_payload(word),
                payload_hex=sensor_rec["payload_hex"], twin=runtime.drive_preview(),
                fusion=(last.get("fusion") or {}).get("root_cause"))


@app.post("/api/v1/ingest/distance")
def ingest_distance(req: DistanceIngestRequest) -> dict:
    ident = req.sensor_id or req.device_eui
    sid = runtime.resolve_sensor(ident)
    if sid is None:
        raise HTTPException(404, f"unknown device {ident!r}")
    extras = dict(req.model_extra or {})
    for k in ("dist_mm", "fill_pct", "tank_height_mm"):
        if getattr(req, k) is not None:
            extras[k] = getattr(req, k)
    raw = req.payload_hex or req.payload_b64
    if raw:                                                   # the board already ran the edge pipeline
        try:
            word = dsp.parse_payload(raw)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        rec = runtime.ingest(sid, word, dict(extras, temperature_c=req.temperature_c), None, None, scope=req.scope)
        out = dict(fill_pct=req.fill_pct, dist_mm=req.dist_mm, anomaly_class=rec["anomaly_class"], sensor=rec)
    else:
        try:
            out = runtime.ingest_distance(sid, req.dist_mm, req.fill_pct, req.tank_height_mm, req.temperature_c,
                                          extras, scope=req.scope)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    rec = out["sensor"]
    return dict(status="ok", sensor_id=sid, scope=req.scope, payload_hex=rec["payload_hex"],
                decoded=dsp.unpack_payload(rec["payload_uint32"]), fill_pct=out["fill_pct"], dist_mm=out["dist_mm"],
                anomaly_class=out["anomaly_class"], capacity_pct=rec["capacity_pct"], twin=runtime.drive_preview())


@app.websocket("/ws/live")
async def live(ws: WebSocket) -> None:
    await ws.accept()
    clients.add(ws)
    try:
        if runtime.latest:
            await ws.send_text(json.dumps(runtime.latest, separators=(",", ":")))
        while True:
            msg = await ws.receive_text()            # optional client control messages
            with contextlib.suppress(Exception):
                data = json.loads(msg)
                if data.get("type") == "scenario":
                    runtime.set_scenario(data.get("mode", "SCENARIO"), data.get("rainfall_mm_hr"),
                                         data.get("trash_rack_blockage_pct"))
                elif data.get("type") == "control":
                    runtime.set_control(data["precip_source"], data.get("storm_id"), data.get("rainfall_mm_hr"),
                                        data.get("trash_rack_blockage_pct"))
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)
