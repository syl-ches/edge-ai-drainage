// Node fullness + sensor geometry shared by the 3D gauges, fullness badges, the
// Cross-Section Simulator and the Subsurface Utility Inspector.
//
// Mount rules mirror backend/twin.py::_build_fleet exactly (CLAUDE.md §13): manhole sensors sit
// under the lid when the lid is <= 4.4 m above the conduit invert, otherwise they are crown-
// mounted 0.3 m above the conduit soffit; the lagoon stage mast is 7.3 m above the bowl invert
// and the intake mast 5.9 m above the rack sill.
import type { Conduit, NetworkFile, Sensor } from '../types/twin';
import type { SensorState } from './lutInterpolator';
import { CAP_MAX_PCT } from './payloadCodec';

export const EN07_MAST_M = 7.3;
export const EN08_MAST_M = 5.9;
export const LID_MOUNT_LIMIT_M = 4.4;
export const CROWN_CLEARANCE_M = 0.3;
export const A02YYUW_BLIND_MM = 30;
export const A02YYUW_RANGE_MM = 4500;

export interface SensorGeometry {
  sensor: Sensor;
  conduit: Conduit | null;
  /** full-scale depth D used for h/D (conduit rise, lagoon 6.5 m, rack opening 2.0 m) */
  fullScaleM: number;
  /** transducer face -> depth datum (conduit invert / bowl invert / rack sill), metres */
  mountM: number;
  crownMounted: boolean;
  /** human label of the structure under the sensor */
  structureLabel: string;
  shape: 'CIRCULAR' | 'RECT_CLOSED' | 'ARCH' | 'STORAGE' | 'ORIFICE';
  spanM: number;
}

export function sensorGeometry(sensor: Sensor, network: NetworkFile): SensorGeometry {
  if (sensor.attached_kind === 'CONDUIT') {
    const c = network.conduits.find((x) => x.id === sensor.attached_to) ?? null;
    const rise = c?.geometry.rise_m ?? Number(sensor.pipe_geometry.rise_m);
    const span = c?.geometry.span_m ?? Number(sensor.pipe_geometry.span_m);
    const lid = sensor.coordinates[2] - Number(sensor.pipe_geometry.invert_elev_m);
    const crown = lid > LID_MOUNT_LIMIT_M;
    const shape = (c?.shape ?? 'CIRCULAR') as SensorGeometry['shape'];
    const label =
      shape === 'CIRCULAR'
        ? `Underground Main Pipe Ø ${Math.round(rise * 1000)}mm`
        : shape === 'ARCH'
          ? `Unfinished Rock Arch ${span}m × ${rise}m`
          : `Underground Main Box Culvert ${span}m × ${rise}m`;
    return {
      sensor,
      conduit: c,
      fullScaleM: rise,
      mountM: crown ? rise + CROWN_CLEARANCE_M : lid,
      crownMounted: crown,
      structureLabel: label,
      shape,
      spanM: span,
    };
  }
  if (sensor.attached_kind === 'STORAGE') {
    return {
      sensor,
      conduit: null,
      fullScaleM: network.lagoon.max_depth_m,
      mountM: EN07_MAST_M,
      crownMounted: false,
      structureLabel: `City Camp Lagoon karst bowl (${network.lagoon.max_depth_m} m deep)`,
      shape: 'STORAGE',
      spanM: 40,
    };
  }
  const rack = network.orifices[0];
  return {
    sensor,
    conduit: null,
    fullScaleM: rack.height_m,
    mountM: EN08_MAST_M,
    crownMounted: false,
    structureLabel: `Tunnel Intake Trash Rack ${rack.width_m}m × ${rack.height_m}m`,
    shape: 'ORIFICE',
    spanM: rack.width_m,
  };
}

/**
 * "% full" of a node. Conduit nodes report hydraulic capacity (max(Q/Q_full, h/D)); the lagoon
 * stage and the rack ultrasonic report h/D; the Jetson vision node (whose cap_code is visual
 * blockage) reports the rack stage h/D instead, so every node answers "how full is it here".
 * All nodes share the u7 cap_code full scale (0-127 %), so the ponded rack stage (h/D ~2.7 when
 * the lagoon backs up over the 2.0 m opening) reads as saturated rather than "266 %".
 */
