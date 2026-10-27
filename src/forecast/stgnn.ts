// Physics-informed ST-GNN forecaster, line-for-line mirror of backend/stgnn.py (Phase 7B).
// Runs in the browser when no backend frame carries a forecast (Simulation mode, static /
// serverless hosting, backend offline). tests/frontend/fixtures/stgnn_golden.json (written by
// scripts/gen_frontend_goldens.py) locks this file to the Python reference.
//
// Graph: 65 nodes, 63 conduit edges. A_hydro[j][i] = g_c = 1 - exp(-dt / tau_c) for conduit
// c: i -> j, tau_c = L / (5/3 V), V = max(V_now, 0.25 V_full), V_full = Q_full / A_full (Manning
// with S = sin(atan S0)). Node messages: upstream conduit outflows + C i f_FEWS A / 360 (+ base).
// The 3 ha lagoon is RK4-integrated: graph inflow + direct rain - min(Q_rack(h, p), Q_choke) -
// spill - seepage, Kirschmer xi(p) = xi_clean (1-p)^-2 inside Q_rack. 9-member rain ensemble.
import type { NetworkFile, TwinNode } from '../types/twin';

export const G = 9.80665;
export const DT_S = 60;
export const STEPS = 60;
export const HORIZONS_MIN = [15, 30, 60] as const;
export const OVERFLOW_HORIZON_MIN = 720;
export const TAIL_DT_MIN = 5;
const BASEFLOW_CMS_PER_HA = 0.0005;
const LAGOON_SEEPAGE_CMS = 0.01;
const SPILL_WEIR_COEFF = 1.7;
const SPILL_CREST_LENGTH_M = 60;
const RACK_TABLE_N = 721;
const RACK_TABLE_H_M = 9;
const CELERITY_FACTOR = 5 / 3;
const MIN_CELERITY_MS = 0.3;
const VFULL_FLOOR = 0.25;
export const ENSEMBLE_Z = [-1.5932, -0.9674, -0.5895, -0.2822, 0.0, 0.2822, 0.5895, 0.9674, 1.5932];
const CENTRAL = 4;
const SIGMA0 = 0.1;
const SIGMA_PER_HOUR = 0.3;
const ASSIM_MIN = 0.25;
const ASSIM_MAX = 4.0;
const CAP_MAX = 1.27;
const PCT_MAX = 127;
export const FORECAST_ALARM_PCT = 80;
const SURCHARGE_PCT = 100;
export const MODEL_NAME = 'STGNN-PHYS-v1';

export interface FewsStationDef {
  station: string;
  lon: number;
  lat: number;
  elevation_m: number;
}

export interface StormDef {
  id: string;
  label: string;
  duration_min: number;
  step_min: number;
  peak_mm_hr: number;
  total_mm: number;
  synthetic: boolean;
  note: string;
  rate_mm_hr: number[];
}

export interface PrecipLibrary {
  reference_elevation_m: number;
  orographic_lapse_per_100m: number;
  idw_power: number;
  fews_stations: FewsStationDef[];
  storms: StormDef[];
}

export interface ForecastInput {
  rain_mm_hr: number[];
  persist_rain_mm_hr: number;
  blockage_pct: number;
  lagoon_depth_m: number;
  conduit_flow_cms: number[];
  conduit_velocity_ms: number[];
  conduit_capacity: number[];
  sensor_capacity_pct: Record<string, number>;
  sensor_reference_pct: Record<string, number>;
  source: ForecastSource;
}

export interface ForecastSource {
  kind: 'LIVE_FEED' | 'HISTORICAL' | 'TWIN' | 'HARDWARE';
  label: string;
  [k: string]: unknown;
}

export interface ForecastSensor {
  capacity_pct: number;
  p05: number;
  p95: number;
  surcharge_probability_pct: number;
}

export interface ForecastHorizon {
  minutes: number;
  rainfall_mm_hr: number;
  lagoon_depth_m: number;
  lagoon_depth_p05_m: number;
  lagoon_depth_p95_m: number;
  surface_elev_m: number;
  surface_elev_p05_m: number;
  surface_elev_p95_m: number;
  time_to_overflow_min: number | null;
  surcharge_probability_pct: number;
  conduits_over_capacity: number;
  next_bottleneck: { sensor_id: string; capacity_pct: number; minutes_to_critical: number | null };
  sensors: Record<string, ForecastSensor>;
}

