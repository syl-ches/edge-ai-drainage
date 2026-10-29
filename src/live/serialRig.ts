// Phase 7B: Arduino / ESP32 rig input. Accepts our firmware's `[EDGE_TX] {json}` frames and any
// simple ultrasonic sketch output (`DIST_MM:240`, `DIST_CM:24.0`, `FILL_PCT:85`, `TEMP_C:24.5`,
// `Distance: 24 cm`, bare numbers) over the browser's Web Serial API (Chrome / Edge), then runs
// raw distances through the same edge pipeline as the firmware (Kalman + INT8 classifier +
// 32-bit packer) so an Uno, Nano, Mega or ESP32 with an HC-SR04 / JSN-SR04T / A02YYUW works.
import { ANOMALY_BY_CODE, unpackTelemetryPayload, toHex } from '../utils/payloadCodec';
import type { AnomalyClass } from '../types/twin';
import { BURST_LEN, STANDPIPE_FULL_BORE_FRACTION, newKalman, runCycle, type EdgeConfig, type KalmanState } from '../edge/edgePipeline';
import type { HardwarePacket, RigOrigin, SyncScope } from './hardwareSync';

export type DistanceUnit = 'auto' | 'mm' | 'cm';

export type SerialReading =
  | { kind: 'edge_tx'; deviceEui: string | null; payloadHex: string; json: Record<string, unknown> }
  | { kind: 'distance'; mm: number; tempC?: number }
  | { kind: 'fill'; pct: number }
  | { kind: 'temp'; c: number };

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
/** How long a board's own [EDGE_TX] frames take precedence over its plain distance lines. */
export const EDGE_TX_PRIORITY_MS = 2000;
/** Bare numbers above this are millimetres, at or below it centimetres (aquarium ranges). */
export const AUTO_UNIT_SPLIT = 120;

function toMm(v: number, unit: 'mm' | 'cm' | 'auto'): number {
  if (unit === 'mm') return v;
  if (unit === 'cm') return v * 10;
  return v > AUTO_UNIT_SPLIT ? v : v * 10;
}

/** Parse one serial line; null for banners, comments and anything unrecognised. */
export function parseSerialLine(raw: string, unit: DistanceUnit = 'auto'): SerialReading | null {
  const line = raw.trim();
  if (!line) return null;
  if (line.startsWith('[EDGE_TX]')) {
    try {
      const json = JSON.parse(line.slice(9).trim()) as Record<string, unknown>;
      const hex = String(json.payload_hex ?? '');
      if (!/^0x[0-9a-f]{1,8}$/i.test(hex)) return null;
      return { kind: 'edge_tx', deviceEui: typeof json.device_eui === 'string' ? json.device_eui : null, payloadHex: toHex(parseInt(hex, 16) >>> 0), json };
    } catch {
      return null;
    }
  }
  let m = line.match(new RegExp(`^DIST_MM\\s*[:=]\\s*${NUM}`, 'i'));
  if (m) return { kind: 'distance', mm: Number(m[1]) };
  m = line.match(new RegExp(`^DIST_CM\\s*[:=]\\s*${NUM}`, 'i'));
  if (m) return { kind: 'distance', mm: Number(m[1]) * 10 };
  m = line.match(new RegExp(`^FILL_PCT\\s*[:=]\\s*${NUM}`, 'i'));
  if (m) return { kind: 'fill', pct: Number(m[1]) };
  m = line.match(new RegExp(`^TEMP_C\\s*[:=]\\s*${NUM}`, 'i'));
  if (m) return { kind: 'temp', c: Number(m[1]) };
  m = line.match(new RegExp(`${NUM}\\s*(mm|cm)\\b`, 'i'));
  if (m) return { kind: 'distance', mm: toMm(Number(m[1]), m[2].toLowerCase() as 'mm' | 'cm') };
  m = line.match(new RegExp(`^${NUM}$`));
  if (m) return { kind: 'distance', mm: toMm(Number(m[1]), unit) };
  return null;
}

export interface RigConfig {
  sensorId: string;
  deviceEui: string;
  /** full-scale depth D of the represented map structure (m) */
  fullScaleM: number;
  /** ultrasonic face -> tank floor (mm); 100 % fill = 74 % of it (bench standpipe convention) */
  tankHeightMm: number;
  scope: SyncScope;
  origin: RigOrigin;
  vbatV?: number;
}

