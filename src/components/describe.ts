import type { TwinData } from '../data/loadTwin';
import type { PickHit } from '../three/TwinEngine';
import { ANOMALY_COLORS, capacityColor } from '../three/palette';
import type { LiveSensor } from '../types/live';
import type { Conduit } from '../types/twin';
import { STATUSES, type LutInterpolator, type TwinState } from '../utils/lutInterpolator';

export interface CardRow {
  label: string;
  value: string;
  mono?: boolean;
  tone?: string;
}

export interface Badge {
  text: string;
  color: string;
}

export interface CardModel {
  kicker: string;
  title: string;
  subtitle: string;
  accent: string;
  badges: Badge[];
  rows: CardRow[];
}

export const fmt = (v: number | null | undefined, d = 2, unit = '') =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(d)}${unit}`;

export function sectionLabel(c: Conduit): string {
  const g = c.geometry;
  if (c.shape === 'CIRCULAR') return `CIRCULAR Ø${(g.diameter_m ?? g.rise_m).toFixed(2)}m`;
  return `${c.shape} ${g.span_m}m × ${g.rise_m}m`;
}

export function parseSel(sel: string | null): PickHit | null {
  if (!sel) return null;
  const [kind, id] = sel.split(':');
  if (!id || !['conduit', 'node', 'sensor', 'rack'].includes(kind)) return null;
  return { kind: kind as PickHit['kind'], id };
}

export const selKey = (h: PickHit | null) => (h ? `${h.kind}:${h.id}` : null);

/** Compact hover card. The drawer renders richer views from the same data. */
export function describePick(
  hit: PickHit,
  data: TwinData,
  interp: LutInterpolator,
  st: TwinState,
  live: Record<string, LiveSensor> | null,
): CardModel | null {
  const { network } = data;
  if (hit.kind === 'conduit') {
    const i = interp.conduitIndex.get(hit.id);
    if (i === undefined) return null;
    const c = network.conduits[i];
    const C = st.conduits;
    const status = STATUSES[C.status[i]];
    const accent = status === 'SURCHARGED' ? '#F538A0' : capacityColor(C.capacity[i]);
    const fr = Number.isNaN(C.froude[i]) ? null : C.froude[i];
    const badges: Badge[] = [{ text: status, color: accent }];
    if (fr !== null && fr > 1) badges.push({ text: 'SUPERCRITICAL Fr>1', color: '#60A5FA' });
    if (C.jump[i] >= 0.5) badges.push({ text: 'HYDRAULIC JUMP', color: '#FCC934' });
    if (c.segment_class) badges.push({ text: c.segment_class.replaceAll('_', ' '), color: c.shape === 'ARCH' ? '#FA903E' : '#64748B' });
    return {
      kicker: `Conduit · ${c.network}`,
      title: c.id,
      subtitle: `${c.road} · ${c.barangay}`,
      accent,
      badges,
      rows: [
        { label: 'Section', value: sectionLabel(c), mono: true },
        { label: 'Capacity', value: fmt(C.capacity[i] * 100, 1, ' %'), tone: accent },
        { label: 'Flow Q', value: fmt(C.flow[i], 3, ' m³/s'), mono: true },
        { label: 'Velocity V', value: fmt(C.velocity[i], 2, ' m/s'), mono: true },
        { label: 'Froude Fr', value: fr === null ? '— (pressurized)' : fmt(fr, 2), mono: true, tone: fr !== null && fr > 1 ? '#60A5FA' : undefined },
        { label: 'Depth y', value: `${fmt(C.depth[i], 3, ' m')} / ${c.geometry.rise_m} m`, mono: true },
      ],
    };
  }
  if (hit.kind === 'node') {
    const i = interp.nodeIndex.get(hit.id);
    if (i === undefined) return null;
    const n = network.nodes[i];
    const hgl = st.nodes.hgl[i];
    const flooding = st.nodes.flooding[i] === 1;
    const drop =
      n.network === 'TUNNEL' ? network.conduits.find((c) => c.to_node === n.id && c.network !== 'TUNNEL' && c.outlet_offset_m > 1) : undefined;
    const isIntake = network.orifices.some((o) => o.to_node === n.id);
    const badges: Badge[] = [{ text: n.type, color: '#64748B' }];
    if (drop) badges.push({ text: `DROP STRUCTURE ${drop.outlet_offset_m.toFixed(1)} m`, color: '#F59E0B' });
    if (isIntake) badges.push({ text: 'INTAKE DROP SHAFT', color: '#F59E0B' });
    if (flooding) badges.push({ text: 'FLOODING', color: '#F538A0' });
    return {
      kicker: `Node · ${n.network}`,
      title: n.id,
      subtitle: `${n.name} · ${n.barangay}`,
      accent: flooding ? '#F538A0' : drop || isIntake ? '#F59E0B' : '#38BDF8',
      badges,
      rows: [
        { label: 'Rim / invert', value: `${fmt(n.rim_elev_m, 2)} / ${fmt(n.invert_elev_m, 2)} m`, mono: true },
        { label: 'Shaft depth', value: fmt(n.max_depth_m, 2, ' m'), mono: true },
        { label: 'HGL', value: fmt(hgl, 3, ' m ASL'), mono: true },
        { label: 'Water in shaft', value: fmt(Math.max(hgl - n.invert_elev_m, 0), 2, ' m'), mono: true },
        ...(drop ? [{ label: 'Plunging inflow', value: `${drop.id} (${sectionLabel(drop)})`, mono: true }] : []),
      ],
    };
  }
  if (hit.kind === 'sensor') {
    const i = interp.sensorIndex.get(hit.id);
    if (i === undefined) return null;
    const S = st.sensors[i];
    const L = live?.[hit.id];
    const anomaly = L?.anomaly_class ?? S.anomaly;
    const accent = ANOMALY_COLORS[anomaly];
    const sat = L?.saturated_fields ?? S.saturated;
    const badges: Badge[] = [{ text: anomaly, color: accent }];
    if (L) badges.push({ text: L.origin === 'HARDWARE' ? 'HARDWARE NODE' : 'VIRTUAL FLEET', color: L.origin === 'HARDWARE' ? '#4ADE80' : '#94A3B8' });
    if (S.sensor.hardware === 'JETSON_YOLO_TRASHRACK') badges.push({ text: 'YOLOv8 VISION', color: '#38BDF8' });
    if (sat.length) badges.push({ text: `SATURATED: ${sat.join(', ')}`, color: '#EAB308' });
    return {
      kicker: `Edge-AI node · ${S.sensor.hardware}`,
      title: S.id,
      subtitle: S.sensor.name,
      accent,
      badges,
      rows: [
        { label: 'Payload', value: L?.payload_hex ?? S.payloadHex, mono: true, tone: '#E2E8F0' },
        { label: 'Depth', value: fmt(L?.kalman_filtered_depth_mm ?? S.depthMm, 0, ' mm'), mono: true },
        { label: 'dh/dt', value: fmt(L?.dh_dt_mm_min ?? S.dhDtMmMin, 2, ' mm/min'), mono: true },
        { label: S.blockageP !== null ? 'Vision blockage' : 'Capacity', value: fmt(L?.capacity_pct ?? S.capacityPct, 1, ' %'), mono: true },
      ],
    };
  }
  const o = network.orifices.find((x) => x.id === hit.id);
  if (!o) return null;
  const Lg = st.lagoon;
  const pct = st.blockagePct;
  const accent = pct >= 75 ? '#EF4444' : pct >= 25 ? '#F59E0B' : '#94A3B8';
  return {
    kicker: 'Orifice link · Kirschmer trash rack',
    title: o.id,
    subtitle: `${o.from_node} → ${o.to_node}`,
    accent,
    badges: [
      { text: `${pct.toFixed(0)}% BLOCKED`, color: accent },
      { text: Lg.bottleneck, color: '#64748B' },
    ],
    rows: [
      { label: 'Opening', value: `${o.width_m}m × ${o.height_m}m @ ${o.sill_elev_m} m`, mono: true },
      { label: 'Outflow Q', value: fmt(Lg.orificeFlowCms, 3, ' m³/s'), mono: true },
      { label: 'Head loss ΔH', value: fmt(Lg.headLossM, 3, ' m'), mono: true },
      { label: 'ξ(p)', value: `${fmt(Lg.xiRack, 3)} (clean ${o.xi_clean})`, mono: true },
    ],
  };
}
