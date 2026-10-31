// Command Center CCTV storm replay (Phase 9B): what the intake cameras would show minute by
// minute through a 60-minute storm, and what the multi-sensor fusion decides at each moment.
//
// Pure and deterministic. Hydrology comes from the LUT: the lagoon follows the generator's
// constant-burst depth series (depth_series_m) for the replay's rainfall and rack occlusion,
// and the intake sensors (EN-07/08/10, all governed by the lagoon stage) are read at the
// "equivalent rain" whose 180-min end state has that same lagoon depth. The fusion verdict is
// the shared arbitrator (src/utils/fusion.ts ≡ backend/intelligence.py).
//
// The interpolator passed in is MUTATED (LutInterpolator.evaluate reuses one state object), so
// give the replay its own instance, never the map's.
import type { FusionVerdict } from '../types/live';
import type { LutInterpolator, SensorState } from '../utils/lutInterpolator';
import { arbitrate } from '../utils/fusion';
import { gaugeReadingM, INTAKE_DATUM_ASL, weirSubmerged, regimeOf, type IntakeRegime } from '../intake/compound';

export const REPLAY_MINUTES = 60;
/** Time-lapse at 1x: storm seconds per wall second (the whole 60-min replay plays in 2 min). */
export const TIMELAPSE = 30;
export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;
/** DVR skip: 15 s of the time-lapse clip = 7.5 storm minutes. */
export const SKIP_STORM_MIN = (15 * TIMELAPSE) / 60;

export type ReplayPresetId = 'baseline' | 'debris' | 'backwater';

export interface ReplayPreset {
  id: ReplayPresetId;
  label: string;
  short: string;
  description: string;
  rain(tMin: number): number;
  occlusion(tMin: number): number;
}

const ramp = (t: number, t0: number, t1: number, a: number, b: number) => a + (b - a) * Math.min(Math.max((t - t0) / (t1 - t0), 0), 1);

export const REPLAY_PRESETS: ReplayPreset[] = [
  {
    id: 'baseline',
    label: 'Preset 1: Dry / Post-Clearing Baseline (15% Occlusion)',
    short: 'Dry baseline',
    description: 'Freshly cleared grate, drizzle only: low channel flow over the weir, all intake sensors nominal.',
    rain: (t) => 2 + 1.5 * Math.sin(t / 9),
    occlusion: () => 15,
  },
  {
    id: 'debris',
    label: 'Preset 2: Typhoon Surface Debris Occlusion (78% Clogged)',
    short: 'Debris occlusion',
    description: 'A typhoon rain band washes street litter onto the screen (30 % to 78 % in 25 min); the pool rises against the clogged rack.',
    rain: (t) => ramp(t, 0, 8, 12, 50),
    occlusion: (t) => ramp(t, 0, 25, 30, 78),
  },
  {
    id: 'backwater',
    label: 'Preset 3: Clean Grate + Downstream Rock-Choke Backwater (09-30-2024 Surge)',
    short: 'Choke backwater',
    description:
      'Heavy rain with a clear grate (8 %): water submerges the weir and keeps rising because the 1.5 m x 1.7 m rock choke, not the rack, limits outflow. Scenario shaped after the 09-30-2024 CCTV still; synthetic hydrology, not a gauge record.',
    rain: (t) => ramp(t, 0, 6, 30, 100),
    occlusion: () => 8,
  },
];

export type ReplayAction = 'NOMINAL' | 'DEBRIS_WATCH' | 'TRASH_RACK_OCCLUSION_DISPATCH' | 'DOWNSTREAM_CHOKE_BACKWATER_OVERRIDE' | 'LAGOON_OVERFLOW_EVACUATION';

export const ACTION_LABEL: Record<ReplayAction, string> = {
  NOMINAL: 'Nominal: no dispatch',
  DEBRIS_WATCH: 'Debris building: schedule clearing',
  TRASH_RACK_OCCLUSION_DISPATCH: 'CEPMO trash-rack clearing dispatch',
  DOWNSTREAM_CHOKE_BACKWATER_OVERRIDE: 'Rack alarm suppressed: rock-choke backwater, escalate to CDRRMO',
  LAGOON_OVERFLOW_EVACUATION: 'Lagoon overflow: CDRRMO evacuation advisory',
};

export function actionOf(v: FusionVerdict): ReplayAction {
  switch (v.root_cause) {
    case 'CONFIRMED_TRASH_RACK_OCCLUSION':
      return 'TRASH_RACK_OCCLUSION_DISPATCH';
    case 'DOWNSTREAM_ROCK_CHOKE_BACKWATER':
      return 'DOWNSTREAM_CHOKE_BACKWATER_OVERRIDE';
    case 'INTAKE_SURCHARGE_OVERFLOW':
      return 'LAGOON_OVERFLOW_EVACUATION';
    case 'DEBRIS_ACCUMULATING_NO_BACKWATER':
      return 'DEBRIS_WATCH';
    default:
      return 'NOMINAL';
  }
}

/** The intake-sensor readings a replay frame carries (copied out of the interpolator). */
export interface ReplaySensor {
  id: string;
  capacityPct: number;
  depthMm: number;
  dhDtMmMin: number;
  anomaly: SensorState['anomaly'];
  payloadHex: string;
}

