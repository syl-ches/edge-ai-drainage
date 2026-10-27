// Zero-allocation bilinear interpolation over the simulation_lut.json grid
// (rainfall_mm_hr × trash_rack_blockage_pct). All LUT fields are unpacked once into
// flat Float64Arrays; evaluate() mutates and returns one reusable TwinState.
//
// Field-specific rules (CLAUDE.md §9):
//   - nullable fields (froude_number) interpolate over non-null corners only, and are null
//     when < 50 % of the weight is non-null (pressurized corners dominate);
//   - status / flags / anomaly are re-derived from interpolated values with the generator's
//     exact thresholds, never interpolated;
//   - outflow keeps its physical structure Q_out = min(Q_rack, Q_choke): rack capacity is
//     interpolated per unit open area (Q_rack/(1−p), smooth in p) and the Kirschmer loss is
//     rebuilt as ΔH = ξ_clean(1−p)⁻²·V²/2g from that Q and the interpolated stage, so the
//     choke↔rack hand-over between grid columns is not smeared (≈0.1 % off-grid error);
//   - time-to-overflow interpolates the overflow *rate* 1/t (null ⇒ 0) to stay continuous;
//   - the tunnel reach fed purely by Q_out (intake → Lower Rock Quarry junction) is read from
//     per-conduit flow-indexed curves built from all grid cells, at the interpolated Q_out;
//   - payloads are re-packed with the §10 codec, never interpolated.

import type { TwinData } from '../data/loadTwin';
import type { AnomalyClass, ConduitStatus, LutFile, NetworkFile, Sensor } from '../types/twin';
import { ANOMALY_CODES, CAP_MAX_PCT, DEPTH_MAX_MM, DHDT_MAX, DHDT_MIN, packTelemetryPayload, toBytesBE, toHex } from './payloadCodec';

export const STATUSES: ConduitStatus[] = ['NORMAL', 'ELEVATED', 'CRITICAL', 'SURCHARGED'];
const G = 9.80665;
const ELEVATED = 0.5;
const CRITICAL = 0.85;
const FLASH_DHDT = 15;
const FLASH_TURB = 0.45;
const BLOCKAGE_H = 0.6;
const BLOCKAGE_TURB = 0.25;

export type OutflowControl = 'NONE' | 'TRASH_RACK' | 'TUNNEL_CHOKE';

export interface LagoonState {
  depthM: number;
  surfaceElevM: number;
  inundationRadiusM: number;
  inundationAreaM2: number;
  headLossM: number;
  orificeFlowCms: number;
  rackCapacityCms: number;
  inflowCms: number;
  spillCms: number;
  dhDtMmMin: number;
  xiRack: number;
  openAreaPct: number;
  timeToOverflowMin: number | null;
  isOverflowing: boolean;
  control: OutflowControl;
  /** 'ROCK_TUNNEL_CHOKE_4.44_CMS' | 'TRASH_RACK_ORIFICE' | 'NONE' */
  bottleneck: string;
  depthSeries: Float64Array;
}

export interface SensorState {
  id: string;
  sensor: Sensor;
  depthMm: number;
  dhDtMmMin: number;
  turbulence: number;
  capacityPct: number;
  froude: number | null;
  blockageP: number | null;
  hRatio: number;
  vbatV: number;
  anomaly: AnomalyClass;
  anomalyCode: number;
  saturated: string[];
  payload: number;
  payloadHex: string;
  payloadBytes: string;
  /** Set by LIVE mode when a physical (hardware) uplink reports a surge here; cleared by evaluate(). */
  liveSurge: boolean;
}

export interface ConduitArrays {
  capacity: Float64Array;
  depth: Float64Array;
  flow: Float64Array;
  velocity: Float64Array;
  froude: Float64Array; // NaN = null (pressurized)
  pressurized: Float64Array; // 0..1 corner weight
  jump: Float64Array; // 0..1 corner weight
  status: Uint8Array; // index into STATUSES
}

export interface TwinState {
  rev: number;
  rain: number;
  blockagePct: number;
  conduits: ConduitArrays;
  nodes: { hgl: Float64Array; flooding: Uint8Array };
  lagoon: LagoonState;
  sensors: SensorState[];
  statusCounts: Record<ConduitStatus, number>;
}

