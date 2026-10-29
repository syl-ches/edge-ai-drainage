// Phase 7B: dual-channel synchronisation of the Arduino / aquarium rig with the 3D map.
//   1. Browser cross-tab: BroadcastChannel('citycamp_hardware_sync') (localStorage `storage`
//      event fallback). /?view=hardware-sim updates the map tab with zero backend.
//   2. Backend: POST /api/v1/ingest/lorawan {device_eui, payload_hex, scope, ...diagnostics}, so
//      the FastAPI WebSocket broadcasts the hardware override to every connected client.
// Plus the map-side override: the targeted sensor (and its conduit) follow the packet
// ("single_node"), or the whole catchment is re-driven through the LUT ("full_catchment").
import type { AnomalyClass } from '../types/twin';
import type { LutInterpolator, TwinState } from '../utils/lutInterpolator';
import { STATUSES } from '../utils/lutInterpolator';
import { toBytesBE } from '../utils/payloadCodec';
import { CAP_MAX_PCT } from '../utils/payloadCodec';

export const HW_CHANNEL = 'citycamp_hardware_sync';
export const HW_STORAGE_KEY = 'citycamp_hardware_sync';
/** A packet keeps driving the map this long after the last one (backend HARDWARE_HOLD_S). */
export const HW_HOLD_MS = 30_000;

export type SyncScope = 'single_node' | 'full_catchment';
export type RigOrigin = 'AQUARIUM_SIM' | 'WEB_SERIAL';

export interface HardwarePacket {
  v: 1;
  type: 'telemetry';
  seq: number;
  ts: number;
  origin: RigOrigin;
  sensorId: string;
  deviceEui: string;
  scope: SyncScope;
  /** aquarium / bench fill = h/D x 100 (100 % at 74 % of the sensor height) */
  fillPct: number;
  depthMm: number;
  /** unfiltered (last raw sample) depth on the same scale as depthMm */
  rawDepthMm: number;
  dhDtMmMin: number;
  sigmaD2: number;
  turbulence: number;
  capacityPct: number;
  anomaly: AnomalyClass;
  anomalyCode: number;
  payloadHex: string;
  vbatV: number;
  tempC: number;
  distanceMm: number | null;
  rawBurstMm: number[];
}

export interface DisconnectMessage {
  v: 1;
  type: 'disconnect';
  ts: number;
  from: 'MAP' | 'SIM';
  sensorId?: string;
}

export type SyncMessage = HardwarePacket | DisconnectMessage;

export interface SyncBus {
  readonly transport: 'broadcast-channel' | 'local-storage' | 'none';
  publish(msg: SyncMessage): void;
  subscribe(cb: (msg: SyncMessage) => void): () => void;
  close(): void;
}

function isSyncMessage(x: unknown): x is SyncMessage {
  const m = x as SyncMessage | null;
  return !!m && m.v === 1 && (m.type === 'telemetry' || m.type === 'disconnect');
}

/** One bus per page. BroadcastChannel when available (Chrome, Edge, Firefox, Safari 15.4+, Node 18+). */
export function openSyncBus(): SyncBus {
  const subs = new Set<(m: SyncMessage) => void>();
  const deliver = (m: unknown) => {
    if (isSyncMessage(m)) subs.forEach((cb) => cb(m));
  };
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(HW_CHANNEL);
    ch.onmessage = (ev: MessageEvent) => deliver(ev.data);
    return {
      transport: 'broadcast-channel',
      publish: (m) => ch.postMessage(m),
      subscribe: (cb) => (subs.add(cb), () => subs.delete(cb)),
      close: () => ch.close(),
    };
  }
  let storage: Storage | null = null;
  try {
    storage = typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    storage = null;
  }
  if (storage && typeof window !== 'undefined') {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== HW_STORAGE_KEY || !ev.newValue) return;
      try {
        deliver(JSON.parse(ev.newValue));
      } catch {
        /* malformed */
      }
    };
    window.addEventListener('storage', onStorage);
    return {
      transport: 'local-storage',
      publish: (m) => {
        try {
          storage!.setItem(HW_STORAGE_KEY, JSON.stringify({ ...m, nonce: Math.random() }));
        } catch {
          /* storage blocked */
        }
      },
      subscribe: (cb) => (subs.add(cb), () => subs.delete(cb)),
      close: () => window.removeEventListener('storage', onStorage),
    };
  }
  return { transport: 'none', publish: () => undefined, subscribe: (cb) => (subs.add(cb), () => subs.delete(cb)), close: () => undefined };
}

