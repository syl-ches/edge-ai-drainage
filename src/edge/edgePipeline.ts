// Browser port of the on-device edge pipeline (backend/edge_dsp.py::run_cycle, which
// firmware/.../edge_core.hpp mirrors), restricted to the no-conduit-geometry branch used by the
// Arduino / aquarium rig: thermal compensation -> 5-point sliding median + variance ->
// (bench / aquarium standpipe scaling, x60 time compression) -> adaptive Kalman -> INT8
// classifier -> sleep FSM -> 32-bit payload. tests/frontend/fixtures/edge_golden.json locks it to
// the Python reference. Constants are CLAUDE.md §10 / §14.
import { CAP_MAX_PCT, DEPTH_MAX_MM, DHDT_MAX, DHDT_MIN, packTelemetryPayload, toHex } from '../utils/payloadCodec';

export const SPEED_OF_SOUND_REF = 343.2;
export const BLIND_ZONE_MM = 30;
export const MAX_RANGE_MM = 4500;
export const BURST_LEN = 10;
export const MEDIAN_WIN = 5;
export const KF_Q = 9.0;
export const KF_R_BASE = 25.0;
export const KF_ALPHA = 0.5;
export const KF_P0_H = 400.0;
export const KF_P0_V = 100.0;
export const KF_MIN_DT_MIN = 1e-3;
export const STANDPIPE_FULL_BORE_FRACTION = 0.74;
export const BENCH_TIME_COMPRESSION = 60;
const Q_H_SCALE = 100;
const Q_S_SCALE = 16;
const Q_E_SCALE = 16;
const H_SURCHARGE_Q = 100;
const H_BLOCKAGE_Q = 60;
const V_FLASH_Q = 15;
const S_CALM_Q = 58;
const S_CHOP_Q = 74;
const VBAT_LOW_V = 3.3;
const FSM_CRITICAL_H = 0.75;
const FSM_ACTIVE_H = 0.05;
const FSM_ACTIVE_DHDT = 2.0;
export const FSM_STATES = ['STATE_DRY', 'STATE_ACTIVE_RAIN', 'STATE_CRITICAL_SURGE'] as const;

const roundHalfUp = (x: number) => Math.floor(x + 0.5);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const thermalCompensate = (dRawMm: number, tempC: number) => (dRawMm * (331.3 + 0.606 * tempC)) / SPEED_OF_SOUND_REF;

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/** Median of 5-point sliding medians, population variance, ln(1 + variance). */
export function medianAndVariance(samples: number[]): [number, number, number] {
  const n = samples.length;
  const med = n < MEDIAN_WIN ? median(samples) : median(Array.from({ length: n - MEDIAN_WIN + 1 }, (_, i) => median(samples.slice(i, i + MEDIAN_WIN))));
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
  return [med, variance, Math.log1p(variance)];
}

export interface KalmanState {
  h: number;
  v: number;
  p00: number;
  p01: number;
  p11: number;
  initialized: boolean;
}

export const newKalman = (): KalmanState => ({ h: 0, v: 0, p00: KF_P0_H, p01: 0, p11: KF_P0_V, initialized: false });

export function kalmanStep(st: KalmanState, zMm: number, sigma2: number, dtMin: number): KalmanState {
  if (!st.initialized) {
    Object.assign(st, { h: zMm, v: 0, p00: KF_P0_H, p01: 0, p11: KF_P0_V, initialized: true });
    return st;
  }
  const dt = Math.max(dtMin, KF_MIN_DT_MIN);
  const hP = st.h + st.v * dt;
  const vP = st.v;
  const p00 = st.p00 + dt * (2 * st.p01 + dt * st.p11) + (KF_Q * dt * dt * dt) / 3;
  const p01 = st.p01 + dt * st.p11 + (KF_Q * dt * dt) / 2;
  const p11 = st.p11 + KF_Q * dt;
  const r = KF_R_BASE + KF_ALPHA * sigma2;
  const s = p00 + r;
  const k0 = p00 / s;
  const k1 = p01 / s;
  const innov = zMm - hP;
  st.h = hP + k0 * innov;
  st.v = vP + k1 * innov;
  st.p00 = (1 - k0) * p00;
  st.p01 = (1 - k0) * p01;
  st.p11 = p11 - k1 * p01;
  return st;
}

export interface QuantFeatures {
  q_h: number;
  q_v: number;
  q_s: number;
  q_e: number;
}

export function quantizeFeatures(hOverD: number, dhDt: number, turbulence: number, heM: number): QuantFeatures {
  return {
    q_h: clamp(roundHalfUp(hOverD * Q_H_SCALE), 0, 127),
    q_v: clamp(roundHalfUp(dhDt), -128, 127),
    q_s: clamp(roundHalfUp(turbulence * Q_S_SCALE), 0, 127),
    q_e: clamp(roundHalfUp(heM * Q_E_SCALE), 0, 127),
  };
}

