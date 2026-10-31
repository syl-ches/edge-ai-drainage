"""Telemetry persistence (Phase 9C): SQLite by default, PostgreSQL when DATABASE_URL asks for it.

    backend/data/baguio_flood_telemetry.db   (created on first use; schema migrated on startup)

Tables
    telemetry_frames     one 32-bit uplink per row, deduplicated on (node_id, timestamp_utc, raw_hex_payload)
    incident_dispatches  operator / fusion dispatch ledger
    sd_sync_batches      SD-card / flash black-box backfills (frames recovered, CRC verdict)

Every row stores the raw 4-byte payload; depth, dh/dt, capacity, anomaly and battery are the §10
decode of that payload (not trusted from the client), so the database always agrees with the
telemetry contract. DATABASE_URL=postgresql://... is used only when psycopg (v3) is installed;
otherwise the engine logs why and stays on SQLite (stats report it).
"""
from __future__ import annotations

import os
import sqlite3
import threading
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from . import edge_dsp as dsp

DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_PATH = DATA_DIR / "baguio_flood_telemetry.db"

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS telemetry_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL,
        timestamp_utc TEXT NOT NULL,
        raw_hex_payload TEXT NOT NULL,
        depth_cm REAL NOT NULL,
        dh_dt_cm_min REAL NOT NULL,
        capacity_pct REAL NOT NULL,
        anomaly_code INTEGER NOT NULL,
        battery_v REAL NOT NULL,
        source_mode TEXT NOT NULL,
        sd_recovered_flag INTEGER NOT NULL DEFAULT 0,
        UNIQUE (node_id, timestamp_utc, raw_hex_payload)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_frames_node_time ON telemetry_frames (node_id, timestamp_utc)",
    """CREATE TABLE IF NOT EXISTS incident_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_utc TEXT NOT NULL,
        node_id TEXT NOT NULL,
        fusion_verdict TEXT NOT NULL,
        trash_rack_occlusion_pct REAL NOT NULL,
        target_agency TEXT NOT NULL,
        action_summary TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS alert_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_utc TEXT NOT NULL,
        message_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        recipient_group TEXT NOT NULL,
        recipient TEXT NOT NULL,
        severity TEXT NOT NULL,
        node_id TEXT NOT NULL,
        fusion_verdict TEXT NOT NULL,
        delivery_mode TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        info TEXT NOT NULL,
        body TEXT NOT NULL,
        signature TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS sd_sync_batches (
        batch_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        frames_recovered INTEGER NOT NULL,
        start_timestamp TEXT,
        end_timestamp TEXT,
        integrity_crc_status TEXT NOT NULL
    )""",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def normalise_hex(h: str) -> str:
    s = h.strip().lower().removeprefix("0x")
    if len(s) != 8 or any(c not in "0123456789abcdef" for c in s):
        raise ValueError(f"payload must be 4 bytes of hex, got {h!r}")
    return "0x" + s.upper()


def frame_row(node_id: str, timestamp_utc: str, payload_hex: str, source_mode: str, sd_recovered: bool) -> dict:
    """Decode a 32-bit frame (§10) into the telemetry_frames columns."""
    hx = normalise_hex(payload_hex)
    d = dsp.unpack_payload(int(hx, 16))
    return dict(
        node_id=node_id, timestamp_utc=timestamp_utc, raw_hex_payload=hx,
        depth_cm=d["depth_mm"] / 10.0, dh_dt_cm_min=d["dh_dt_mm_min"] / 10.0, capacity_pct=float(d["cap_pct"]),
        anomaly_code=int(d["anom_code"]), battery_v=float(d["vbat_v"]), source_mode=source_mode,
        sd_recovered_flag=1 if sd_recovered else 0,
    )


def crc32_frames(hexes: Iterable[str]) -> str:
    """CRC-32 over the frames' big-endian bytes, in order (matches the firmware dump trailer)."""
    crc = 0
    for h in hexes:
        crc = zlib.crc32(int(normalise_hex(h), 16).to_bytes(4, "big"), crc)
    return f"{crc & 0xFFFFFFFF:08X}"