/** Edge pipeline state for one rig (aquarium simulator or a USB board). */
export class HardwareRig {
  private kal: KalmanState = newKalman();
  private window: number[] = [];
  private lastMs: number | null = null;
  private seq = 0;
  /** last time the board sent its own [EDGE_TX] frame (its pipeline output wins over plain lines) */
  private lastEdgeTxMs: number | null = null;
  tempC = 24;

  constructor(public cfg: RigConfig) {}

  reset(): void {
    this.kal = newKalman();
    this.window = [];
    this.lastMs = null;
  }

  configure(cfg: Partial<RigConfig>): void {
    const changed = (cfg.sensorId && cfg.sensorId !== this.cfg.sensorId) || (cfg.tankHeightMm && cfg.tankHeightMm !== this.cfg.tankHeightMm);
    this.cfg = { ...this.cfg, ...cfg };
    if (changed) this.reset();
  }

  /** Distance from the sensor face for an aquarium fill % (100 % = 74 % of the tank height). */
  distanceForFill(fillPct: number): number {
    return this.cfg.tankHeightMm - (fillPct / 100) * STANDPIPE_FULL_BORE_FRACTION * this.cfg.tankHeightMm;
  }

  private edgeConfig(): EdgeConfig {
    return { fullScaleM: this.cfg.fullScaleM, mountMm: 0, standpipe: true, pipeHeightMm: this.cfg.tankHeightMm, vbatV: this.cfg.vbatV ?? 4.05 };
  }

  /** A full 10-sample burst (the simulator synthesises one per tick). */
  ingestBurst(burstMm: number[], nowMs: number): HardwarePacket {
    const dtMin = this.lastMs === null ? 1 / 60 : Math.max((nowMs - this.lastMs) / 60_000, 1e-4);
    this.lastMs = nowMs;
    const r = runCycle(this.edgeConfig(), this.kal, burstMm, this.tempC, dtMin);
    return this.packet({
      fillPct: r.h_over_d * 100,
      depthMm: r.depth_mm,
      rawDepthMm: r.raw_depth_mm,
      dhDtMmMin: r.dh_dt_mm_min,
      sigmaD2: r.sigma_d2,
      turbulence: r.turbulence,
      capacityPct: r.cap_pct,
      anomalyCode: r.anomaly_code,
      payloadHex: r.payload_hex,
      distanceMm: r.d_med_mm,
      rawBurstMm: burstMm,
    });
  }

  /** One streamed distance sample (USB boards): rolling 10-sample window -> one edge cycle. */
  ingestDistance(mm: number, nowMs: number): HardwarePacket {
    this.window.push(mm);
    while (this.window.length > BURST_LEN) this.window.shift();
    const burst = [...this.window];
    while (burst.length < BURST_LEN) burst.unshift(burst[0]);
    return this.ingestBurst(burst, nowMs);
  }

  ingestReading(r: SerialReading, nowMs: number): HardwarePacket | null {
    // Boards running the universal sketch print [EDGE_TX] AND a plain DIST_MM line each cycle:
    // while frames keep arriving, the plain duplicates are ignored (no double Kalman).
    const framesLive = this.lastEdgeTxMs !== null && nowMs - this.lastEdgeTxMs < EDGE_TX_PRIORITY_MS;
    if ((r.kind === 'distance' || r.kind === 'fill') && framesLive) return null;
    switch (r.kind) {
      case 'temp':
        this.tempC = r.c;
        return null;
      case 'fill':
        return this.ingestDistance(this.distanceForFill(r.pct), nowMs);
      case 'distance':
        if (r.tempC !== undefined) this.tempC = r.tempC;
        return this.ingestDistance(r.mm, nowMs);
      case 'edge_tx': {
        this.lastEdgeTxMs = nowMs;
        // The board already ran the edge pipeline: decode the 32-bit word as-is.
        const d = unpackTelemetryPayload(parseInt(r.payloadHex, 16) >>> 0);
        const j = r.json;
        const hOverD =
          typeof j.h_over_d === 'number' ? j.h_over_d : typeof j.fill_pct === 'number' ? j.fill_pct / 100 : d.depthMm / 1000 / this.cfg.fullScaleM;
        return this.packet({
          fillPct: hOverD * 100,
          depthMm: typeof j.kalman_filtered_depth_mm === 'number' ? j.kalman_filtered_depth_mm : d.depthMm,
          rawDepthMm:
            typeof j.raw_unfiltered_depth_mm === 'number'
              ? j.raw_unfiltered_depth_mm
              : typeof j.kalman_filtered_depth_mm === 'number'
                ? j.kalman_filtered_depth_mm
                : d.depthMm,
          dhDtMmMin: typeof j.dh_dt_mm_min === 'number' ? j.dh_dt_mm_min : d.dhDtMmMin,
          sigmaD2: typeof j.sigma_d2_mm2 === 'number' ? j.sigma_d2_mm2 : 0,
          turbulence: typeof j.turbulence_index === 'number' ? j.turbulence_index : 0,
          capacityPct: d.capPct,
          anomalyCode: d.anomCode,
          payloadHex: r.payloadHex,
          distanceMm: typeof j.dist_mm === 'number' ? j.dist_mm : null,
          rawBurstMm: Array.isArray(j.raw_burst_mm) ? (j.raw_burst_mm as number[]) : typeof j.dist_mm === 'number' ? [j.dist_mm] : [],
          vbatV: d.vbatV,
        });
      }
    }
  }

