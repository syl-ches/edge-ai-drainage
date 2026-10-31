// Hybrid telemetry persistence (Phase 9C): browser IndexedDB (`BaguioFloodDB_v1`) mirrored to the
// FastAPI SQLite database (backend/database.py) whenever the backend answers.
//
// - Every frame is the raw 32-bit payload plus its §10 decode (decoded here, never trusted from a
//   caller), deduplicated on node + timestamp + payload, exactly like the SQLite UNIQUE key.
// - Reads prefer the backend and fall back to IndexedDB, so a phone opened from the QR code with no
//   backend still has history.
// - First boot seeds 24 h of **synthetic** storm telemetry (source_mode SYNTHETIC_SEED) from the
//   LUT so the charts are not empty; the seed is labelled as such everywhere it is shown.
import type { TwinData } from '../data/loadTwin';
import { LutInterpolator } from './lutInterpolator';
import { unpackTelemetryPayload } from './payloadCodec';

export const DB_NAME = 'BaguioFloodDB_v1';
export const SEED_HOURS = 24;
export const SEED_STEP_MIN = 10;

export type SourceMode = 'LIVE' | 'LORAWAN' | 'HARDWARE' | 'SD_BACKFILL' | 'SYNTHETIC_SEED' | 'SIMULATION';

export interface FrameRecord {
  key: string;
  node_id: string;
  timestamp_utc: string;
  raw_hex_payload: string;
  depth_cm: number;
  dh_dt_cm_min: number;
  capacity_pct: number;
  anomaly_code: number;
  battery_v: number;
  source_mode: SourceMode;
  sd_recovered_flag: boolean;
}

export interface SdBatchRecord {
  batch_id: string;
  node_id: string;
  uploaded_at: string;
  frames_recovered: number;
  start_timestamp: string | null;
  end_timestamp: string | null;
  integrity_crc_status: 'PASS' | 'FAIL' | 'NO_CRC_SUPPLIED';
}

export interface IncidentRecord {
  id?: number;
  timestamp_utc: string;
  node_id: string;
  fusion_verdict: string;
  trash_rack_occlusion_pct: number;
  target_agency: string;
  action_summary: string;
}

export function normaliseHex(h: string): string {
  const s = h.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{8}$/.test(s)) throw new RangeError(`payload must be 4 bytes of hex, got ${h}`);
  return `0x${s.toUpperCase()}`;
}

/** Decodes a 32-bit frame into its persisted record (≡ backend/database.py::frame_row). */
export function frameRecord(node: string, timestampUtc: string, payloadHex: string, source: SourceMode, sdRecovered = false): FrameRecord {
  const hex = normaliseHex(payloadHex);
  const d = unpackTelemetryPayload(parseInt(hex, 16) >>> 0);
  return {
    key: `${node}|${timestampUtc}|${hex}`,
    node_id: node,
    timestamp_utc: timestampUtc,
    raw_hex_payload: hex,
    depth_cm: d.depthMm / 10,
    dh_dt_cm_min: d.dhDtMmMin / 10,
    capacity_pct: d.capPct,
    anomaly_code: d.anomCode,
    battery_v: d.vbatV,
    source_mode: source,
    sd_recovered_flag: sdRecovered,
  };
}

