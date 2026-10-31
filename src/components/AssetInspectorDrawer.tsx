import type { ReactNode } from 'react';
import { X, AlertTriangle, Camera, Cctv, Cpu, Radio } from 'lucide-react';
import type { TwinData } from '../data/loadTwin';
import type { PickHit } from '../three/TwinEngine';
import { ANOMALY_COLORS, capacityColor } from '../three/palette';
import type { LiveSensor } from '../types/live';
import type { Conduit, TwinNode } from '../types/twin';
import { STATUSES, type LutInterpolator, type TwinState } from '../utils/lutInterpolator';
import { PAYLOAD_FIELDS, toBase64, unpackTelemetryPayload } from '../utils/payloadCodec';
import { describePick, fmt, sectionLabel } from './describe';
import { RawVsKalmanChart, type DspSample } from './RawVsKalmanChart';

interface Props {
  hit: PickHit;
  data: TwinData;
  interp: LutInterpolator;
  state: TwinState;
  rev: number;
  live: Record<string, LiveSensor> | null;
  dspHistory: DspSample[];
  onClose(): void;
  /** Opens the nearest Command Center CCTV feeds for a sensor. */
  onCctv?(sensorId: string): void;
  /** Render as a card inside the workspace right dock instead of a floating drawer (Phase 9A). */
  embedded?: boolean;
}

function Row({ k, v, tone, mono = true }: { k: string; v: string; tone?: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 py-1 text-[12px] last:border-0">
      <span className="text-slate-500">{k}</span>
      <span className={`text-right ${mono ? 'font-mono' : ''} text-slate-100`} style={tone ? { color: tone } : undefined}>
        {v}
      </span>
    </div>
  );
}

/** True cross-section outline with the current water fill. */
function CrossSection({ c, depth, color }: { c: Conduit; depth: number; color: string }) {
  const W = c.geometry.span_m;
  const H = c.geometry.rise_m;
  const pad = 0.35;
  const vbW = Math.max(W, H) + pad * 2;
  const s = 180 / vbW;
  const ox = (vbW - W) / 2;
  const tx = (x: number) => (ox + x) * s;
  const ty = (y: number) => (pad + Math.max(W, H) - y) * s;
  let outline: string;
  if (c.shape === 'CIRCULAR') {
    const r = (H / 2) * s;
    outline = `M ${tx(W / 2) - r},${ty(H / 2)} a ${r},${r} 0 1,0 ${2 * r},0 a ${r},${r} 0 1,0 ${-2 * r},0`;
  } else if (c.shape === 'ARCH') {
    const r = W / 2;
    outline = `M ${tx(0)},${ty(0)} L ${tx(W)},${ty(0)} L ${tx(W)},${ty(H - r)} A ${r * s},${r * s} 0 0,0 ${tx(0)},${ty(H - r)} Z`;
  } else {
    const k = c.geometry.haunch_m ?? 0;
    const pts = [
      [k, 0], [W - k, 0], [W, k], [W, H - k], [W - k, H], [k, H], [0, H - k], [0, k],
    ];
    outline = `M ${pts.map(([x, y]) => `${tx(x)},${ty(y)}`).join(' L ')} Z`;
  }
  const fill = Math.min(Math.max(depth, 0), H);
  const clipId = `cs-${c.id}`;
  return (
    <svg viewBox={`0 0 180 180`} className="mx-auto h-40 w-40">
      <defs>
        <clipPath id={clipId}>
          <path d={outline} />
        </clipPath>
      </defs>
      <rect x="0" y={ty(fill)} width="180" height={180 - ty(fill)} fill={color} fillOpacity="0.55" clipPath={`url(#${clipId})`} />
      <path d={outline} fill="none" stroke="#E2E8F0" strokeWidth="2" />
      <line x1={tx(0)} x2={tx(W)} y1={ty(-0.18)} y2={ty(-0.18)} stroke="#64748B" />
      <text x={tx(W / 2)} y={ty(-0.18) + 11} textAnchor="middle" fontSize="10" fill="#94A3B8" fontFamily="monospace">
        {c.shape === 'CIRCULAR' ? `Ø ${H} m` : `${W} m`}
      </text>
      {c.shape !== 'CIRCULAR' && (
        <text x={tx(W) + 6} y={ty(H / 2)} fontSize="10" fill="#94A3B8" fontFamily="monospace">
          {H} m
        </text>
      )}
      {fill > 0.01 && (
        <text x={tx(W / 2)} y={ty(fill) - 3} textAnchor="middle" fontSize="9" fill="#F8FAFC" fontFamily="monospace">
          y={fill.toFixed(2)}
        </text>
      )}
    </svg>
  );
}

