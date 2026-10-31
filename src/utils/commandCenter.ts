// Analytics Command Center builders (Phase 9C), pure: the basin hydrograph series, the conduit
// stress ranking and the multi-agency action matrix. The UI only draws what these return.
import type { NetworkFile } from '../types/twin';
import type { FusionVerdict, LiveSensor } from '../types/live';
import type { TwinState } from './lutInterpolator';
import type { Forecast } from '../forecast/stgnn';
import type { FrameRecord } from './telemetryDatabase';

export const LAGOON_NODE = 'EN-07';
/** Transverse drop-weir crest of the intake channel (src/intake/compound.ts: 1428.0 + 0.9 m). */
export const WEIR_CREST_ASL = 1428.9;
export const CRITICAL_FILL = 0.8;

export interface HydroPoint {
  t: number; // epoch ms
  value: number;
  recovered: boolean;
  synthetic: boolean;
}

export interface HydroForecast {
  t: number;
  mid: number;
  lo: number;
  hi: number;
}

export interface Hydrograph {
  node: string;
  unit: 'm ASL' | '%';
  points: HydroPoint[];
  now: { t: number; value: number };
  forecast: HydroForecast[];
  references: { label: string; value: number; tone: 'weir' | 'critical' | 'rim' | 'warning' }[];
  /** contiguous windows of SD-recovered frames (hatched band) */
  recoveredWindows: [number, number][];
}