const C_FIELDS = ['capacity_ratio', 'water_depth_m', 'flow_cms', 'velocity_ms'] as const;
const L_FIELDS = [
  'lagoon_water_depth_m',
  'lagoon_surface_elev_m',
  'inundation_radius_m',
  'inundation_area_m2',
  'orifice_flow_cms',
  'rack_capacity_cms',
  'lagoon_inflow_cms',
  'spill_flow_cms',
  'lagoon_dh_dt_mm_min',
] as const;

function classify(h: number, dhdt: number, ti: number, fr: number | null, pressurized: boolean): AnomalyClass {
  if (pressurized || h >= 1.0) return 'SURCHARGED';
  if (h > BLOCKAGE_H && Math.abs(dhdt) < FLASH_DHDT && ti < BLOCKAGE_TURB) return 'TRASH_BLOCKAGE';
  if (dhdt >= FLASH_DHDT && ti >= FLASH_TURB) return 'FLASH_SURGE';
  if (fr !== null && fr > 1.0 && h >= 0.05) return 'SUPERCRITICAL';
  return 'NORMAL';
}

export class LutInterpolator {
  readonly rainAxis: number[];
  readonly blockAxis: number[];
  readonly conduitIndex = new Map<string, number>();
  readonly nodeIndex = new Map<string, number>();
  readonly sensorIndex = new Map<string, number>();
  readonly tunnelLimitCms: number;
  readonly bottleneckChoke: string;
  readonly state: TwinState;
  /** Conduit ids evaluated on flow-indexed curves (tunnel reach fed purely by Q_out). */
  readonly curveConduits: string[];

  private readonly net: NetworkFile;
  private readonly nC: number;
  private readonly nN: number;
  private readonly nS: number;
  private readonly nSeries: number;
  private readonly poolDepth: number;
  private readonly maxDepth: number;
  private readonly rackHeight: number;
  // per grid cell (row = scenario index in rain-major grid order)
  private readonly cf: Float64Array[]; // C_FIELDS
  private readonly cFr: Float64Array;
  private readonly cPress: Float64Array;
  private readonly cJump: Float64Array;
  private readonly nHgl: Float64Array;
  private readonly nFlood: Float64Array;
  private readonly lf: Float64Array[]; // L_FIELDS
  private readonly lRackN: Float64Array;
  private readonly lRate: Float64Array;
  private readonly lSeries: Float64Array;
  private readonly sDepth: Float64Array;
  private readonly sDhdt: Float64Array;
  private readonly sTurb: Float64Array;
  private readonly sCap: Float64Array;
  private readonly sFr: Float64Array;
  private readonly sensorConduit: Int32Array; // conduit index or -1
  // tunnel conduits: flow-indexed curves (sorted by Q) + lateral inflow per grid cell
  private readonly tunnel: { i: number; q: Float64Array; cap: Float64Array; depth: Float64Array; vel: Float64Array; fr: Float64Array; press: Float64Array; jump: Float64Array }[];
  private readonly sensorRise: Float64Array;
  // bilinear scratch (no allocation in evaluate)
  private readonly cell = new Int32Array(4);
  private readonly w = new Float64Array(4);

  /** The (active-filtered) network this interpolator was built from. */
  get network(): NetworkFile {
    return this.net;
  }