function PayloadBreakdown({ word, saturated, isVision }: { word: number; saturated: string[]; isVision: boolean }) {
  const d = unpackTelemetryPayload(word);
  const fieldOf = (bit: number) => PAYLOAD_FIELDS.find((f) => bit <= f.bits[0] && bit >= f.bits[1])!;
  const values: Record<string, [number, string]> = {
    depth: [d.depthCode, `${d.depthMm} mm`],
    dhdt: [d.dhDtCode, `${d.dhDtMmMin >= 0 ? '+' : ''}${d.dhDtMmMin} mm/min`],
    cap: [d.capCode, isVision ? `${d.capPct} % vision occlusion` : `${d.capPct} % capacity`],
    anom: [d.anomCode, d.anomaly],
    vbat: [d.vbatCode, `${d.vbatV.toFixed(2)} V`],
  };
  const json = JSON.stringify({
    device_eui: '02BA6C1000000000',
    timestamp: '2026-10-26T14:05:00Z',
    depth_mm: d.depthMm,
    dh_dt_mm_min: d.dhDtMmMin,
    capacity_pct: d.capPct,
    anomaly_class: d.anomaly,
    vbat_v: d.vbatV,
  });
  const jsonBytes = new TextEncoder().encode(json).length;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-lg font-semibold tracking-wider text-white">{`0x${word.toString(16).toUpperCase().padStart(8, '0')}`}</span>
        <span className="font-mono text-[10px] text-slate-500">b64 {toBase64(word)}</span>
      </div>
      <div className="grid grid-cols-[repeat(32,minmax(0,1fr))] gap-px overflow-hidden rounded-md">
        {Array.from({ length: 32 }, (_, k) => {
          const bit = 31 - k;
          const f = fieldOf(bit);
          const on = (word >>> bit) & 1;
          return (
            <div
              key={bit}
              title={`bit ${bit} · ${f.label}`}
              className="flex h-6 items-center justify-center font-mono text-[8px]"
              style={{ background: on ? f.color : `${f.color}26`, color: on ? '#020617' : `${f.color}` }}
            >
              {on}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[8px] text-slate-600">
        <span>31</span>
        <span>22</span>
        <span>14</span>
        <span>7</span>
        <span>4</span>
        <span>0</span>
      </div>
      <div className="space-y-1">
        {PAYLOAD_FIELDS.map((f) => (
          <div key={f.key} className="flex items-center gap-2 text-[11px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: f.color }} />
            <span className="w-20 font-mono text-slate-400">
              [{f.bits[0]}:{f.bits[1]}]
            </span>
            <span className="w-24 font-mono text-slate-300">{f.label}</span>
            <span className="w-10 text-right font-mono text-slate-500">{values[f.key][0]}</span>
            <span className="flex-1 text-right font-mono text-slate-100">{values[f.key][1]}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-lg bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200 ring-1 ring-emerald-400/30">
        <span>LoRaWAN bandwidth</span>
        <span className="font-mono">
          4 B vs {jsonBytes} B JSON · −{(100 - (4 / jsonBytes) * 100).toFixed(1)}%
        </span>
      </div>
      {saturated.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-lg bg-yellow-500/10 px-2 py-1.5 text-[11px] text-yellow-200 ring-1 ring-yellow-400/30">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            Saturated: <span className="font-mono">{saturated.join(', ')}</span>. The 10-bit depth field tops out at 5,115 mm; the true value is
            clamped on air.
          </span>
        </div>
      )}
    </div>
  );
}

function NodeGauge({ n, hgl }: { n: TwinNode; hgl: number }) {
  const span = n.rim_elev_m - n.invert_elev_m;
  const lvl = Math.min(Math.max((hgl - n.invert_elev_m) / span, 0), 1);
  return (
    <div className="flex items-end gap-3">
      <div className="relative h-32 w-10 overflow-hidden rounded-md bg-slate-800 ring-1 ring-white/10">
        <div className="absolute inset-x-0 bottom-0 bg-sky-400/70" style={{ height: `${lvl * 100}%` }} />
      </div>
      <div className="space-y-1 font-mono text-[10px] text-slate-400">
        <div>rim {n.rim_elev_m.toFixed(2)}</div>
        <div className="text-sky-300">HGL {hgl.toFixed(2)}</div>
        <div>inv {n.invert_elev_m.toFixed(2)}</div>
      </div>
    </div>
  );
}

export function AssetInspectorDrawer({ hit, data, interp, state, live, dspHistory, onClose, onCctv, embedded = false }: Props) {
  const card = describePick(hit, data, interp, state, live);
  if (!card) return null;
  let body: ReactNode = null;

  if (hit.kind === 'conduit') {
    const i = interp.conduitIndex.get(hit.id)!;
    const c = data.network.conduits[i];
    const C = state.conduits;
    const fr = Number.isNaN(C.froude[i]) ? null : C.froude[i];
    const color = STATUSES[C.status[i]] === 'SURCHARGED' ? '#F538A0' : capacityColor(C.capacity[i]);
    body = (
      <>
        <CrossSection c={c} depth={C.depth[i]} color={color} />
        <div className="text-center font-mono text-xs text-slate-300">{sectionLabel(c)} · {c.material}</div>
        <div>
          <Row k="Capacity" v={fmt(C.capacity[i] * 100, 1, ' %')} tone={color} />
          <Row k="Flow Q" v={fmt(C.flow[i], 3, ' m³/s')} />
          <Row k="Velocity V" v={fmt(C.velocity[i], 2, ' m/s')} />
          <Row k="Froude Fr" v={fr === null ? '— pressurized' : fmt(fr, 2) + (fr > 1 ? '  SUPERCRITICAL' : '  subcritical')} tone={fr !== null && fr > 1 ? '#60A5FA' : undefined} />
          <Row k="Water depth" v={`${fmt(C.depth[i], 3, ' m')} of ${c.geometry.rise_m} m`} />
          <Row k="Slope S₀" v={`${(c.slope * 100).toFixed(2)} %  (S = sin atan S₀ = ${c.slope_eff_sin.toFixed(4)})`} />
          <Row k="Manning n" v={String(c.manning_n)} />
          <Row k="Q_full / Q_max" v={`${fmt(c.q_full_cms, 2)} / ${fmt(c.q_max_cms, 2)} m³/s @ y/D ${c.y_at_qmax_ratio}`} />
          <Row k="Length" v={`${c.length_m.toFixed(1)} m (3D ${c.length_3d_m.toFixed(1)} m)`} />
          <Row k="Inverts" v={`${c.inlet_invert_m.toFixed(2)} → ${c.outlet_invert_m.toFixed(2)} m`} />
          <Row k="Nodes" v={`${c.from_node} → ${c.to_node}`} />
          <Row k="Provenance" v={`${c.source_type}${c.is_active ? '' : ' (inactive)'}`} />
          {c.spec_reference && <Row k="Spec" v={c.spec_reference} mono={false} />}
        </div>
      </>
    );
  } else if (hit.kind === 'node') {
    const i = interp.nodeIndex.get(hit.id)!;
    const n = data.network.nodes[i];
    body = (
      <>
        <NodeGauge n={n} hgl={state.nodes.hgl[i]} />
        <div>
          {card.rows.map((r) => (
            <Row key={r.label} k={r.label} v={r.value} />
          ))}
          <Row k="Catchment" v={`${n.catchment_area_ha.toFixed(2)} ha · C ${n.runoff_coeff ?? '—'}`} />
          <Row k="UTM 51N" v={`${n.utm51n_en[0].toFixed(1)}, ${n.utm51n_en[1].toFixed(1)}`} />
          <Row k="PRS92 PTM III" v={`${n.ptm3_en[0].toFixed(1)}, ${n.ptm3_en[1].toFixed(1)}`} />
          <Row k="Provenance" v={n.source_type} />
        </div>
      </>
    );
  } else if (hit.kind === 'sensor') {
    const i = interp.sensorIndex.get(hit.id)!;
    const S = state.sensors[i];
    const L = live?.[hit.id];
    const word = L ? L.payload_uint32 >>> 0 : S.payload;
    const isVision = S.sensor.hardware === 'JETSON_YOLO_TRASHRACK';
    body = (
      <>
        <div className="flex flex-wrap gap-1.5 text-[10px]">
          <span className="flex items-center gap-1 rounded-md bg-slate-800/80 px-1.5 py-0.5 font-mono text-slate-300">
            {isVision ? <Camera size={11} /> : <Cpu size={11} />} {S.sensor.device_eui}
          </span>
          <span className="rounded-md bg-slate-800/80 px-1.5 py-0.5 font-mono text-slate-300">→ {S.sensor.attached_to}</span>
          {L && (
            <span className="flex items-center gap-1 rounded-md bg-slate-800/80 px-1.5 py-0.5 font-mono text-slate-300">
              <Radio size={11} /> {L.fsm_state} · {L.current_ua >= 1000 ? `${(L.current_ua / 1000).toFixed(1)} mA` : `${L.current_ua.toFixed(0)} µA`}
            </span>
          )}
        </div>
        {onCctv && (
          <button onClick={() => onCctv(hit.id)} className="btn-sky flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold">
            <Cctv size={13} strokeWidth={1.75} /> View Nearest Command Center CCTV
          </button>
        )}
        <PayloadBreakdown word={word} saturated={L?.saturated_fields ?? S.saturated} isVision={isVision} />
        <div>
          <Row k="Anomaly" v={L?.anomaly_class ?? S.anomaly} tone={ANOMALY_COLORS[L?.anomaly_class ?? S.anomaly]} />
          <Row k="Depth (true)" v={fmt(L?.true_depth_mm ?? S.depthMm, 0, ' mm')} />
          <Row k="dh/dt" v={fmt(L?.dh_dt_mm_min ?? S.dhDtMmMin, 2, ' mm/min')} />
          <Row k="Turbulence σ̃²" v={fmt(L?.turbulence_index ?? S.turbulence, 3)} />
          <Row k="h / D" v={fmt(L?.h_over_d ?? S.hRatio, 3)} />
          <Row k="Froude Fr" v={fmt(L?.froude_number ?? S.froude, 2)} />
          <Row k="Battery" v={fmt(L?.vbat_v ?? S.vbatV, 2, ' V')} />
          {L && (
            <>
              <Row k="LoRa AS923-3" v={`${L.lora.channel_mhz.toFixed(1)} MHz · SF${L.lora.spreading_factor} · ${L.lora.time_on_air_ms.toFixed(1)} ms ToA`} />
              <Row k="RSSI / SNR" v={`${L.lora.rssi_dbm.toFixed(0)} dBm / ${L.lora.snr_db.toFixed(1)} dB`} />
              <Row k="Next wake / uplink" v={`${L.next_wake_s} s / ${L.uplink_interval_s} s`} />
              <Row k="Temperature" v={fmt(L.temperature_c, 1, ' °C')} />
            </>
          )}
        </div>
        {L && dspHistory.length > 1 && <RawVsKalmanChart samples={dspHistory} />}
        {S.sensor.payload_note && <div className="text-[10px] text-slate-500">{S.sensor.payload_note}</div>}
      </>
    );
  } else {
    body = (
      <div>
        {card.rows.map((r) => (
          <Row key={r.label} k={r.label} v={r.value} />
        ))}
        <Row k="Open area" v={fmt(state.lagoon.openAreaPct, 0, ' %')} />
        <Row k="Rack capacity" v={fmt(state.lagoon.rackCapacityCms, 3, ' m³/s')} />
        <Row k="Tunnel limit" v={fmt(interp.tunnelLimitCms, 3, ' m³/s')} />
      </div>
    );
  }

  return (
    <aside
      className={
        embedded
          ? 'hud-card flex flex-col rounded-md'
          : 'hud-card pointer-events-auto absolute inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl sm:inset-x-auto sm:bottom-3 sm:right-3 sm:top-[calc(var(--topbar-h,52px)+20px)] sm:max-h-none sm:w-[400px] sm:rounded-2xl'
      }
      aria-label="Selected asset inspector"
    >
      <header className="flex items-start justify-between gap-2 border-b border-white/5 p-4" style={{ borderTop: `2px solid ${card.accent}`, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{card.kicker}</div>
          <div className="font-mono text-lg font-semibold text-white">{card.title}</div>
          <div className="truncate text-xs text-slate-400">{card.subtitle}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {card.badges.map((b) => (
              <span key={b.text} className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ color: b.color, background: `${b.color}1F`, boxShadow: `inset 0 0 0 1px ${b.color}55` }}>
                {b.text}
              </span>
            ))}
          </div>
        </div>
        <button onClick={onClose} className="btn-idle rounded-lg p-1.5" aria-label="Close inspector">
          <X size={16} />
        </button>
      </header>
      <div className={`space-y-3 p-4 ${embedded ? '' : 'overflow-y-auto'}`} style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
        {body}
      </div>
    </aside>
  );
}