/** Same JSON shape the USB serial bridge posts (scripts/serial_bridge.py). */
export function ingestBody(p: HardwarePacket) {
  return {
    device_eui: p.sensorId,
    payload_hex: p.payloadHex,
    scope: p.scope,
    kalman_filtered_depth_mm: Math.round(p.depthMm * 10) / 10,
    dh_dt_mm_min: Math.round(p.dhDtMmMin * 100) / 100,
    sigma_d2_mm2: Math.round(p.sigmaD2 * 100) / 100,
    turbulence_index: Math.round(p.turbulence * 1e4) / 1e4,
    temperature_c: p.tempC,
    raw_burst_mm: p.rawBurstMm.map((x) => Math.round(x * 10) / 10),
    h_over_d: Math.round(p.fillPct * 100) / 1e4,
    bench_demo: true,
  };
}

export async function postToBackend(base: string, p: HardwarePacket, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/v1/ingest/lorawan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ingestBody(p)),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** LUT rainfall whose state best reproduces a sensor fullness (mirror of backend lut.invert_rain_for_sensor). */
export function invertRainForSensor(interp: LutInterpolator, sensorId: string, capacityPct: number, clog: number): number {
  const idx = interp.sensorIndex.get(sensorId) ?? 0;
  let best = 0;
  let bestErr = Infinity;
  for (let k = 0; k <= 500; k++) {
    const rain = k * 0.5;
    const err = Math.abs(interp.evaluate(rain, clog).sensors[idx].capacityPct - capacityPct);
    if (err < bestErr) {
      bestErr = err;
      best = rain;
    }
  }
  return best;
}

/**
 * Overlay a rig packet on an evaluated state: the targeted sensor takes the packet's readings
 * and its conduit shows the same fullness (depth = h/D x rise, status re-derived), so the pill,
 * pin, pad and pipe all follow the aquarium and blink red at >= 80 %.
 */
export function applyHardwarePacket(st: TwinState, interp: LutInterpolator, p: HardwarePacket): void {
  const idx = interp.sensorIndex.get(p.sensorId);
  if (idx === undefined) return;
  const S = st.sensors[idx];
  const cap = Math.min(Math.max(p.capacityPct, 0), CAP_MAX_PCT);
  S.depthMm = p.depthMm;
  S.dhDtMmMin = p.dhDtMmMin;
  S.capacityPct = cap;
  S.hRatio = p.fillPct / 100;
  S.anomaly = p.anomaly;
  S.anomalyCode = p.anomalyCode;
  S.payload = parseInt(p.payloadHex, 16) >>> 0;
  S.payloadHex = p.payloadHex;
  S.payloadBytes = toBytesBE(S.payload);
  S.vbatV = p.vbatV;
  S.liveSurge = p.anomaly === 'FLASH_SURGE' || p.anomaly === 'SURCHARGED';
  S.saturated = cap >= CAP_MAX_PCT ? ['cap_pct'] : [];
  if (S.sensor.attached_kind !== 'CONDUIT') return;
  const ci = interp.conduitIndex.get(S.sensor.attached_to);
  if (ci === undefined) return;
  const C = st.conduits;
  const ratio = cap / 100;
  const rise = interp.network.conduits[ci].geometry.rise_m;
  const old = STATUSES[C.status[ci]];
  C.capacity[ci] = Math.min(ratio, 1.27);
  C.depth[ci] = Math.min(ratio, 1) * rise;
  C.pressurized[ci] = ratio >= 1 ? 1 : 0;
  const status = ratio >= 1 ? 3 : ratio >= 0.85 ? 2 : ratio >= 0.5 ? 1 : 0;
  C.status[ci] = status;
  st.statusCounts[old]--;
  st.statusCounts[STATUSES[status]]++;
}