export interface Forecast {
  model: string;
  step_min: number;
  members: number;
  graph: { nodes: number; edges: number };
  source: ForecastSource;
  rain_trajectory_mm_hr: number[];
  time_to_overflow_min: number | null;
  horizons: ForecastHorizon[];
  generated_at?: string;
}

const round = (x: number, nd: number) => {
  // Python round() on the values we emit: half-to-even only matters on exact ties, which these
  // physics outputs never hit; the golden tests compare with a tolerance anyway.
  const k = 10 ** nd;
  return Math.round(x * k) / k;
};

export function haversineM(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const [lon1, lat1, lon2, lat2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

export const sigmaAt = (minute: number) => SIGMA0 + (SIGMA_PER_HOUR * minute) / 60;

export function percentile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Orographic-lapse IDW weight of the FEWS gauges at each node, runoff-area-normalised. */
export function fewsFactors(nodes: TwinNode[], lib: PrecipLibrary): number[] {
  const out = nodes.map((n) => {
    let num = 0;
    let den = 0;
    for (const s of lib.fews_stations) {
      const d = Math.max(haversineM([n.coordinates[0], n.coordinates[1]], [s.lon, s.lat]), 100);
      const w = 1 / d ** lib.idw_power;
      const station = 1 + (lib.orographic_lapse_per_100m * (s.elevation_m - lib.reference_elevation_m)) / 100;
      const local = 1 + (lib.orographic_lapse_per_100m * (n.rim_elev_m - s.elevation_m)) / 100;
      num += w * station * local;
      den += w;
    }
    return num / den;
  });
  let area = 0;
  let mean = 0;
  nodes.forEach((n, i) => {
    if (n.type === 'STORAGE') return;
    area += n.catchment_area_ha;
    mean += out[i] * n.catchment_area_ha;
  });
  mean /= area;
  return out.map((f) => f / mean);
}

export function stationRain(lib: PrecipLibrary, basin: number) {
  return lib.fews_stations.map((s) => {
    const factor = 1 + (lib.orographic_lapse_per_100m * (s.elevation_m - lib.reference_elevation_m)) / 100;
    return { station: s.station, elevation_m: s.elevation_m, factor: round(factor, 4), rainfall_mm_hr: round(Math.max(basin, 0) * factor, 2) };
  });
}

/** Linear interpolation of a 10-min hyetograph; storms loop after their duration. */
export function hyetographRate(storm: StormDef, minute: number): number {
  const r = storm.rate_mm_hr;
  const dur = storm.duration_min;
  const m = dur > 0 ? ((minute % dur) + dur) % dur : 0;
  const x = m / storm.step_min;
  const i = Math.min(Math.floor(x), r.length - 2);
  return r[i] + (r[i + 1] - r[i]) * (x - i);
}

export function hyetographTrajectory(storm: StormDef, minute: number): number[] {
  return Array.from({ length: STEPS + 1 }, (_, t) => hyetographRate(storm, minute + t));
}

/** numpy.interp on an ascending grid. */
function interp(x: number, xp: Float64Array, fp: Float64Array): number {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  return fp[lo] + ((x - xp[lo]) * (fp[hi] - fp[lo])) / (xp[hi] - xp[lo]);
}

export class STGNNForecaster {
  readonly nNodes: number;
  readonly nCond: number;
  readonly conduitIds: string[];
  private readonly nodes: TwinNode[];
  private readonly fromIdx: Int32Array;
  private readonly toIdx: Int32Array;
  private readonly length: Float64Array;
  private readonly qFull: Float64Array;
  private readonly vFull: Float64Array;
  private readonly cid = new Map<string, number>();
  private readonly lagoonIdx: number;
  private readonly intakeIdx: number;
  private readonly lag: { area: number; bottom: number; max: number; pool: number; invert: number; frustumA: number; fullVolume: number };
  private readonly rack: NetworkFile['orifices'][number];
  private readonly rackOpen: number;
  private readonly xiClean: number;
  readonly fFews: number[];
  private readonly runoffPerMmhr: Float64Array;
  private readonly baseflow: Float64Array;
  readonly subtree: number[][];
  readonly upstreamAreaHa: number[];
  private readonly rackH: Float64Array;
  private readonly rackCache = new Map<number, Float64Array>();
  private readonly sensors: NetworkFile['sensors'];

  constructor(
    network: NetworkFile,
    readonly library: PrecipLibrary,
    readonly qChoke: number,
  ) {
    this.nodes = network.nodes.filter((n) => n.is_active);
    const conduits = network.conduits.filter((c) => c.is_active);
    this.sensors = network.sensors.filter((s) => s.is_active);
    const nid = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.nNodes = this.nodes.length;
    this.nCond = conduits.length;
    this.conduitIds = conduits.map((c) => c.id);
    this.fromIdx = Int32Array.from(conduits, (c) => nid.get(c.from_node)!);
    this.toIdx = Int32Array.from(conduits, (c) => nid.get(c.to_node)!);
    this.length = Float64Array.from(conduits, (c) => c.length_m);
    this.qFull = Float64Array.from(conduits, (c) => c.q_full_cms);
    this.vFull = Float64Array.from(conduits, (c) => c.q_full_cms / c.geometry.area_full_m2);
    conduits.forEach((c, k) => this.cid.set(c.id, k));
    const lag = network.lagoon;
    this.lagoonIdx = nid.get(lag.node_id)!;
    this.rack = network.orifices[0];
    // exact bar geometry (the JSON's xi_clean / bar_open_ratio are rounded to 4 dp)
    const bt = this.rack.bar_thickness_m;
    const bs = this.rack.bar_clear_spacing_m;
    this.rackOpen = bs / (bs + bt);
    this.xiClean = this.rack.kirschmer_beta * (bt / bs) ** (4 / 3) * Math.sin((this.rack.bar_angle_deg * Math.PI) / 180);
    this.intakeIdx = nid.get(this.rack.to_node)!;
    const frustumA = (lag.area_m2 - lag.bottom_area_m2) / (2 * lag.max_depth_m);
    this.lag = {
      area: lag.area_m2,
      bottom: lag.bottom_area_m2,
      max: lag.max_depth_m,
      pool: lag.permanent_pool_depth_m,
      invert: lag.invert_elev_m,
      frustumA,
      fullVolume: lag.bottom_area_m2 * lag.max_depth_m + frustumA * lag.max_depth_m ** 2,
    };
    this.fFews = fewsFactors(this.nodes, library);
    this.runoffPerMmhr = Float64Array.from(this.nodes, (n, i) => (n.type === 'STORAGE' ? 0 : ((n.runoff_coeff ?? 0) * n.catchment_area_ha * this.fFews[i]) / 360));
    this.baseflow = Float64Array.from(this.nodes, (n) => (n.type === 'STORAGE' ? 0 : BASEFLOW_CMS_PER_HA * n.catchment_area_ha));
    const incoming = new Map<number, number[]>();
    for (let k = 0; k < this.nCond; k++) {
      const to = this.toIdx[k];
      if (!incoming.has(to)) incoming.set(to, []);
      incoming.get(to)!.push(k);
    }
    this.subtree = [];
    for (let k = 0; k < this.nCond; k++) {
      const seen: number[] = [];
      const stack = [k];
      while (stack.length) {
        const c = stack.pop()!;
        seen.push(c);
        stack.push(...(incoming.get(this.fromIdx[c]) ?? []));
      }
      this.subtree.push(seen.sort((a, b) => a - b));
    }
    this.upstreamAreaHa = this.subtree.map((sub) => sub.reduce((a, c) => a + this.nodes[this.fromIdx[c]].catchment_area_ha, 0));
    this.rackH = Float64Array.from({ length: RACK_TABLE_N }, (_, k) => (k * RACK_TABLE_H_M) / (RACK_TABLE_N - 1));
  }

  // ------------------------------------------------------------------ hydraulics (generator)
  private rackDirect(h: number, p: number): number {
    if (h <= 0) return 0;
    const r = this.rack;
    const bEff = r.width_m * this.rackOpen * (1 - p);
    const weir = (2 / 3) * r.discharge_coeff * Math.sqrt(2 * G) * bEff * h ** 1.5;
    if (h <= r.height_m) return weir;
    const orifice = r.discharge_coeff * bEff * r.height_m * Math.sqrt(2 * G * Math.max(h - r.height_m / 2, 0));
    const w = Math.min((h - r.height_m) / (0.2 * r.height_m), 1);
    return (1 - w) * weir + w * orifice;
  }

  rackTable(p: number): Float64Array {
    const key = Math.floor(p * 200 + 0.5) / 200;
    let table = this.rackCache.get(key);
    if (table) return table;
    const xi = this.xiClean / (1 - key) ** 2;
    table = new Float64Array(RACK_TABLE_N);
    for (let k = 0; k < RACK_TABLE_N; k++) {
      const h = this.rackH[k];
      if (h <= 0) continue;
      let hi = this.rackDirect(h, key);
      let lo = 0;
      const width = this.rack.width_m * Math.min(h, this.rack.height_m);
      for (let it = 0; it < 60; it++) {
        const mid = 0.5 * (lo + hi);
        const v = mid / width;
        if (mid - this.rackDirect(h - (xi * v * v) / (2 * G), key) > 0) hi = mid;
        else lo = mid;
      }
      table[k] = 0.5 * (lo + hi);
    }
    this.rackCache.set(key, table);
    return table;
  }

  lagoonVolume(h: number): number {
    const L = this.lag;
    return h <= L.max ? L.bottom * h + L.frustumA * h * h : L.fullVolume + L.area * (h - L.max);
  }

  lagoonDepth(v: number): number {
    const L = this.lag;
    const vol = Math.max(v, 0);
    if (vol <= L.fullVolume) return (-L.bottom + Math.sqrt(L.bottom * L.bottom + 4 * L.frustumA * vol)) / (2 * L.frustumA);
    return L.max + (vol - L.fullVolume) / L.area;
  }

  lagoonArea(h: number): number {
    const L = this.lag;
    return h >= L.max ? L.area : L.bottom + ((L.area - L.bottom) * Math.max(h, 0)) / L.max;
  }

  private lagoonRate(vol: number, qIn: number, rain: number, table: Float64Array): [number, number] {
    const h = this.lagoonDepth(vol);
    const hs = h - this.lag.pool;
    const qRack = hs > 0 ? interp(hs, this.rackH, table) : 0;
    const qOut = Math.min(qRack, this.qChoke);
    const spill = h > this.lag.max ? SPILL_WEIR_COEFF * SPILL_CREST_LENGTH_M * Math.max(h - this.lag.max, 0) ** 1.5 : 0;
    const seep = vol > 0 ? LAGOON_SEEPAGE_CMS : 0;
    const direct = (rain * this.fFews[this.lagoonIdx] * this.lagoonArea(h)) / 3.6e6;
    return [qIn + direct - qOut - spill - seep, qOut];
  }

  private rk4(vol: number, qIn: number, rain: number, table: Float64Array, dt = DT_S): [number, number] {
    const [k1, q1] = this.lagoonRate(vol, qIn, rain, table);
    const [k2, q2] = this.lagoonRate(vol + 0.5 * dt * k1, qIn, rain, table);
    const [k3, q3] = this.lagoonRate(vol + 0.5 * dt * k2, qIn, rain, table);
    const [k4, q4] = this.lagoonRate(vol + dt * k3, qIn, rain, table);
    return [Math.max(vol + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4), 0), (q1 + 2 * q2 + 2 * q3 + q4) / 6];
  }

  gates(vNow: ArrayLike<number>): Float64Array {
    return Float64Array.from({ length: this.nCond }, (_, c) => {
      const cel = Math.max(CELERITY_FACTOR * Math.max(vNow[c], VFULL_FLOOR * this.vFull[c]), MIN_CELERITY_MS);
      return 1 - Math.exp((-DT_S * cel) / this.length[c]);
    });
  }

  /** Dense A_hydro (nNodes x nNodes): A[j][i] = gate of conduit i -> j. */
  adjacency(vNow: ArrayLike<number>): Float64Array[] {
    const g = this.gates(vNow);
    const a = Array.from({ length: this.nNodes }, () => new Float64Array(this.nNodes));
    for (let c = 0; c < this.nCond; c++) a[this.toIdx[c]][this.fromIdx[c]] = g[c];
    return a;
  }

  // ------------------------------------------------------------------ forecast
  forecast(inp: ForecastInput): Forecast {
    if (inp.rain_mm_hr.length !== STEPS + 1) throw new Error('rain_mm_hr must hold 61 values (minutes 0..60)');
    const p = Math.min(Math.max(inp.blockage_pct, 0), 95) / 100;
    const table = this.rackTable(p);
    const C = this.nCond;
    const N = this.nNodes;
    const qNow = inp.conduit_flow_cms;
    const capNow = inp.conduit_capacity;
    const g = this.gates(inp.conduit_velocity_ms);

    // assimilation: a persistent measured / expected ratio scales the sensor's upstream subtree
    // storage and its nodes' runoff (largest subtrees first: the most local sensor wins)
    const mult = new Float64Array(C).fill(1);
    const nodeMult = new Float64Array(N).fill(1);
    const condSensors = this.sensors.filter((s) => s.attached_kind === 'CONDUIT' && this.cid.has(s.attached_to));
    const ordered = condSensors
      .map((s, i) => ({ s, i, n: this.subtree[this.cid.get(s.attached_to)!].length }))
      .sort((a, b) => b.n - a.n || a.i - b.i);
    for (const { s } of ordered) {
      const k = this.cid.get(s.attached_to)!;
      const measured = inp.sensor_capacity_pct[s.sensor_id];
      const expected = inp.sensor_reference_pct[s.sensor_id];
      if (measured === undefined || expected === undefined || expected <= 1) continue;
      const ratio = Math.min(Math.max(measured / expected, ASSIM_MIN), ASSIM_MAX);
      for (const c of this.subtree[k]) {
        mult[c] = ratio;
        nodeMult[this.fromIdx[c]] = ratio;
      }
    }

    const M = ENSEMBLE_Z.length;
    const W = Array.from({ length: M }, () => Float64Array.from({ length: C }, (_, c) => (qNow[c] * mult[c] * DT_S) / g[c]));
    const vol = new Float64Array(M).fill(this.lagoonVolume(inp.lagoon_depth_m));
    const depth = Array.from({ length: M }, () => new Float64Array(STEPS + 1));
    const flow = Array.from({ length: M }, () => Array.from({ length: STEPS + 1 }, () => new Float64Array(C)));
    for (let m = 0; m < M; m++) {
      depth[m][0] = this.lagoonDepth(vol[m]);
      for (let c = 0; c < C; c++) flow[m][0][c] = (W[m][c] * g[c]) / DT_S;
    }
    const qInLagoon = new Float64Array(M);
    const out = new Float64Array(C);
    const inflow = new Float64Array(N);
    for (let t = 0; t < STEPS; t++) {
      const sig = sigmaAt(t);
      for (let m = 0; m < M; m++) {
        const rain = inp.rain_mm_hr[t] * Math.exp(ENSEMBLE_Z[m] * sig);
        const w = W[m];
        for (let c = 0; c < C; c++) out[c] = (w[c] * g[c]) / DT_S;
        for (let n = 0; n < N; n++) inflow[n] = (rain * this.runoffPerMmhr[n] + this.baseflow[n]) * nodeMult[n];
        for (let c = 0; c < C; c++) inflow[this.toIdx[c]] += out[c];
        qInLagoon[m] = inflow[this.lagoonIdx];
        const [v2, qRack] = this.rk4(vol[m], qInLagoon[m], rain, table);
        vol[m] = v2;
        inflow[this.intakeIdx] += qRack;
        for (let c = 0; c < C; c++) w[c] += DT_S * (inflow[this.fromIdx[c]] - out[c]);
        depth[m][t + 1] = this.lagoonDepth(vol[m]);
        for (let c = 0; c < C; c++) flow[m][t + 1][c] = (w[c] * g[c]) / DT_S;
      }
    }

    // lagoon-only tail to 12 h
    const overflowMin = new Float64Array(M).fill(NaN);
    for (let m = 0; m < M; m++) {
      for (let t = 0; t <= STEPS; t++) {
        if (depth[m][t] >= this.lag.max) {
          overflowMin[m] = t;
          break;
        }
      }
    }
    const tailSig = sigmaAt(STEPS);
    const tailRain = ENSEMBLE_Z.map((z) => inp.persist_rain_mm_hr * Math.exp(z * tailSig));
    const fullRate = ENSEMBLE_Z.map((_, m) => this.lagoonRate(this.lag.fullVolume, qInLagoon[m], tailRain[m], table)[0]);
    let t = STEPS;
    while (t < OVERFLOW_HORIZON_MIN && overflowMin.some((x) => Number.isNaN(x))) {
      let alive = false;
      for (let m = 0; m < M; m++) {
        const rate = this.lagoonRate(vol[m], qInLagoon[m], tailRain[m], table)[0];
        if (Number.isNaN(overflowMin[m]) && rate > 0 && fullRate[m] > 0) alive = true;
      }
      if (!alive) break;
      for (let m = 0; m < M; m++) {
        const hPrev = this.lagoonDepth(vol[m]);
        vol[m] = this.rk4(vol[m], qInLagoon[m], tailRain[m], table, TAIL_DT_MIN * DT_S)[0];
        const h = this.lagoonDepth(vol[m]);
        if (Number.isNaN(overflowMin[m]) && h >= this.lag.max) {
          const frac = (this.lag.max - hPrev) / Math.max(h - hPrev, 1e-12);
          overflowMin[m] = t + TAIL_DT_MIN * Math.min(Math.max(frac, 0), 1);
        }
      }
      t += TAIL_DT_MIN;
    }

    // sensor fullness per member / minute
    const cap = (m: number, tt: number, c: number) =>
      Math.min(Math.max(capNow[c] + (flow[m][tt][c] - qNow[c]) / this.qFull[c], 0), CAP_MAX);
    const series = new Map<string, Float64Array[]>();
    for (const s of this.sensors) {
      const now = inp.sensor_capacity_pct[s.sensor_id] ?? 0;
      const rows = Array.from({ length: M }, (_, m) =>
        Float64Array.from({ length: STEPS + 1 }, (_, tt) => {
          let v: number;
          if (s.hardware === 'JETSON_YOLO_TRASHRACK') v = now;
          else if (s.attached_kind === 'CONDUIT' && this.cid.has(s.attached_to)) {
            const k = this.cid.get(s.attached_to)!;
            v = now + 100 * (cap(m, tt, k) - cap(m, 0, k));
          } else if (s.attached_kind === 'STORAGE') v = now + (100 * (depth[m][tt] - depth[m][0])) / this.lag.max;
          else v = now + (100 * (depth[m][tt] - depth[m][0])) / this.rack.height_m;
          return Math.min(Math.max(v, 0), PCT_MAX);
        }),
      );
      series.set(s.sensor_id, rows);
    }
    const hydraulic = this.sensors.filter((s) => s.hardware !== 'JETSON_YOLO_TRASHRACK').map((s) => s.sensor_id);
    const tOvf = overflowMin[CENTRAL];

    const horizons: ForecastHorizon[] = HORIZONS_MIN.map((hz) => {
      const d = Array.from({ length: M }, (_, m) => depth[m][hz]);
      const ds = [...d].sort((a, b) => a - b);
      const sensors: Record<string, ForecastSensor> = {};
      for (const s of this.sensors) {
        const v = series.get(s.sensor_id)!.map((row) => row[hz]);
        const vs = [...v].sort((a, b) => a - b);
        sensors[s.sensor_id] = {
          capacity_pct: round(v[CENTRAL], 1),
          p05: round(percentile(vs, 0.05), 1),
          p95: round(percentile(vs, 0.95), 1),
          surcharge_probability_pct: round((100 * v.filter((x) => x >= SURCHARGE_PCT).length) / M, 1),
        };
      }
      let anyCount = 0;
      for (let m = 0; m < M; m++) {
        const any = hydraulic.some((sid) => series.get(sid)![m][hz] >= SURCHARGE_PCT) || d[m] >= this.lag.max;
        if (any) anyCount++;
      }
      let crit = hydraulic[0];
      for (const sid of hydraulic) if (series.get(sid)![CENTRAL][hz] > series.get(crit)![CENTRAL][hz]) crit = sid;
      const critRow = series.get(crit)![CENTRAL];
      const hit = critRow.findIndex((x) => x >= FORECAST_ALARM_PCT);
      let over = 0;
      for (let c = 0; c < C; c++) if (cap(CENTRAL, hz, c) >= 1) over++;
      return {
        minutes: hz,
        rainfall_mm_hr: round(inp.rain_mm_hr[hz], 2),
        lagoon_depth_m: round(d[CENTRAL], 3),
        lagoon_depth_p05_m: round(percentile(ds, 0.05), 3),
        lagoon_depth_p95_m: round(percentile(ds, 0.95), 3),
        surface_elev_m: round(this.lag.invert + d[CENTRAL], 3),
        surface_elev_p05_m: round(this.lag.invert + percentile(ds, 0.05), 3),
        surface_elev_p95_m: round(this.lag.invert + percentile(ds, 0.95), 3),
        time_to_overflow_min: Number.isNaN(tOvf) ? null : round(Math.max(tOvf - hz, 0), 1),
        surcharge_probability_pct: round((100 * anyCount) / M, 1),
        conduits_over_capacity: over,
        next_bottleneck: { sensor_id: crit, capacity_pct: round(critRow[hz], 1), minutes_to_critical: hit < 0 ? null : hit },
        sensors,
      };
    });
    return {
      model: MODEL_NAME,
      step_min: 1,
      members: M,
      graph: { nodes: N, edges: C },
      source: inp.source,
      rain_trajectory_mm_hr: inp.rain_mm_hr.map((x) => round(x, 2)),
      time_to_overflow_min: Number.isNaN(tOvf) ? null : round(tOvf, 1),
      horizons,
    };
  }
}