  constructor(data: Pick<TwinData, 'network' | 'lut'>) {
    const { network, lut } = data;
    this.net = network;
    this.rainAxis = lut.axes.rainfall_mm_hr;
    this.blockAxis = lut.axes.trash_rack_blockage_pct;
    this.tunnelLimitCms = lut.meta.tunnel_conveyance_limit_cms;
    this.bottleneckChoke = `ROCK_TUNNEL_CHOKE_${this.tunnelLimitCms.toFixed(2)}_CMS`;
    this.poolDepth = network.lagoon.permanent_pool_depth_m;
    this.maxDepth = network.lagoon.max_depth_m;
    this.rackHeight = network.orifices[0].height_m;
    this.nC = network.conduits.length;
    this.nN = network.nodes.length;
    this.nS = network.sensors.length;
    network.conduits.forEach((c, i) => this.conduitIndex.set(c.id, i));
    network.nodes.forEach((n, i) => this.nodeIndex.set(n.id, i));
    network.sensors.forEach((s, i) => this.sensorIndex.set(s.sensor_id, i));

    const nCells = this.rainAxis.length * this.blockAxis.length;
    const scen = (k: number) => {
      const r = this.rainAxis[Math.floor(k / this.blockAxis.length)];
      const b = this.blockAxis[k % this.blockAxis.length];
      const idx = lut.index[`R${r}_B${b}`];
      if (idx === undefined) throw new Error(`LUT grid cell R${r}_B${b} missing`);
      return lut.scenarios[idx];
    };
    this.nSeries = lut.scenarios[0].lagoon.depth_series_m.length;
    this.cf = C_FIELDS.map(() => new Float64Array(nCells * this.nC));
    this.cFr = new Float64Array(nCells * this.nC);
    this.cPress = new Float64Array(nCells * this.nC);
    this.cJump = new Float64Array(nCells * this.nC);
    this.nHgl = new Float64Array(nCells * this.nN);
    this.nFlood = new Float64Array(nCells * this.nN);
    this.lf = L_FIELDS.map(() => new Float64Array(nCells));
    this.lRackN = new Float64Array(nCells);
    this.lRate = new Float64Array(nCells);
    this.lSeries = new Float64Array(nCells * this.nSeries);
    this.sDepth = new Float64Array(nCells * this.nS);
    this.sDhdt = new Float64Array(nCells * this.nS);
    this.sTurb = new Float64Array(nCells * this.nS);
    this.sCap = new Float64Array(nCells * this.nS);
    this.sFr = new Float64Array(nCells * this.nS);

    for (let k = 0; k < nCells; k++) {
      const s = scen(k);
      const p = s.trash_rack_blockage_pct / 100;
      network.conduits.forEach((c, i) => {
        const r = s.conduits[c.id];
        const o = k * this.nC + i;
        C_FIELDS.forEach((f, fi) => (this.cf[fi][o] = r[f]));
        this.cFr[o] = r.froude_number ?? NaN;
        this.cPress[o] = r.flow_regime === 'PRESSURIZED' ? 1 : 0;
        this.cJump[o] = r.hydraulic_jump ? 1 : 0;
      });
      network.nodes.forEach((n, i) => {
        const r = s.nodes[n.id];
        this.nHgl[k * this.nN + i] = r ? r.hgl_m : n.invert_elev_m;
        this.nFlood[k * this.nN + i] = r?.is_flooding ? 1 : 0;
      });
      L_FIELDS.forEach((f, fi) => (this.lf[fi][k] = s.lagoon[f]));
      this.lRackN[k] = s.lagoon.rack_capacity_cms / (1 - p);
      const t = s.lagoon.estimated_time_to_overflow_min;
      this.lRate[k] = t === null ? 0 : 1 / Math.max(t, 1e-3);
      s.lagoon.depth_series_m.forEach((d, j) => (this.lSeries[k * this.nSeries + j] = d));
      network.sensors.forEach((sen, i) => {
        const t2 = s.sensors[sen.sensor_id];
        const o = k * this.nS + i;
        this.sDepth[o] = t2.depth_mm;
        this.sDhdt[o] = t2.dh_dt_mm_min;
        this.sTurb[o] = t2.turbulence_index;
        this.sCap[o] = t2.capacity_pct;
        this.sFr[o] = t2.froude_number ?? NaN;
      });
    }

    this.tunnel = network.conduits.flatMap((c, i) => {
      if (c.network !== 'TUNNEL') return [];
      const lateral = new Float64Array(nCells);
      const rows: number[][] = [];
      for (let k = 0; k < nCells; k++) {
        const o = k * this.nC + i;
        lateral[k] = this.cf[2][o] - scen(k).lagoon.orifice_flow_cms;
        rows.push([this.cf[2][o], this.cf[0][o], this.cf[1][o], this.cf[3][o], this.cFr[o], this.cPress[o], this.cJump[o]]);
      }
      // Only the reach fed purely by Q_out (lateral ≈ 0 in every cell) is single-valued in Q.
      if (lateral.some((v) => Math.abs(v) > 1e-3)) return [];
      rows.sort((a, b) => a[0] - b[0]);
      // ...and only if its samples really are single-valued in Q (rules out reaches whose
      // backwater depends on the lateral inflow, e.g. the conduit ending at the LRQ junction).
      if (rows.some((r, j) => j > 0 && r[0] - rows[j - 1][0] < 1e-3 && Math.abs(r[1] - rows[j - 1][1]) > 3e-3)) return [];
      const uniq = rows.filter((r, j) => j === 0 || r[0] - rows[j - 1][0] > 1e-9);
      const col = (j: number) => Float64Array.from(uniq, (r) => r[j]);
      return [{ i, q: col(0), cap: col(1), depth: col(2), vel: col(3), fr: col(4), press: col(5), jump: col(6) }];
    });

    this.curveConduits = this.tunnel.map((T) => network.conduits[T.i].id);
    this.isTunnel = new Uint8Array(this.nC);
    for (const T of this.tunnel) this.isTunnel[T.i] = 1;
    this.sensorConduit = new Int32Array(this.nS);
    this.sensorRise = new Float64Array(this.nS);
    network.sensors.forEach((sen, i) => {
      this.sensorConduit[i] = sen.attached_kind === 'CONDUIT' ? (this.conduitIndex.get(sen.attached_to) ?? -1) : -1;
      this.sensorRise[i] =
        sen.attached_kind === 'CONDUIT'
          ? Number(sen.pipe_geometry.rise_m)
          : sen.attached_kind === 'STORAGE'
            ? this.maxDepth
            : this.rackHeight;
    });

    this.state = {
      rev: 0,
      rain: 0,
      blockagePct: 0,
      conduits: {
        capacity: new Float64Array(this.nC),
        depth: new Float64Array(this.nC),
        flow: new Float64Array(this.nC),
        velocity: new Float64Array(this.nC),
        froude: new Float64Array(this.nC),
        pressurized: new Float64Array(this.nC),
        jump: new Float64Array(this.nC),
        status: new Uint8Array(this.nC),
      },
      nodes: { hgl: new Float64Array(this.nN), flooding: new Uint8Array(this.nN) },
      lagoon: {
        depthM: 0,
        surfaceElevM: 0,
        inundationRadiusM: 0,
        inundationAreaM2: 0,
        headLossM: 0,
        orificeFlowCms: 0,
        rackCapacityCms: 0,
        inflowCms: 0,
        spillCms: 0,
        dhDtMmMin: 0,
        xiRack: 0,
        openAreaPct: 100,
        timeToOverflowMin: null,
        isOverflowing: false,
        control: 'NONE',
        bottleneck: 'NONE',
        depthSeries: new Float64Array(this.nSeries),
      },
      sensors: network.sensors.map((sensor) => ({
        id: sensor.sensor_id,
        sensor,
        depthMm: 0,
        dhDtMmMin: 0,
        turbulence: 0,
        capacityPct: 0,
        froude: null,
        blockageP: sensor.hardware === 'JETSON_YOLO_TRASHRACK' ? 0 : null,
        hRatio: 0,
        vbatV: sensor.vbat_v,
        anomaly: 'NORMAL',
        anomalyCode: 0,
        saturated: [],
        payload: 0,
        payloadHex: '0x00000000',
        payloadBytes: '00 00 00 00',
        liveSurge: false,
      })),
      statusCounts: { NORMAL: 0, ELEVATED: 0, CRITICAL: 0, SURCHARGED: 0 },
    };
  }

