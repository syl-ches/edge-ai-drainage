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
    GET  /api/v1/cctv/cameras        Command Center CCTV registry (placeholder inventory + stream config)
    GET  /api/v1/cctv/nearest/{id}   nearest camera pair for an Edge-AI node (EN-xx or device EUI)
    GET  /api/telemetry/history      persisted 32-bit frames (?node_id=EN-08&limit=500)
    POST /api/telemetry/ingest       persist live frames (decoded server-side, deduplicated)
    POST /api/telemetry/sd-backfill  bulk black-box recovery with CRC-32 check + batch log
    GET  /api/database/stats         rows, size, last sync, active engine (SQLite / PostgreSQL)
    GET/POST /api/incidents          dispatch ledger
    POST /api/alerts/dispatch        SMS + e-mail to MAYOR / CDRRMO / CEPMO / DPWH / custom (sandbox loopback without keys)
    GET  /api/alerts/audit-log       signed delivery ledger
    POST /api/v1/ingest/secure       sealed frame (Speck32/64 CTR + 32-bit tag); bad tag or replay -> 401, dropped
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

from . import cctv
from . import notifications
from .crypto import EdgeCipher
from .database import TelemetryDB, frame_row, utc_now
from . import edge_dsp as dsp
from .lut import DATA_DIR, TwinLut
from .schemas import (AlertDispatchRequest, DecodeRequest, SecureIngestRequest, DistanceIngestRequest, IncidentRequest, IngestRequest, LiveControlRequest, ScenarioRequest,
                      SdBackfillRequest, TelemetryIngestRequest)
from .twin import TwinRuntime

FRAME_HZ = float(os.environ.get("CITYCAMP_FRAME_HZ", "2"))   # 0 disables the background ticker
FRAME_PERIOD_S = 1.0 / FRAME_HZ if FRAME_HZ > 0 else 0.5

runtime = TwinRuntime(TwinLut())
# Phase 9C: telemetry persistence (SQLite file by default; CITYCAMP_DB_PATH overrides, DATABASE_URL for PostgreSQL).
db = TelemetryDB(os.environ.get("CITYCAMP_DB_PATH") or None)
edge_cipher = EdgeCipher()   # CITYCAMP_EDGE_PSK, else the public demo key
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


@app.get("/api/v1/cctv/cameras")
def cctv_cameras() -> dict:
    reg = cctv.load_registry()
    cams = cctv.cameras()
    return dict(meta=reg["meta"], cameras=cams, streams_configured=sum(1 for c in cams if c.get("stream")))


@app.get("/api/v1/cctv/nearest/{sensor_id}")
def cctv_nearest(sensor_id: str, k: int = 2) -> dict:
    sid = runtime.resolve_sensor(sensor_id)
    sensor_rec = runtime.sensors_meta.get(sid) if sid else None
    if sensor_rec is None:
        raise HTTPException(404, f"unknown sensor {sensor_id}")
    return dict(sensor_id=sid, feeds=cctv.nearest_cameras(sensor_rec, max(1, min(k, 6))))


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
    with contextlib.suppress(Exception):           # persistence never blocks the live path
        db.insert_frames([frame_row(sid, utc_now(), sensor_rec["payload_hex"], "LORAWAN", False)])
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
    with contextlib.suppress(Exception):           # persistence never blocks the live path
        db.insert_frames([frame_row(sid, utc_now(), rec["payload_hex"], "HARDWARE", False)])
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


# ---------------------------------------------------------------- Phase 9C telemetry database
@app.get("/api/telemetry/history")
def telemetry_history(node_id: str | None = None, limit: int = 500) -> dict:
    sid = runtime.resolve_sensor(node_id) if node_id else None
    if node_id and sid is None:
        raise HTTPException(404, f"unknown node {node_id}")
    return dict(node_id=sid, frames=db.history(sid, limit), engine=db.engine)


@app.post("/api/telemetry/ingest")
def telemetry_ingest(req: TelemetryIngestRequest) -> dict:
    rows = []
    for f in req.frames:
        sid = runtime.resolve_sensor(f.node_id)
        if sid is None:
            raise HTTPException(404, f"unknown node {f.node_id}")
        try:
            rows.append(frame_row(sid, f.timestamp_utc or utc_now(), f.payload_hex, f.source_mode, False))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    inserted = db.insert_frames(rows)
    return dict(status="ok", received=len(rows), inserted=inserted, duplicates=len(rows) - inserted)