export interface ReplayFrame {
  preset: ReplayPresetId;
  tMin: number;
  rainMmHr: number;
  occlusionPct: number;
  lagoonDepthM: number;
  lagoonElevM: number;
  gaugeM: number;
  weirSubmerged: boolean;
  regime: IntakeRegime;
  /** Minutes until the lagoon tops its rim if the rain continues, or null. */
  overflowEtaMin: number | null;
  sensors: Record<'EN-07' | 'EN-08' | 'EN-09' | 'EN-10', ReplaySensor>;
  verdict: FusionVerdict;
  action: ReplayAction;
  /** Escalate to CDRRMO: overflowing, or overflow expected within the 60-minute horizon. */
  evacuationWarning: boolean;
}

function seriesAt(series: ArrayLike<number>, tMin: number): number {
  const f = Math.min(Math.max(tMin / 10, 0), series.length - 1);
  const i = Math.min(Math.floor(f), series.length - 2);
  return series[i] + (series[i + 1] - series[i]) * (f - i);
}

/** One replay instant. `interp` is mutated: use a private LutInterpolator instance. */
export function replayFrame(interp: LutInterpolator, presetId: ReplayPresetId, tMin: number): ReplayFrame {
  const preset = REPLAY_PRESETS.find((p) => p.id === presetId) ?? REPLAY_PRESETS[0];
  const t = Math.min(Math.max(tMin, 0), REPLAY_MINUTES);
  const rain = preset.rain(t);
  const occ = preset.occlusion(t);

  // Lagoon trajectory of the constant burst at the current intensity / occlusion.
  const burst = interp.evaluate(rain, occ);
  const depth = seriesAt(burst.lagoon.depthSeries, t);
  const tto = burst.lagoon.timeToOverflowMin;
  const maxDepth = 6.5;
  const overflowing = depth >= maxDepth;
  const eta = overflowing ? 0 : tto === null ? null : Math.max(tto - t, 0);

  // Equivalent rain: the end state whose lagoon depth matches the replay depth (monotone in rain).
  let lo = 0;
  let hi = Math.max(rain, 0.01);
  for (let k = 0; k < 22; k++) {
    const mid = (lo + hi) / 2;
    if (interp.evaluate(mid, occ).lagoon.depthM < depth) lo = mid;
    else hi = mid;
  }
  const st = interp.evaluate((lo + hi) / 2, occ);
  st.lagoon.depthM = depth;
  st.lagoon.surfaceElevM = 1426.5 + depth;
  st.lagoon.isOverflowing = overflowing;
  const verdict = arbitrate(st);
  const pick = (id: string): ReplaySensor => {
    const s = st.sensors.find((x) => x.id === id)!;
    return { id, capacityPct: s.capacityPct, depthMm: s.depthMm, dhDtMmMin: s.dhDtMmMin, anomaly: s.anomaly, payloadHex: s.payloadHex };
  };
  const elev = 1426.5 + depth;
  const action = actionOf(verdict);
  return {
    preset: preset.id,
    tMin: t,
    rainMmHr: rain,
    occlusionPct: occ,
    lagoonDepthM: depth,
    lagoonElevM: elev,
    gaugeM: gaugeReadingM(elev),
    weirSubmerged: weirSubmerged(elev),
    regime: regimeOf(pick('EN-08').anomaly),
    overflowEtaMin: eta,
    sensors: { 'EN-07': pick('EN-07'), 'EN-08': pick('EN-08'), 'EN-09': pick('EN-09'), 'EN-10': pick('EN-10') },
    verdict,
    action,
    evacuationWarning: overflowing || (eta !== null && eta <= REPLAY_MINUTES),
  };
}

export interface Detection {
  key: 'debris' | 'rack' | 'weir' | 'gauge';
  label: string;
  confidence: number;
}

/**
 * YOLOv8-style overlay labels for a procedural frame. Confidences are derived deterministically
 * from the replay state (this is a rendering of what the Jetson's detector would report, not an
 * inference on pixels); real clips get no boxes because no model runs in the browser.
 */
export function detectionsFor(f: ReplayFrame): Detection[] {
  const out: Detection[] = [];
  if (f.occlusionPct >= 20) out.push({ key: 'debris', label: 'DEBRIS_CLUSTER', confidence: Math.min(0.8 + 0.15 * (f.occlusionPct / 80), 0.97) });
  out.push({ key: 'rack', label: `TRASH_RACK_OCCLUSION ${f.occlusionPct.toFixed(0)}%`, confidence: 0.9 });
  const over = f.lagoonElevM - INTAKE_DATUM_ASL - 0.9;
  if (f.weirSubmerged) out.push({ key: 'weir', label: 'WEIR_SUBMERGED', confidence: Math.min(0.9 + 0.07 * Math.min(over / 0.5, 1), 0.98) });
  out.push({ key: 'gauge', label: `STAFF_GAUGE_LEVEL ${f.gaugeM.toFixed(1)}m`, confidence: 0.93 });
  return out;
}

/** mm:ss for a storm time in minutes. */
export function formatStormTime(tMin: number): string {
  const s = Math.round(Math.min(Math.max(tMin, 0), REPLAY_MINUTES) * 60);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** CCTV OSD timestamp, `MM-DD-YYYY Ddd HH:MM:SS` (the Command Center overlay format). */
export function osdTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()} ${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