  static fromFiles(network: NetworkFile, lut: LutFile): LutInterpolator {
    return new LutInterpolator({ network, lut });
  }

  private readonly isTunnel: Uint8Array;

  /** Piecewise-linear lookup on a tunnel conduit's flow curve; writes into state arrays. */
  private curve(T: LutInterpolator['tunnel'][number], q: number, i: number) {
    const C = this.state.conduits;
    const n = T.q.length;
    let j = 0;
    if (q <= T.q[0]) j = 0;
    else if (q >= T.q[n - 1]) j = n - 2;
    else while (q > T.q[j + 1]) j++;
    const span = T.q[j + 1] - T.q[j];
    const t = n < 2 || span <= 0 ? 0 : Math.min(Math.max((q - T.q[j]) / span, 0), 1);
    const at = (a: Float64Array) => a[j] + t * (a[Math.min(j + 1, n - 1)] - a[j]);
    C.flow[i] = q;
    C.capacity[i] = at(T.cap);
    C.depth[i] = at(T.depth);
    C.velocity[i] = at(T.vel);
    C.pressurized[i] = at(T.press);
    C.jump[i] = at(T.jump);
    const f0 = T.fr[j];
    const f1 = T.fr[Math.min(j + 1, n - 1)];
    C.froude[i] = C.pressurized[i] >= 0.5 || Number.isNaN(f0) || Number.isNaN(f1) ? (Number.isNaN(f0) ? f1 : f0) : f0 + t * (f1 - f0);
    if (C.pressurized[i] >= 0.5) C.froude[i] = NaN;
  }