export function nodeFullnessPct(S: SensorState): number {
  const pct = S.sensor.hardware === 'JETSON_YOLO_TRASHRACK' ? S.hRatio * 100 : S.capacityPct;
  return Math.min(Math.max(pct, 0), CAP_MAX_PCT);
}

/** The Jetson's own measurement: visual blockage % of the rack (its cap_code), else null. */
export function visualBlockagePct(S: SensorState): number | null {
  return S.sensor.hardware === 'JETSON_YOLO_TRASHRACK' ? S.capacityPct : null;
}

/** Water level above the structure datum (m), including any rise up the shaft. */
export function nodeDepthM(S: SensorState): number {
  return Math.max(S.depthMm, 0) / 1000;
}

/** What the A02YYUW would read: transducer -> water surface, clamped to its physical window. */
export function ultrasonicDistanceMm(S: SensorState, g: SensorGeometry): number {
  const d = (g.mountM - nodeDepthM(S)) * 1000;
  return Math.min(Math.max(d, A02YYUW_BLIND_MM), A02YYUW_RANGE_MM + 500);
}

export interface NodeStatus {
  label: 'Normal Flow' | 'Elevated' | 'High' | 'Surcharge';
  tone: 'normal' | 'elevated' | 'high' | 'surcharge';
}

export function fullnessStatus(pct: number): NodeStatus {
  if (pct > 94) return { label: 'Surcharge', tone: 'surcharge' };
  if (pct > 75) return { label: 'High', tone: 'high' };
  if (pct > 45) return { label: 'Elevated', tone: 'elevated' };
  return { label: 'Normal Flow', tone: 'normal' };
}

// ---------------------------------------------------------------- 3D markers + map badges
/** Fullness at which a sensor marker blinks red and its conduit pulses (Phase 7A). */
export const ALARM_PCT = 80;
export const ELEVATED_PCT = 45;
/** Blink rate of an alarmed marker / conduit, Hz. */
export const ALARM_BLINK_HZ = 3;

export type MarkerTone = 'normal' | 'elevated' | 'alarm';

export const MARKER_COLORS = {
  normal: '#10B981',
  elevated: '#F59E0B',
  alarm: '#DC2626',
  alarmLight: '#FCA5A5',
} as const;

/**
 * Marker status: alarm when the node is >= 80 % full, surcharged, or a physical (hardware)
 * uplink reports a live surge there; elevated from 45 %; otherwise normal.
 */
export function markerTone(S: SensorState): MarkerTone {
  const pct = nodeFullnessPct(S);
  if (pct >= ALARM_PCT || S.anomaly === 'SURCHARGED' || S.liveSurge) return 'alarm';
  return pct >= ELEVATED_PCT ? 'elevated' : 'normal';
}

/** Red <-> light-red blink colour of an alarmed marker at time t (s). */
export function alarmBlink(t: number): number {
  return 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * ALARM_BLINK_HZ);
}

export interface BadgeContent {
  id: string;
  /** "88%" or, for the Jetson vision node, "15% blk" (its own visual-blockage reading) */
  value: string;
  vision: boolean;
  tone: MarkerTone;
}

/** Compact clickable map pill: status dot + id + one number + chevron. */
export function badgeContent(S: SensorState): BadgeContent {
  const blk = visualBlockagePct(S);
  return {
    id: S.id,
    value: blk !== null ? `${blk.toFixed(0)}% blk` : `${nodeFullnessPct(S).toFixed(0)}%`,
    vision: blk !== null,
    tone: markerTone(S),
  };
}

/** Conduit a sensor's alarm pulses: its own conduit, or the tunnel intake reach for the rack nodes. */
export function alarmConduitId(sensor: Sensor): string | null {
  if (sensor.attached_kind === 'CONDUIT') return sensor.attached_to;
  if (sensor.attached_kind === 'ORIFICE') return 'TUN-C01';
  return null;
}

/** Conduit index of a sensor's structure (for Q / V / depth readouts), or -1. */
export function sensorConduitIndex(S: SensorState, conduitIndex: Map<string, number>): number {
  return S.sensor.attached_kind === 'CONDUIT' ? (conduitIndex.get(S.sensor.attached_to) ?? -1) : -1;
}