class TelemetryDB:
    """Thread-safe handle; one connection per process (FastAPI runs handlers in a threadpool)."""

    def __init__(self, path: str | os.PathLike | None = None, url: str | None = None) -> None:
        self.lock = threading.Lock()
        self.note = ""
        url = url if url is not None else os.environ.get("DATABASE_URL", "")
        self.engine = "sqlite"
        self.pg = None
        if url.startswith(("postgres://", "postgresql://")):
            try:
                import psycopg  # type: ignore

                self.pg = psycopg.connect(url, autocommit=True)
                self.engine = "postgresql"
            except Exception as exc:  # psycopg missing or server unreachable: stay on SQLite
                self.note = f"DATABASE_URL set but PostgreSQL unavailable ({type(exc).__name__}); using SQLite"
        self.path = Path(path) if path is not None else DEFAULT_PATH
        if self.pg is None:
            if str(self.path) != ":memory:":
                self.path.parent.mkdir(parents=True, exist_ok=True)
            self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
            self.conn.execute("PRAGMA journal_mode=WAL") if str(self.path) != ":memory:" else None
        self.migrate()

    # ---------------------------------------------------------------- plumbing
    def _sql(self, q: str) -> str:
        if self.pg is None:
            return q
        q = q.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY").replace("?", "%s")
        return q.replace("INSERT OR IGNORE", "INSERT")

    def _exec(self, q: str, args: tuple = (), many: list[tuple] | None = None, fetch: bool = False) -> Any:
        with self.lock:
            if self.pg is not None:
                with self.pg.cursor() as cur:
                    sql = self._sql(q)
                    if sql.startswith("INSERT") and "telemetry_frames" in sql and "ON CONFLICT" not in sql:
                        sql += " ON CONFLICT DO NOTHING"
                    if many is not None:
                        cur.executemany(sql, many)
                        return cur.rowcount
                    cur.execute(sql, args)
                    return cur.fetchall() if fetch else cur.rowcount
            cur = self.conn.cursor()
            if many is not None:
                before = self.conn.total_changes
                cur.executemany(q, many)
                self.conn.commit()
                return self.conn.total_changes - before
            cur.execute(q, args)
            self.conn.commit()
            return cur.fetchall() if fetch else cur.rowcount

    def migrate(self) -> None:
        for stmt in SCHEMA:
            self._exec(stmt)

    # ---------------------------------------------------------------- telemetry
    def insert_frames(self, rows: list[dict]) -> int:
        """Insert decoded frames; duplicates (same node, time and payload) are ignored. Returns rows added."""
        cols = ("node_id", "timestamp_utc", "raw_hex_payload", "depth_cm", "dh_dt_cm_min", "capacity_pct",
                "anomaly_code", "battery_v", "source_mode", "sd_recovered_flag")
        q = f"INSERT OR IGNORE INTO telemetry_frames ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})"
        return int(self._exec(q, many=[tuple(r[c] for c in cols) for r in rows]) or 0)

    def history(self, node_id: str | None, limit: int = 500) -> list[dict]:
        limit = max(1, min(int(limit), 5000))
        cols = ("id", "node_id", "timestamp_utc", "raw_hex_payload", "depth_cm", "dh_dt_cm_min", "capacity_pct",
                "anomaly_code", "battery_v", "source_mode", "sd_recovered_flag")
        where = "WHERE node_id = ?" if node_id else ""
        q = f"SELECT {', '.join(cols)} FROM telemetry_frames {where} ORDER BY timestamp_utc DESC, id DESC LIMIT ?"
        rows = self._exec(q, ((node_id, limit) if node_id else (limit,)), fetch=True)
        out = [dict(zip(cols, r)) for r in rows]
        for r in out:
            r["sd_recovered_flag"] = bool(r["sd_recovered_flag"])
        return list(reversed(out))

    # ---------------------------------------------------------------- incidents + SD batches
    def record_incident(self, node_id: str, fusion_verdict: str, occlusion_pct: float, agency: str, summary: str,
                        timestamp_utc: str | None = None) -> None:
        self._exec("INSERT INTO incident_dispatches (timestamp_utc, node_id, fusion_verdict, trash_rack_occlusion_pct, "
                   "target_agency, action_summary) VALUES (?, ?, ?, ?, ?, ?)",
                   (timestamp_utc or utc_now(), node_id, fusion_verdict, float(occlusion_pct), agency, summary))

    def incidents(self, limit: int = 200) -> list[dict]:
        cols = ("id", "timestamp_utc", "node_id", "fusion_verdict", "trash_rack_occlusion_pct", "target_agency", "action_summary")
        rows = self._exec(f"SELECT {', '.join(cols)} FROM incident_dispatches ORDER BY id DESC LIMIT ?", (max(1, min(limit, 2000)),), fetch=True)
        return [dict(zip(cols, r)) for r in rows]

    def sd_backfill(self, batch_id: str, node_id: str, frames: list[dict], crc32: str | None) -> dict:
        """Bulk-insert recovered black-box frames (deduplicated) and log the batch with its CRC verdict."""
        rows = [frame_row(node_id, f["timestamp_utc"], f["payload_hex"], f.get("source_mode", "SD_BACKFILL"), True) for f in frames]
        computed = crc32_frames(f["payload_hex"] for f in frames) if frames else "00000000"
        status = "NO_CRC_SUPPLIED" if not crc32 else ("PASS" if crc32.upper().removeprefix("0X") == computed else "FAIL")
        inserted = self.insert_frames(rows) if status != "FAIL" else 0
        ts = sorted(r["timestamp_utc"] for r in rows)
        self._exec("INSERT OR IGNORE INTO sd_sync_batches (batch_id, node_id, uploaded_at, frames_recovered, start_timestamp, "
                   "end_timestamp, integrity_crc_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (batch_id, node_id, utc_now(), inserted, ts[0] if ts else None, ts[-1] if ts else None, status))
        return dict(batch_id=batch_id, received=len(rows), inserted=inserted, duplicates=len(rows) - inserted if status != "FAIL" else 0,
                    crc32=computed, integrity_crc_status=status)

    # ---------------------------------------------------------------- alert ledger (Phase 9D)
    ALERT_COLS = ("timestamp_utc", "message_id", "channel", "recipient_group", "recipient", "severity", "node_id",
                  "fusion_verdict", "delivery_mode", "provider", "status", "info", "body", "signature")

    def record_alerts(self, rows: list[dict]) -> None:
        cols = self.ALERT_COLS
        self._exec(f"INSERT INTO alert_dispatches ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                   many=[tuple(r[c] for c in cols) for r in rows])

    def alerts(self, limit: int = 200) -> list[dict]:
        cols = ("id",) + self.ALERT_COLS
        rows = self._exec(f"SELECT {', '.join(cols)} FROM alert_dispatches ORDER BY id DESC LIMIT ?", (max(1, min(limit, 2000)),), fetch=True)
        return [dict(zip(cols, r)) for r in rows]

    def stats(self) -> dict:
        count = lambda t: int(self._exec(f"SELECT COUNT(*) FROM {t}", fetch=True)[0][0])  # noqa: E731
        last = self._exec("SELECT MAX(timestamp_utc) FROM telemetry_frames", fetch=True)[0][0]
        last_sync = self._exec("SELECT MAX(uploaded_at) FROM sd_sync_batches", fetch=True)[0][0]
        size = None
        if self.pg is None and str(self.path) != ":memory:" and self.path.exists():
            size = self.path.stat().st_size + sum(p.stat().st_size for p in self.path.parent.glob(self.path.name + "-*"))
        return dict(engine=self.engine, note=self.note or None, path=None if self.pg else str(self.path),
                    telemetry_frames=count("telemetry_frames"), incident_dispatches=count("incident_dispatches"),
                    sd_sync_batches=count("sd_sync_batches"), size_bytes=size, last_frame_utc=last, last_sd_sync_utc=last_sync)