@app.post("/api/telemetry/sd-backfill")
def telemetry_sd_backfill(req: SdBackfillRequest) -> dict:
    sid = runtime.resolve_sensor(req.node_id)
    if sid is None:
        raise HTTPException(404, f"unknown node {req.node_id}")
    batch = req.batch_id or f"SD-{sid}-{utc_now()}"
    try:
        res = db.sd_backfill(batch, sid, [f.model_dump() for f in req.frames], req.crc32)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return dict(status="ok" if res["integrity_crc_status"] != "FAIL" else "rejected", **res)


@app.get("/api/database/stats")
def database_stats() -> dict:
    return db.stats()


@app.get("/api/incidents")
def incidents(limit: int = 200) -> dict:
    return dict(incidents=db.incidents(limit))


@app.post("/api/incidents")
def incident_record(req: IncidentRequest) -> dict:
    db.record_incident(req.node_id, req.fusion_verdict, req.trash_rack_occlusion_pct, req.target_agency, req.action_summary)
    return dict(status="ok")


# ---------------------------------------------------------------- Phase 9D alerts + edge security
def _alert_context(req: AlertDispatchRequest) -> dict:
    sid = runtime.resolve_sensor(req.node_id)
    if sid is None:
        raise HTTPException(404, f"unknown node {req.node_id}")
    frame = runtime.latest or runtime.tick(FRAME_PERIOD_S)
    sen = frame["sensors"].get(sid, {})
    vision = frame["sensors"].get("EN-09", {}).get("capacity_pct")
    fc = frame.get("forecast") or {}
    eta = fc.get("time_to_overflow_min")
    if frame.get("lagoon", {}).get("is_overflowing"):
        eta = 0
    return dict(node_id=sid, severity=req.severity, cap_pct=float(sen.get("capacity_pct", 0.0)),
                dh_dt_cm_min=float(sen.get("dh_dt_mm_min", 0.0)) / 10.0, vision_pct=None if vision is None else float(vision),
                verdict=req.fusion_verdict or (frame.get("fusion") or {}).get("root_cause", "NOMINAL"), evac_lead_min=eta)


@app.post("/api/alerts/dispatch")
def alerts_dispatch(req: AlertDispatchRequest) -> dict:
    ctx = _alert_context(req)
    groups = ["MAYOR", "CDRRMO", "CEPMO", "DPWH"] if req.recipient_group == "ALL" else [req.recipient_group]
    results = []
    for g in groups:
        try:
            r = notifications.dispatch_alert(ctx, g, req.custom_phone if g in ("CUSTOM", req.recipient_group) else None,
                                             req.custom_email if g in ("CUSTOM", req.recipient_group) else None,
                                             req.attach_pdf_summary, utc_now(), auto=req.auto)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        db.record_alerts(r["ledger"])
        results.append(r)
    return dict(status="ok", delivery_mode="LIVE_GATEWAY" if any(r["delivery_mode"] == "LIVE_GATEWAY" for r in results) else "SANDBOX_VERIFIED_LOOPBACK",
                context=ctx, dispatches=results,
                gateways=dict(sms=notifications.sms_gateways(), email=notifications.email_gateways()))


@app.get("/api/alerts/audit-log")
def alerts_audit_log(limit: int = 200) -> dict:
    return dict(ledger=db.alerts(limit))


@app.post("/api/v1/ingest/secure")
def ingest_secure(req: SecureIngestRequest) -> dict:
    sid = runtime.resolve_sensor(req.device_eui)
    if sid is None:
        raise HTTPException(404, f"unknown device {req.device_eui}")
    v = edge_cipher.decrypt_and_verify(req.cipher_hex, req.tag_hex, req.nonce, sid)
    if not v["verified"]:
        raise HTTPException(401, dict(security_alert="INVALID EDGE SIGNATURE — PACKET DROPPED", reason=v["reason"], device=sid, nonce=req.nonce))
    word = int(v["plain_hex"], 16)
    sensor_rec = runtime.ingest(sid, word, {}, None, None, scope=req.scope)
    with contextlib.suppress(Exception):
        db.insert_frames([frame_row(sid, utc_now(), sensor_rec["payload_hex"], "LORAWAN", False)])
    return dict(status="ok", sensor_id=sid, verified=True, plain_hex=v["plain_hex"], latency_us=v["latency_us"], decoded=dsp.unpack_payload(word))