  private locate(axis: number[], v: number): [number, number] {
    const n = axis.length;
    if (v <= axis[0]) return [0, 0];
    if (v >= axis[n - 1]) return [n - 2, 1];
    let i = 0;
    while (v > axis[i + 1]) i++;
    return [i, (v - axis[i]) / (axis[i + 1] - axis[i])];
  }

  private lerp(arr: Float64Array, stride: number, j: number): number {
    const { cell, w } = this;
    return w[0] * arr[cell[0] * stride + j] + w[1] * arr[cell[1] * stride + j] + w[2] * arr[cell[2] * stride + j] + w[3] * arr[cell[3] * stride + j];
  }

  private lerpNullable(arr: Float64Array, stride: number, j: number): number {
    let sum = 0;
    let wsum = 0;
    for (let c = 0; c < 4; c++) {
      const v = arr[this.cell[c] * stride + j];
      if (!Number.isNaN(v)) {
        sum += this.w[c] * v;
        wsum += this.w[c];
      }
    }
    return wsum >= 0.5 - 1e-9 ? sum / wsum : NaN;
  }

  /** Interpolate the full twin state for arbitrary slider values. Mutates and returns `state`. */
  evaluate(rainMmHr: number, blockagePct: number): TwinState {
    const st = this.state;
    const rain = Math.min(Math.max(rainMmHr, this.rainAxis[0]), this.rainAxis[this.rainAxis.length - 1]);
    const block = Math.min(Math.max(blockagePct, this.blockAxis[0]), this.blockAxis[this.blockAxis.length - 1]);
    const [ri, rt] = this.locate(this.rainAxis, rain);
    const [bi, bt] = this.locate(this.blockAxis, block);
    const nb = this.blockAxis.length;
    this.cell[0] = ri * nb + bi;
    this.cell[1] = (ri + 1) * nb + bi;
    this.cell[2] = ri * nb + bi + 1;
    this.cell[3] = (ri + 1) * nb + bi + 1;
    this.w[0] = (1 - rt) * (1 - bt);
    this.w[1] = rt * (1 - bt);
    this.w[2] = (1 - rt) * bt;
    this.w[3] = rt * bt;
    st.rev++;
    st.rain = rain;
    st.blockagePct = block;
    const p = block / 100;

    // nodes
    for (let i = 0; i < this.nN; i++) {
      st.nodes.hgl[i] = this.lerp(this.nHgl, this.nN, i);
      st.nodes.flooding[i] = this.lerp(this.nFlood, this.nN, i) >= 0.5 ? 1 : 0;
    }

    // lagoon
    const L = st.lagoon;
    L.depthM = this.lerp(this.lf[0], 1, 0);
    L.surfaceElevM = this.lerp(this.lf[1], 1, 0);
    L.inundationRadiusM = this.lerp(this.lf[2], 1, 0);
    L.inundationAreaM2 = this.lerp(this.lf[3], 1, 0);
    L.rackCapacityCms = this.lerp(this.lRackN, 1, 0) * (1 - p);
    L.inflowCms = this.lerp(this.lf[6], 1, 0);
    L.spillCms = this.lerp(this.lf[7], 1, 0);
    L.dhDtMmMin = this.lerp(this.lf[8], 1, 0);
    const rack = this.net.orifices[0];
    const stage = L.depthM - this.poolDepth;
    L.orificeFlowCms = stage > 0 ? Math.min(L.rackCapacityCms, this.tunnelLimitCms) : this.lerp(this.lf[4], 1, 0);
    L.xiRack = rack.xi_clean / (1 - p) ** 2;
    const vApp = stage > 0 ? L.orificeFlowCms / (rack.width_m * Math.min(stage, rack.height_m)) : 0;
    L.headLossM = (L.xiRack * vApp * vApp) / (2 * G);
    L.openAreaPct = (1 - p) * 100;
    const rate = this.lerp(this.lRate, 1, 0);
    L.timeToOverflowMin = rate > 1e-6 ? 1 / rate : null;
    L.isOverflowing = L.depthM > this.maxDepth;
    for (let j = 0; j < this.nSeries; j++) L.depthSeries[j] = this.lerp(this.lSeries, this.nSeries, j);
    if (L.depthM <= this.poolDepth + 1e-6) {
      L.control = 'NONE';
      L.bottleneck = 'NONE';
    } else if (L.rackCapacityCms < this.tunnelLimitCms) {
      L.control = 'TRASH_RACK';
      L.bottleneck = 'TRASH_RACK_ORIFICE';
    } else {
      L.control = 'TUNNEL_CHOKE';
      L.bottleneck = this.bottleneckChoke;
    }

    // conduits
    const C = st.conduits;
    const counts = st.statusCounts;
    counts.NORMAL = counts.ELEVATED = counts.CRITICAL = counts.SURCHARGED = 0;
    for (const T of this.tunnel) {
      const q = Math.max(L.orificeFlowCms, 0);
      this.curve(T, q, T.i);
    }
    for (let i = 0; i < this.nC; i++) {
      if (this.isTunnel[i]) {
        const s = C.pressurized[i] >= 0.5 ? 3 : C.capacity[i] >= CRITICAL ? 2 : C.capacity[i] >= ELEVATED ? 1 : 0;
        C.status[i] = s;
        counts[STATUSES[s]]++;
        continue;
      }
      C.capacity[i] = this.lerp(this.cf[0], this.nC, i);
      C.depth[i] = this.lerp(this.cf[1], this.nC, i);
      C.flow[i] = this.lerp(this.cf[2], this.nC, i);
      C.velocity[i] = this.lerp(this.cf[3], this.nC, i);
      C.pressurized[i] = this.lerp(this.cPress, this.nC, i);
      C.jump[i] = this.lerp(this.cJump, this.nC, i);
      C.froude[i] = C.pressurized[i] >= 0.5 ? NaN : this.lerpNullable(this.cFr, this.nC, i);
      const s = C.pressurized[i] >= 0.5 ? 3 : C.capacity[i] >= CRITICAL ? 2 : C.capacity[i] >= ELEVATED ? 1 : 0;
      C.status[i] = s;
      counts[STATUSES[s]]++;
    }

    // sensors
    for (let i = 0; i < this.nS; i++) {
      const S = st.sensors[i];
      const kind = S.sensor.attached_kind;
      S.depthMm = this.lerp(this.sDepth, this.nS, i);
      S.dhDtMmMin = this.lerp(this.sDhdt, this.nS, i);
      S.turbulence = this.lerp(this.sTurb, this.nS, i);
      S.capacityPct = this.lerp(this.sCap, this.nS, i);
      S.liveSurge = false;
      const fr = this.lerpNullable(this.sFr, this.nS, i);
      S.froude = Number.isNaN(fr) ? null : fr;
      S.hRatio = S.depthMm / 1000 / this.sensorRise[i];
      if (S.sensor.hardware === 'JETSON_YOLO_TRASHRACK') {
        S.blockageP = p;
        S.capacityPct = p * 100;
        S.anomaly = L.isOverflowing ? 'SURCHARGED' : p >= 0.5 ? 'TRASH_BLOCKAGE' : 'NORMAL';
      } else {
        let pressurized: boolean;
        if (kind === 'CONDUIT') pressurized = C.pressurized[this.sensorConduit[i]] >= 0.5 || S.hRatio >= 1;
        else if (kind === 'STORAGE') pressurized = L.isOverflowing;
        else pressurized = L.isOverflowing || S.hRatio >= 1;
        S.anomaly = classify(S.hRatio, S.dhDtMmMin, S.turbulence, S.froude, pressurized);
      }
      S.anomalyCode = ANOMALY_CODES[S.anomaly];
      S.saturated.length = 0;
      if (S.depthMm > DEPTH_MAX_MM) S.saturated.push('depth_mm');
      if (S.dhDtMmMin > DHDT_MAX || S.dhDtMmMin < DHDT_MIN) S.saturated.push('dh_dt_mm_min');
      if (S.capacityPct > CAP_MAX_PCT) S.saturated.push('cap_pct');
      S.payload = packTelemetryPayload(S.depthMm, S.dhDtMmMin, S.capacityPct, S.anomalyCode, S.vbatV);
      S.payloadHex = toHex(S.payload);
      S.payloadBytes = toBytesBE(S.payload);
    }
    return st;
  }
}

export type IntensityClass = { label: string; color: string };

/** Intensity bands used by the HUD (project-defined, see CLAUDE.md §12). */
export function rainfallClass(mmHr: number): IntensityClass {
  if (mmHr <= 0.05) return { label: 'Dry', color: '#64748B' };
  if (mmHr < 50) return { label: 'Light', color: '#12B5CB' };
  if (mmHr < 100) return { label: 'Moderate–Heavy', color: '#FCC934' };
  if (mmHr <= 200) return { label: 'Heavy', color: '#FA903E' };
  return { label: 'Torrential', color: '#F538A0' };
}