/** Lagoon stage in m ASL from EN-07 depth (cm above the 1426.5 m invert), else fill %. */
export function buildHydrograph(node: string, frames: FrameRecord[], net: NetworkFile, st: TwinState, forecast: Forecast | null, nowMs: number): Hydrograph {
  const lagoon = node === LAGOON_NODE;
  const inv = net.lagoon.invert_elev_m;
  const max = net.lagoon.max_depth_m;
  const points = frames
    .filter((f) => f.node_id === node)
    .map((f) => ({
      t: Date.parse(f.timestamp_utc),
      value: lagoon ? inv + f.depth_cm / 100 : f.capacity_pct,
      recovered: f.sd_recovered_flag,
      synthetic: f.source_mode === 'SYNTHETIC_SEED',
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const S = st.sensors.find((s) => s.id === node);
  const now = { t: nowMs, value: lagoon ? st.lagoon.surfaceElevM : (S?.capacityPct ?? 0) };
  const fc: HydroForecast[] = (forecast?.horizons ?? []).map((h) => {
    if (lagoon) return { t: nowMs + h.minutes * 60_000, mid: h.surface_elev_m, lo: h.surface_elev_p05_m, hi: h.surface_elev_p95_m };
    const fs = h.sensors[node];
    return { t: nowMs + h.minutes * 60_000, mid: fs?.capacity_pct ?? now.value, lo: fs?.p05 ?? now.value, hi: fs?.p95 ?? now.value };
  });
  const windows: [number, number][] = [];
  for (const p of points) {
    if (!p.recovered) continue;
    const last = windows.at(-1);
    if (last && p.t - last[1] <= 5 * 60_000) last[1] = p.t;
    else windows.push([p.t, p.t]);
  }
  const references: Hydrograph['references'] = lagoon
    ? [
        { label: 'Weir crest 1428.9 m', value: WEIR_CREST_ASL, tone: 'weir' },
        { label: `Critical spill threshold 80 % (${(inv + CRITICAL_FILL * max).toFixed(1)} m)`, value: inv + CRITICAL_FILL * max, tone: 'critical' },
        { label: `Rim ${net.lagoon.rim_elev_m.toFixed(1)} m`, value: net.lagoon.rim_elev_m, tone: 'rim' },
      ]
    : [
        { label: 'Warning 45 %', value: 45, tone: 'warning' },
        { label: 'Critical 80 %', value: 80, tone: 'critical' },
        { label: 'Full bore 100 %', value: 100, tone: 'rim' },
      ];
  return { node, unit: lagoon ? 'm ASL' : '%', points, now, forecast: fc, references, recoveredWindows: windows };
}

export interface StressRow {
  id: string;
  dims: string;
  flowCms: number;
  fillPct: number;
  /** dh/dt of the conduit's sensor (cm/min), null when no sensor watches it */
  dhDtCmMin: number | null;
  /** Kalman measurement variance sigma_d^2 (mm^2) from the edge, null without a live edge frame */
  sigma2: number | null;
  verdict: string;
}

export type StressKey = 'id' | 'flowCms' | 'fillPct' | 'dhDtCmMin' | 'sigma2';

export function conduitStressRows(net: NetworkFile, st: TwinState, fusion: FusionVerdict, live: Record<string, LiveSensor> | null): StressRow[] {
  const sensorOf = new Map(net.sensors.filter((s) => s.attached_kind === 'CONDUIT').map((s) => [s.attached_to, s.sensor_id]));
  return net.conduits.map((c, i) => {
    const sid = sensorOf.get(c.id);
    const S = sid ? st.sensors.find((s) => s.id === sid) : undefined;
    const L = sid ? live?.[sid] : undefined;
    const status = ['NORMAL', 'ELEVATED', 'CRITICAL', 'SURCHARGED'][st.conduits.status[i]] ?? 'NORMAL';
    const intakeReach = c.id === 'TUN-C01' || c.id === 'TUN-C02' || c.id === 'TUN-C03';
    return {
      id: c.id,
      dims: c.shape === 'CIRCULAR' ? `Ø${c.geometry.diameter_m} m` : `${c.geometry.span_m} × ${c.geometry.rise_m} m${c.shape === 'ARCH' ? ' arch' : ''}`,
      flowCms: st.conduits.flow[i],
      fillPct: st.conduits.capacity[i] * 100,
      dhDtCmMin: S ? S.dhDtMmMin / 10 : null,
      sigma2: L ? L.sigma_d2_mm2 : null,
      verdict: intakeReach && fusion.root_cause !== 'NOMINAL' ? fusion.root_cause : S ? `${status} · ${S.anomaly}` : status,
    };
  });
}

export function sortStress(rows: StressRow[], key: StressKey, desc: boolean): StressRow[] {
  const v = (r: StressRow) => (key === 'id' ? r.id : (r[key] ?? -Infinity));
  return [...rows].sort((a, b) => {
    const x = v(a);
    const y = v(b);
    const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) - (y as number);
    return desc ? -c : c;
  });
}

export interface AgencyAction {
  agency: 'CDRRMO' | 'CEPMO / City Engineering' | 'DPWH-BCDEO';
  level: 'ACTION' | 'WATCH' | 'NOMINAL';
  headline: string;
  detail: string;
}

/** Overflow ETA (min): the forecast's when available, else the LUT's constant-rain estimate. */
export function overflowEtaMin(st: TwinState, forecast: Forecast | null): number | null {
  if (st.lagoon.isOverflowing) return 0;
  return forecast?.time_to_overflow_min ?? st.lagoon.timeToOverflowMin;
}

export function agencyActions(net: NetworkFile, st: TwinState, fusion: FusionVerdict, forecast: Forecast | null): AgencyAction[] {
  const eta = overflowEtaMin(st, forecast);
  const occl = st.blockagePct;
  const worst = net.conduits.map((c, i) => ({ id: c.id, cap: st.conduits.capacity[i] })).sort((a, b) => b.cap - a.cap)[0];
  const cdrrmo: AgencyAction =
    eta !== null && eta <= 60
      ? { agency: 'CDRRMO', level: 'ACTION', headline: eta === 0 ? 'Lagoon overflowing: evacuation advisory' : `Evacuation lead time: about ${eta.toFixed(0)} min`, detail: 'Prepare the City Camp Proper / Central advisory; confirm with the field team and PAGASA bulletins before issuing.' }
      : eta !== null
        ? { agency: 'CDRRMO', level: 'WATCH', headline: `Overflow in about ${eta.toFixed(0)} min if the rain persists`, detail: 'Monitor the +15 / +30 / +60 min forecast; no advisory yet.' }
        : { agency: 'CDRRMO', level: 'NOMINAL', headline: 'No overflow expected at the current rainfall', detail: `Lagoon at ${st.lagoon.depthM.toFixed(2)} of 6.5 m.` };
  const cepmo: AgencyAction =
    fusion.root_cause === 'CONFIRMED_TRASH_RACK_OCCLUSION'
      ? { agency: 'CEPMO / City Engineering', level: 'ACTION', headline: `Dispatch rack-clearing crew: ${occl.toFixed(0)} % occlusion confirmed`, detail: 'EN-08 backwater + EN-09 vision agree: clear the City Camp Lagoon A trash rack (loader access via the channel ramp).' }
      : fusion.root_cause === 'DOWNSTREAM_ROCK_CHOKE_BACKWATER'
        ? { agency: 'CEPMO / City Engineering', level: 'NOMINAL', headline: 'Do not dispatch: rack is clear', detail: 'EN-08 ponding is backwater from the 1.5 m × 1.7 m rock choke; vision shows a clean rack.' }
        : occl >= 35
          ? { agency: 'CEPMO / City Engineering', level: 'WATCH', headline: `Schedule clearing: ${occl.toFixed(0)} % debris on the rack`, detail: 'No hydraulic backwater yet; clear before the next rain band.' }
          : { agency: 'CEPMO / City Engineering', level: 'NOMINAL', headline: 'Rack clear', detail: `Vision occlusion ${occl.toFixed(0)} %.` };
  const chokeBound = st.lagoon.control === 'TUNNEL_CHOKE';
  const dpwh: AgencyAction = {
    agency: 'DPWH-BCDEO',
    level: chokeBound && st.lagoon.depthM > 2.5 ? 'ACTION' : chokeBound ? 'WATCH' : 'NOMINAL',
    headline: chokeBound ? 'Unfinished rock choke governs outflow (4.44 m³/s)' : st.lagoon.control === 'TRASH_RACK' ? 'Trash rack governs outflow' : 'No outflow constraint active',
    detail: `Most stressed conduit ${worst.id} at ${(worst.cap * 100).toFixed(0)} %; ${st.statusCounts.SURCHARGED} surcharged, ${st.statusCounts.CRITICAL} critical of ${net.conduits.length}.`,
  };
  return [cdrrmo, cepmo, dpwh];
}