// ---------------------------------------------------------------- integrity checks
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (zlib) over the frames' big-endian bytes ≡ backend crc32_frames and the firmware dump trailer. */
export function crc32Frames(hexes: string[]): string {
  let c = 0xffffffff;
  for (const h of hexes) {
    const w = parseInt(normaliseHex(h), 16) >>> 0;
    for (const b of [w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** CRC-8/ATM (poly 0x07) of one 4-byte frame: the per-frame tag in the SD dump waterfall. */
export function crc8Frame(hex: string): number {
  const w = parseInt(normaliseHex(hex), 16) >>> 0;
  let c = 0;
  for (const b of [w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

// ---------------------------------------------------------------- stores
export interface TelemetryStore {
  readonly kind: 'indexeddb' | 'memory';
  putFrames(rows: FrameRecord[]): Promise<number>;
  history(node: string | null, limit: number): Promise<FrameRecord[]>;
  count(): Promise<number>;
  allFrames(): Promise<FrameRecord[]>;
  putBatch(b: SdBatchRecord): Promise<void>;
  batches(): Promise<SdBatchRecord[]>;
  putIncident(i: IncidentRecord): Promise<void>;
  incidents(): Promise<IncidentRecord[]>;
}

const byTime = (a: FrameRecord, b: FrameRecord) => (a.timestamp_utc < b.timestamp_utc ? -1 : a.timestamp_utc > b.timestamp_utc ? 1 : 0);

export class MemoryStore implements TelemetryStore {
  readonly kind = 'memory' as const;
  private frames = new Map<string, FrameRecord>();
  private sd: SdBatchRecord[] = [];
  private inc: IncidentRecord[] = [];
  async putFrames(rows: FrameRecord[]) {
    let n = 0;
    for (const r of rows) {
      if (this.frames.has(r.key)) continue;
      this.frames.set(r.key, r);
      n++;
    }
    return n;
  }
  async history(node: string | null, limit: number) {
    const rows = [...this.frames.values()].filter((r) => !node || r.node_id === node).sort(byTime);
    return rows.slice(Math.max(rows.length - limit, 0));
  }
  async count() {
    return this.frames.size;
  }
  async allFrames() {
    return [...this.frames.values()].sort(byTime);
  }
  async putBatch(b: SdBatchRecord) {
    this.sd.push(b);
  }
  async batches() {
    return [...this.sd];
  }
  async putIncident(i: IncidentRecord) {
    this.inc.push({ ...i, id: this.inc.length + 1 });
  }
  async incidents() {
    return [...this.inc].reverse();
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class IdbStore implements TelemetryStore {
  readonly kind = 'indexeddb' as const;
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IdbStore> {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      const f = db.createObjectStore('telemetry_frames', { keyPath: 'key' });
      f.createIndex('node_time', ['node_id', 'timestamp_utc']);
      f.createIndex('time', 'timestamp_utc');
      db.createObjectStore('sd_sync_batches', { keyPath: 'batch_id' });
      db.createObjectStore('incident_dispatches', { keyPath: 'id', autoIncrement: true });
    };
    return new IdbStore(await req(open));
  }

  private tx(store: string, mode: IDBTransactionMode) {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async putFrames(rows: FrameRecord[]) {
    const t = this.db.transaction('telemetry_frames', 'readwrite');
    const s = t.objectStore('telemetry_frames');
    let n = 0;
    for (const r of rows) {
      // add() rejects an existing key (ConstraintError); swallow it so the batch commits = dedupe.
      const q = s.add(r);
      q.onsuccess = () => n++;
      q.onerror = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
    }
    await new Promise<void>((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    return n;
  }
  async history(node: string | null, limit: number) {
    const s = this.tx('telemetry_frames', 'readonly');
    const rows: FrameRecord[] = node
      ? await req(s.index('node_time').getAll(IDBKeyRange.bound([node, ''], [node, '￿'])))
      : await req(s.index('time').getAll());
    return rows.slice(Math.max(rows.length - limit, 0));
  }
  async count() {
    return req(this.tx('telemetry_frames', 'readonly').count());
  }
  async allFrames() {
    return (await req(this.tx('telemetry_frames', 'readonly').index('time').getAll())) as FrameRecord[];
  }
  async putBatch(b: SdBatchRecord) {
    await req(this.tx('sd_sync_batches', 'readwrite').put(b));
  }
  async batches() {
    return (await req(this.tx('sd_sync_batches', 'readonly').getAll())) as SdBatchRecord[];
  }
  async putIncident(i: IncidentRecord) {
    const { id: _id, ...rest } = i;
    void _id;
    await req(this.tx('incident_dispatches', 'readwrite').add(rest));
  }
  async incidents() {
    return ((await req(this.tx('incident_dispatches', 'readonly').getAll())) as IncidentRecord[]).reverse();
  }
}

/** IndexedDB when the browser has it, else an in-memory store (private windows, tests). */
export async function openTelemetryStore(): Promise<TelemetryStore> {
  try {
    if (typeof indexedDB !== 'undefined') return await IdbStore.open();
  } catch {
    // blocked or unavailable: degrade to memory
  }
  return new MemoryStore();
}

// ---------------------------------------------------------------- dual driver
export interface DbStats {
  engine: string;
  local: { kind: TelemetryStore['kind']; frames: number; batches: number };
  backend: { reachable: boolean; engine?: string; frames?: number; sizeBytes?: number | null; lastSync?: string | null };
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 1500): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, { ...init, signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export class TelemetryDatabase {
  constructor(
    readonly store: TelemetryStore,
    private readonly api: string | null,
  ) {}

  /** Persists frames locally and mirrors them to the backend; `synced` = the backend accepted them. */
  async ingest(rows: FrameRecord[]): Promise<{ inserted: number; synced: boolean }> {
    const inserted = await this.store.putFrames(rows);
    if (!this.api || !rows.length) return { inserted, synced: false };
    const r = await fetchJson<{ inserted: number }>(`${this.api}/api/telemetry/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames: rows.map((f) => ({ node_id: f.node_id, payload_hex: f.raw_hex_payload, timestamp_utc: f.timestamp_utc, source_mode: f.source_mode })) }),
    });
    return { inserted, synced: r !== null };
  }

  async history(node: string | null, limit = 500): Promise<{ frames: FrameRecord[]; from: 'backend' | 'local' }> {
    if (this.api) {
      const q = new URLSearchParams({ limit: String(limit), ...(node ? { node_id: node } : {}) });
      const r = await fetchJson<{ frames: Omit<FrameRecord, 'key'>[] }>(`${this.api}/api/telemetry/history?${q}`);
      if (r && r.frames.length) return { frames: r.frames.map((f) => ({ ...f, key: `${f.node_id}|${f.timestamp_utc}|${f.raw_hex_payload}` })), from: 'backend' };
    }
    return { frames: await this.store.history(node, limit), from: 'local' };
  }

  /** Black-box recovery: CRC-32 check, local insert flagged sd_recovered, backend sd-backfill. */
  async sdBackfill(node: string, frames: { timestamp_utc: string; payload_hex: string }[], crc32: string | null, batchId: string): Promise<SdBatchRecord & { duplicates: number; synced: boolean }> {
    const computed = crc32Frames(frames.map((f) => f.payload_hex));
    const status: SdBatchRecord['integrity_crc_status'] = !crc32 ? 'NO_CRC_SUPPLIED' : crc32.toUpperCase().replace(/^0X/, '') === computed ? 'PASS' : 'FAIL';
    const rows = frames.map((f) => frameRecord(node, f.timestamp_utc, f.payload_hex, 'SD_BACKFILL', true));
    const inserted = status === 'FAIL' ? 0 : await this.store.putFrames(rows);
    const ts = rows.map((r) => r.timestamp_utc).sort();
    const batch: SdBatchRecord = {
      batch_id: batchId,
      node_id: node,
      uploaded_at: new Date().toISOString(),
      frames_recovered: inserted,
      start_timestamp: ts[0] ?? null,
      end_timestamp: ts.at(-1) ?? null,
      integrity_crc_status: status,
    };
    await this.store.putBatch(batch);
    let synced = false;
    if (this.api && status !== 'FAIL') {
      synced =
        (await fetchJson(`${this.api}/api/telemetry/sd-backfill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: node, batch_id: batchId, frames, crc32 }),
        })) !== null;
    }
    return { ...batch, duplicates: status === 'FAIL' ? 0 : rows.length - inserted, synced };
  }

  async recordIncident(i: Omit<IncidentRecord, 'timestamp_utc' | 'id'>): Promise<boolean> {
    const rec = { ...i, timestamp_utc: new Date().toISOString() };
    await this.store.putIncident(rec);
    if (!this.api) return false;
    return (await fetchJson(`${this.api}/api/incidents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(i) })) !== null;
  }

  async stats(): Promise<DbStats> {
    const local = { kind: this.store.kind, frames: await this.store.count(), batches: (await this.store.batches()).length };
    const b = this.api
      ? await fetchJson<{ engine: string; telemetry_frames: number; size_bytes: number | null; last_sd_sync_utc: string | null }>(`${this.api}/api/database/stats`)
      : null;
    const localName = local.kind === 'indexeddb' ? 'IndexedDB' : 'in-memory (no IndexedDB)';
    return {
      engine: b ? `${b.engine === 'postgresql' ? 'PostgreSQL' : 'SQLite'} + ${localName} synced` : `${localName} (backend offline)`,
      local,
      backend: b ? { reachable: true, engine: b.engine, frames: b.telemetry_frames, sizeBytes: b.size_bytes, lastSync: b.last_sd_sync_utc } : { reachable: false },
    };
  }

  /** CSV of local frames (all nodes, oldest first). */
  async csv(): Promise<string> {
    const cols: (keyof FrameRecord)[] = ['node_id', 'timestamp_utc', 'raw_hex_payload', 'depth_cm', 'dh_dt_cm_min', 'capacity_pct', 'anomaly_code', 'battery_v', 'source_mode', 'sd_recovered_flag'];
    const rows = await this.store.allFrames();
    return [cols.join(','), ...rows.map((r) => cols.map((c) => String(r[c])).join(','))].join('\n') + '\n';
  }

  /** JSON snapshot of the whole local database (frames, SD batches, incidents). */
  async snapshot(): Promise<object> {
    return {
      database: DB_NAME,
      exported_at: new Date().toISOString(),
      telemetry_frames: await this.store.allFrames(),
      sd_sync_batches: await this.store.batches(),
      incident_dispatches: await this.store.incidents(),
      note: 'SYNTHETIC_SEED rows are generated from the twin LUT, not field measurements.',
    };
  }
}

// ---------------------------------------------------------------- synthetic first-boot seed
/** Design-storm rainfall (mm/h) at hour h of the 24-h seed: a 12-h typhoon, then recession. */
export function seedRainAt(h: number): number {
  if (h < 2) return 2;
  if (h < 12) return 2 + 180 * Math.exp(-(((h - 7) / 2.2) ** 2));
  return Math.max(0, 6 * Math.exp(-(h - 12) / 3));
}

/** 24 h of synthetic frames for every node (10-min steps) ending at `endMs`. Deterministic. */
export function syntheticSeed(data: TwinData, endMs: number): FrameRecord[] {
  const interp = new LutInterpolator(data); // private: evaluate() mutates
  const step = SEED_STEP_MIN * 60_000;
  const end = Math.floor(endMs / step) * step;
  const n = (SEED_HOURS * 60) / SEED_STEP_MIN;
  const out: FrameRecord[] = [];
  for (let i = 0; i < n; i++) {
    const t = end - (n - 1 - i) * step;
    const h = (i * SEED_STEP_MIN) / 60;
    const clog = Math.min(10 + h * 2.5, 60);
    const st = interp.evaluate(seedRainAt(h), clog);
    const ts = new Date(t).toISOString();
    for (const S of st.sensors) out.push(frameRecord(S.id, ts, S.payloadHex, 'SYNTHETIC_SEED'));
  }
  return out;
}

/** Seeds an empty store; returns the number of frames written (0 when it already had data). */
export async function seedIfEmpty(db: TelemetryDatabase, data: TwinData, endMs = Date.now()): Promise<number> {
  if ((await db.store.count()) > 0) return 0;
  return db.store.putFrames(syntheticSeed(data, endMs));
}
