// Phase 8: rolling session telemetry (last 60 snapshots) for the Analytics modal and the PDF.
// Raw vs Kalman ultrasonic series come from the best available edge source, in priority order:
//   1. a live Arduino / aquarium rig packet (real or simulated edge pipeline),
//   2. a backend frame (the virtual fleet's edge DSP for the DSP-focus sensor),
//   3. an in-browser virtual edge probe on that sensor: the LUT's true depth plus acoustic noise
//      and splash echoes, run through the same edge pipeline (src/edge/edgePipeline.ts).
import type { AnomalyClass, NetworkFile } from '../types/twin';
import type { TwinState } from './lutInterpolator';
import { newKalman, runCycle, type KalmanState } from '../edge/edgePipeline';
import { nodeFullnessPct, sensorGeometry } from './fullness';

export const RECORDER_CAPACITY = 60;

export type EdgeSource = 'HARDWARE_RIG' | 'BACKEND_EDGE' | 'VIRTUAL_PROBE';

export interface TelemetrySnapshot {
  /** epoch ms */
  t: number;
  rainMmHr: number;
  blockagePct: number;
  lagoonDepthM: number;
  surfaceElevM: number;
  headLossM: number;
  outflowCms: number;
  /** edge signal of `edgeSensor`: raw (unfiltered) and Kalman-filtered depth, mm */
  edgeSensor: string;
  edgeSource: EdgeSource;
  rawDepthMm: number;
  kalmanDepthMm: number;
  capacities: Record<string, number>;
  anomalies: Record<string, AnomalyClass>;
}

export interface EdgeSample {
  sensor: string;
  source: Exclude<EdgeSource, 'VIRTUAL_PROBE'>;
  rawDepthMm: number;
  kalmanDepthMm: number;
}

export class TelemetryRecorder {
  private buf: TelemetrySnapshot[] = [];
  private peak = new Map<string, number>();
  private probeKal: KalmanState = newKalman();
  private probeSensor = '';
  private seed = 20240917;

  constructor(readonly capacity = RECORDER_CAPACITY) {}

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return this.seed / 2 ** 32;
  }
  private gauss(): number {
    const u = Math.max(this.rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rnd());
  }

  /** Virtual A02YYUW over `sensorId`: 10-sample burst of the true surface + noise + splash echoes. */
  private probe(st: TwinState, network: NetworkFile, sensorId: string): { raw: number; kalman: number } {
    const S = st.sensors.find((s) => s.id === sensorId) ?? st.sensors[0];
    const g = sensorGeometry(S.sensor, network);
    if (this.probeSensor !== S.id) {
      this.probeSensor = S.id;
      this.probeKal = newKalman();
    }
    const mountMm = g.mountM * 1000;
    const trueMm = Math.min(Math.max(S.depthMm, 0), mountMm - 40);
    const sigma = 4 + 0.06 * Math.min(Math.abs(S.dhDtMmMin), 200);
    const burst = Array.from({ length: 10 }, () => {
      let d = mountMm - trueMm + this.gauss() * sigma;
      if (this.rnd() < 0.15) d -= 60 + this.rnd() * 140; // splash echo off a droplet
      return Math.max(d, 35);
    });
    const r = runCycle({ fullScaleM: g.fullScaleM, mountMm, standpipe: false, pipeHeightMm: 1000, vbatV: S.vbatV }, this.probeKal, burst, 20, 0.5);
    return { raw: r.raw_depth_mm, kalman: r.depth_mm };
  }

  record(st: TwinState, network: NetworkFile, edgeSensor: string, edge: EdgeSample | null, now = Date.now()): TelemetrySnapshot {
    const L = st.lagoon;
    const capacities: Record<string, number> = {};
    const anomalies: Record<string, AnomalyClass> = {};
    for (const S of st.sensors) {
      const pct = nodeFullnessPct(S);
      capacities[S.id] = pct;
      anomalies[S.id] = S.anomaly;
      this.peak.set(S.id, Math.max(this.peak.get(S.id) ?? 0, pct));
    }
    let raw: number;
    let kalman: number;
    let source: EdgeSource;
    let sensor = edgeSensor;
    if (edge) {
      raw = edge.rawDepthMm;
      kalman = edge.kalmanDepthMm;
      source = edge.source;
      sensor = edge.sensor;
    } else {
      ({ raw, kalman } = this.probe(st, network, edgeSensor));
      source = 'VIRTUAL_PROBE';
    }
    const snap: TelemetrySnapshot = {
      t: now,
      rainMmHr: st.rain,
      blockagePct: st.blockagePct,
      lagoonDepthM: L.depthM,
      surfaceElevM: L.surfaceElevM,
      headLossM: L.headLossM,
      outflowCms: L.orificeFlowCms,
      edgeSensor: sensor,
      edgeSource: source,
      rawDepthMm: raw,
      kalmanDepthMm: kalman,
      capacities,
      anomalies,
    };
    this.buf.push(snap);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    return snap;
  }

  snapshots(): TelemetrySnapshot[] {
    return this.buf.slice();
  }

  /** Session peak fullness per sensor (over everything recorded, not just the window). */
  peaks(): Record<string, number> {
    return Object.fromEntries(this.peak);
  }

  clear(): void {
    this.buf = [];
    this.peak.clear();
    this.probeKal = newKalman();
  }
}