  private packet(x: {
    fillPct: number;
    depthMm: number;
    rawDepthMm: number;
    dhDtMmMin: number;
    sigmaD2: number;
    turbulence: number;
    capacityPct: number;
    anomalyCode: number;
    payloadHex: string;
    distanceMm: number | null;
    rawBurstMm: number[];
    vbatV?: number;
  }): HardwarePacket {
    const a = ANOMALY_BY_CODE[x.anomalyCode];
    return {
      v: 1,
      type: 'telemetry',
      seq: ++this.seq,
      ts: Date.now(),
      origin: this.cfg.origin,
      sensorId: this.cfg.sensorId,
      deviceEui: this.cfg.deviceEui,
      scope: this.cfg.scope,
      fillPct: x.fillPct,
      depthMm: x.depthMm,
      rawDepthMm: x.rawDepthMm,
      dhDtMmMin: x.dhDtMmMin,
      sigmaD2: x.sigmaD2,
      turbulence: x.turbulence,
      capacityPct: x.capacityPct,
      anomaly: (a === 'RESERVED' ? 'NORMAL' : a) as AnomalyClass,
      anomalyCode: x.anomalyCode,
      payloadHex: x.payloadHex,
      vbatV: x.vbatV ?? this.cfg.vbatV ?? 4.05,
      tempC: this.tempC,
      distanceMm: x.distanceMm,
      rawBurstMm: x.rawBurstMm,
    };
  }
}

// ---------------------------------------------------------------- Web Serial (Chrome / Edge)
interface WebSerialPort {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}
interface WebSerial {
  requestPort(o?: object): Promise<WebSerialPort>;
}

export const SERIAL_BAUD = 115200;

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export interface SerialSession {
  label: string;
  close(): Promise<void>;
}

/** Splits a text stream into lines (handles \r\n and partial chunks). */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? '';
    for (const p of parts) onLine(p);
  };
}

/** Prompt for a USB serial port and stream its lines at 115200 baud. */
export async function connectWebSerial(onLine: (line: string) => void, onClose: (err?: unknown) => void): Promise<SerialSession> {
  const serial = (navigator as unknown as { serial?: WebSerial }).serial;
  if (!serial) throw new Error('Web Serial is not available: use Chrome or Edge on desktop, or scripts/serial_bridge.py');
  const port = await serial.requestPort();
  await port.open({ baudRate: SERIAL_BAUD });
  const info = port.getInfo?.() ?? {};
  const label = info.usbVendorId ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}` : 'USB serial';
  const decoder = new TextDecoder();
  const feed = lineSplitter(onLine);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let closed = false;
  void (async () => {
    try {
      while (!closed && port.readable) {
        reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) feed(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
        }
      }
      onClose();
    } catch (err) {
      if (!closed) onClose(err);
    }
  })();
  return {
    label,
    async close() {
      closed = true;
      try {
        await reader?.cancel();
      } catch {
        /* already released */
      }
      await port.close().catch(() => undefined);
    },
  };
}