/** FAULT > SURCHARGED > TRASH_BLOCKAGE > FLASH_SURGE > SUPERCRITICAL > LOW_BATTERY > NORMAL. */
export function classifyQuantized(f: QuantFeatures, froude: number | null, vbatV: number, sensorFault: boolean): number {
  if (sensorFault) return 5;
  if (f.q_h >= H_SURCHARGE_Q) return 4;
  if (f.q_h > H_BLOCKAGE_Q && Math.abs(f.q_v) < V_FLASH_Q && f.q_s < S_CALM_Q) return 2;
  if (f.q_v >= V_FLASH_Q && f.q_s >= S_CHOP_Q) return 1;
  if (froude !== null && froude > 1 && f.q_h >= 5) return 3;
  if (vbatV < VBAT_LOW_V) return 6;
  return 0;
}

export function fsmNext(hOverD: number, dhDt: number, code: number): number {
  if (code === 1 || code === 2 || code === 4 || hOverD >= FSM_CRITICAL_H || dhDt >= V_FLASH_Q) return 2;
  if (hOverD >= FSM_ACTIVE_H || Math.abs(dhDt) >= FSM_ACTIVE_DHDT || code === 3) return 1;
  return 0;
}

export function saturatedFields(depthMm: number, dhDt: number, capPct: number): string[] {
  const out: string[] = [];
  if (depthMm > DEPTH_MAX_MM) out.push('depth_mm');
  if (dhDt > DHDT_MAX || dhDt < DHDT_MIN) out.push('dh_dt_mm_min');
  if (capPct > CAP_MAX_PCT) out.push('cap_pct');
  return out;
}

export interface EdgeConfig {
  /** full-scale depth D of the represented structure (conduit rise, lagoon 6.5 m, rack 2.0 m) */
  fullScaleM: number;
  /** transducer face -> datum (manhole mode only) */
  mountMm: number;
  /** bench / aquarium: sensor height above the tank floor; 100 % = 74 % of it */
  standpipe: boolean;
  pipeHeightMm: number;
  vbatV: number;
}

export interface EdgeResult {
  d_med_mm: number;
  sigma_d2: number;
  turbulence: number;
  measured_depth_mm: number;
  raw_depth_mm: number;
  depth_mm: number;
  dh_dt_mm_min: number;
  h_over_d: number;
  cap_pct: number;
  anomaly_code: number;
  fsm_state: number;
  payload: number;
  payload_hex: string;
  saturated: string[];
}

export function standpipeScaledDepthMm(waterMm: number, pipeHeightMm: number, fullScaleM: number): number {
  return (Math.max(waterMm, 0) / (pipeHeightMm * STANDPIPE_FULL_BORE_FRACTION)) * fullScaleM * 1000;
}

/** One wake cycle (edge_dsp.run_cycle with geometry = None). Mutates the Kalman state. */
export function runCycle(cfg: EdgeConfig, kal: KalmanState, rawMm: number[], tempC: number, dtMin: number, sensorFault = false): EdgeResult {
  const dt = cfg.standpipe ? dtMin * BENCH_TIME_COMPRESSION : dtMin;
  const comp = rawMm.map((d) => thermalCompensate(d, tempC));
  let [dMed, variance, turb] = medianAndVariance(comp);
  const flags: string[] = [];
  if (dMed <= BLIND_ZONE_MM + 1) flags.push('blind_zone');
  if (dMed > MAX_RANGE_MM) {
    flags.push('below_range');
    dMed = MAX_RANGE_MM;
  }
  const last = comp[comp.length - 1];
  let z: number;
  let rawDepth: number;
  if (cfg.standpipe) {
    z = standpipeScaledDepthMm(clamp(cfg.pipeHeightMm - dMed, 0, cfg.pipeHeightMm), cfg.pipeHeightMm, cfg.fullScaleM);
    rawDepth = standpipeScaledDepthMm(clamp(cfg.pipeHeightMm - last, 0, cfg.pipeHeightMm), cfg.pipeHeightMm, cfg.fullScaleM);
  } else {
    z = clamp(cfg.mountMm - dMed, 0, cfg.mountMm - BLIND_ZONE_MM);
    rawDepth = clamp(cfg.mountMm - last, 0, cfg.mountMm);
  }
  kalmanStep(kal, z, variance, dt);
  const depth = Math.max(kal.h, 0);
  const dhDt = kal.v;
  const hOverD = depth / 1000 / cfg.fullScaleM;
  const he = depth / 1000;
  const cap = Math.min(hOverD, 1.27) * 100;
  const code = classifyQuantized(quantizeFeatures(hOverD, dhDt, turb, he), null, cfg.vbatV, sensorFault);
  const word = packTelemetryPayload(depth, dhDt, cap, code, cfg.vbatV);
  turb = Math.log1p(variance);
  return {
    d_med_mm: dMed,
    sigma_d2: variance,
    turbulence: turb,
    measured_depth_mm: z,
    raw_depth_mm: rawDepth,
    depth_mm: depth,
    dh_dt_mm_min: dhDt,
    h_over_d: hOverD,
    cap_pct: cap,
    anomaly_code: code,
    fsm_state: fsmNext(hOverD, dhDt, code),
    payload: word,
    payload_hex: toHex(word),
    saturated: [...saturatedFields(depth, dhDt, cap), ...flags],
  };
}
