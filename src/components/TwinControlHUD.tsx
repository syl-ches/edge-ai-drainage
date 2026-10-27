import { memo, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CloudRain,
  Crosshair,
  Maximize2,
  Play,
  QrCode,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Waves,
  WifiOff,
} from 'lucide-react';
import type { CameraPreset, CameraPresetId } from '../three/TwinEngine';
import type { FusionVerdict } from '../types/live';
import type { LiveSnapshot } from '../live/telemetry';
import { rainfallClass, type TwinState } from '../utils/lutInterpolator';
import type { HudMode } from '../utils/urlState';
import { fmt } from './describe';
import { RawVsKalmanChart, type DspSample } from './RawVsKalmanChart';

export const HUD_PRESETS = [
  { id: 'dry', label: 'Baseline Dry', rain: 0, clog: 0 },
  { id: 'choke', label: 'Light Rain / Choke Test', rain: 25, clog: 0 },
  { id: 'monsoon', label: 'Monsoon Surge', rain: 100, clog: 50 },
  { id: 'typhoon', label: 'Ondoy/Typhoon Worst-Case', rain: 200, clog: 85 },
] as const;

const PIPE_SCALES = [1, 2.5];

interface Props {
  state: TwinState;
  rev: number;
  mode: HudMode;
  onMode(m: HudMode): void;
  rain: number;
  clog: number;
  onRain(v: number): void;
  onClog(v: number): void;
  scale: number;
  onScale(v: number): void;
  cameras: CameraPreset[];
  onCamera(id: CameraPresetId): void;
  fps: number;
  live: LiveSnapshot | null;
  fusion: FusionVerdict;
  dspHistory: DspSample[];
  dspSensor: string;
  onShare(): void;
  basemapOffline: boolean;
}

function Section({ icon, title, right, children }: { icon: ReactNode; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
        <span className="flex items-center gap-1.5">
          {icon}
          {title}
        </span>
        {right}
      </div>
      {children}
    </section>
  );
}

function Seg({ items, value, onChange, fmt: f }: { items: number[]; value: number; onChange(v: number): void; fmt(v: number): string }) {
  return (
    <div className="flex rounded-lg bg-slate-900/80 p-0.5 ring-1 ring-white/5">
      {items.map((it) => (
        <button
          key={it}
          onClick={() => onChange(it)}
          className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
            Math.abs(it - value) < 1e-6 ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/40' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {f(it)}
        </button>
      ))}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  gradient,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(v: number): void;
  disabled?: boolean;
  gradient: string;
  label: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      aria-label={label}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="hud-range h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-70"
      style={{ background: `linear-gradient(90deg, ${gradient} ${pct}%, rgba(51,65,85,0.6) ${pct}%)` }}
    />
  );
}

function Stat({ label, value, tone = 'text-slate-100', sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`truncate font-mono text-[13px] ${tone}`}>{value}</div>
      {sub && <div className="truncate text-[9px] text-slate-500">{sub}</div>}
    </div>
  );
}

const FUSION_TONE: Record<FusionVerdict['severity'], string> = {
  INFO: 'border-sky-500/30 bg-sky-500/5 text-sky-200',
  WARNING: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  CRITICAL: 'border-rose-500/50 bg-rose-500/10 text-rose-200',
};

function TwinControlHUDImpl(p: Props) {
  const [open, setOpen] = useState(true);
  const L = p.state.lagoon;
  const rc = rainfallClass(p.rain);
  const live = p.mode === 'LIVE';
  const depthPct = Math.min(L.depthM / 6.5, 1.15) * 100;
  const chokeBound = L.control === 'TUNNEL_CHOKE';
  const rackBound = L.control === 'TRASH_RACK';
  const fpsTone = p.fps >= 55 ? 'text-emerald-400' : p.fps >= 40 ? 'text-amber-400' : 'text-rose-400';
  const severity = p.clog >= 75 ? { t: 'Severe', c: '#EF4444' } : p.clog >= 35 ? { t: 'Moderate', c: '#F59E0B' } : p.clog > 0 ? { t: 'Minor', c: '#FCC934' } : { t: 'Clean', c: '#4ADE80' };

  return (
    <aside
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex max-h-[62vh] flex-col rounded-t-2xl border border-slate-800/80 bg-slate-950/75 text-slate-200 shadow-2xl shadow-black/60 backdrop-blur-md sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-3 sm:max-h-[calc(100vh-24px)] sm:w-[380px] sm:rounded-2xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-3">
        <button onClick={() => setOpen(!open)} className="min-w-0 text-left">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-700 sm:hidden" />
          <div className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-sky-300 ring-1 ring-sky-400/30">
            <Waves size={10} /> Edge-AI Digital Twin
          </div>
          <h1 className="mt-1 text-[15px] font-semibold leading-tight text-white">City Camp Lagoon 3D Subsurface Digital Twin</h1>
          <div className="text-[11px] text-slate-400">Baguio City · Mirador karst doline · 1426.5 m ASL</div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {p.basemapOffline && <WifiOff size={14} className="text-amber-400" aria-label="Basemap offline" />}
          <span className={`font-mono text-[10px] ${fpsTone}`}>
            <Activity size={11} className="mr-0.5 inline" />
            {p.fps.toFixed(0)}
          </span>
          <button onClick={p.onShare} className="rounded-lg p-1.5 text-slate-300 ring-1 ring-white/10 hover:bg-white/5" aria-label="Share via QR">
            <QrCode size={15} />
          </button>
          <button onClick={() => setOpen(!open)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5" aria-label="Collapse panel">
            {open ? <ChevronDown size={15} className="sm:rotate-180" /> : <ChevronUp size={15} className="sm:rotate-180" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-4 overflow-y-auto overscroll-contain px-4 pb-4">
          {/* Mode switch */}
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-900/80 p-1 ring-1 ring-white/5">
            {(
              [
                ['SIM', 'Scenario Simulation', <SlidersHorizontal key="i" size={12} />],
                ['LIVE', 'Live Telemetry Preview', <Radio key="i" size={12} />],
              ] as const
            ).map(([m, label, icon]) => (
              <button
                key={m}
                onClick={() => p.onMode(m)}
                className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                  p.mode === m ? (m === 'LIVE' ? 'bg-rose-500/20 text-rose-200 ring-1 ring-rose-400/40' : 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40') : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {live && p.live && (
            <div className="space-y-2 rounded-xl bg-slate-900/60 p-3 ring-1 ring-white/5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-rose-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />
                  {p.live.source === 'BACKEND_WS' ? 'Backend stream' : 'Local storm playback'}
                </span>
                <span className="font-mono text-slate-400">
                  T+{Math.floor(p.live.clockS / 60)}:{String(Math.floor(p.live.clockS % 60)).padStart(2, '0')} / {Math.round(p.live.periodS)} s
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full bg-gradient-to-r from-sky-400 via-amber-400 to-rose-500" style={{ width: `${(p.live.clockS / p.live.periodS) * 100}%` }} />
              </div>
              <div className="truncate font-mono text-[9px] text-slate-500">
                {p.live.source === 'BACKEND_WS' ? `${p.live.wsUrl} · seq ${p.live.frame?.seq ?? 0}` : `Waiting for ${p.live.wsUrl} (auto-retry 5 s)`}
                {p.live.frame?.hardware_override && ` · HW ${p.live.frame.hardware_override.sensor_id}`}
              </div>
            </div>
          )}

          {/* Sliders */}
          <Section
            icon={<CloudRain size={11} />}
            title="Rainfall intensity"
            right={
              <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal" style={{ color: rc.color, background: `${rc.color}1A`, boxShadow: `inset 0 0 0 1px ${rc.color}55` }}>
                {rc.label}
              </span>
            }
          >
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-2xl font-semibold text-white">
                {p.rain.toFixed(0)}
                <span className="ml-1 text-xs text-slate-400">mm/hr</span>
              </span>
              <span className="text-[10px] text-slate-500">0 – 250</span>
            </div>
            <Slider label="Rainfall mm/hr" value={p.rain} min={0} max={250} step={1} onChange={p.onRain} disabled={live} gradient="#12B5CB, #FCC934, #F538A0" />
          </Section>

          <Section
            icon={<AlertTriangle size={11} />}
            title="Tunnel trash-rack blockage"
            right={
              <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal" style={{ color: severity.c, background: `${severity.c}1A` }}>
                {severity.t}
              </span>
            }
          >
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-2xl font-semibold text-white">
                {p.clog.toFixed(0)}
                <span className="ml-1 text-xs text-slate-400">% occluded</span>
              </span>
              <span className="text-[10px] text-slate-500">0 – 95</span>
            </div>
            <Slider label="Trash rack blockage %" value={p.clog} min={0} max={95} step={1} onChange={p.onClog} disabled={live} gradient="#4ADE80, #F59E0B, #EF4444" />
            <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-900/60 p-2 ring-1 ring-white/5">
              <Stat label="Kirschmer ΔH" value={`${fmt(L.headLossM, 3)} m`} tone="text-amber-200" />
              <Stat label="Open area" value={`${fmt(L.openAreaPct, 0)} %`} />
              <Stat label="ξ(p)" value={fmt(L.xiRack, 2)} sub="∝ (1−p)⁻²" />
            </div>
          </Section>

          {!live && (
            <div className="flex flex-wrap gap-1.5">
              {HUD_PRESETS.map((pr) => {
                const active = Math.abs(p.rain - pr.rain) < 0.5 && Math.abs(p.clog - pr.clog) < 0.5;
                return (
                  <button
                    key={pr.id}
                    onClick={() => {
                      p.onRain(pr.rain);
                      p.onClog(pr.clog);
                    }}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition ${
                      active ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/50' : 'bg-slate-900/70 text-slate-300 ring-1 ring-white/10 hover:bg-slate-800'
                    }`}
                  >
                    {pr.label}
                    <span className="ml-1 font-mono text-slate-500">
                      {pr.rain}/{pr.clog}%
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Executive card */}
          <Section icon={<Waves size={11} />} title="Lagoon & bottleneck">
            <div className="space-y-3 rounded-xl bg-slate-900/60 p-3 ring-1 ring-white/5">
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Water depth</span>
                  <span className={`font-mono text-sm ${L.isOverflowing ? 'text-rose-400' : 'text-teal-300'}`}>
                    {fmt(L.depthM, 2)} m <span className="text-slate-500">/ 6.5 m max</span>
                  </span>
                </div>
                <div className="relative mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className={`h-full rounded-full transition-[width] duration-100 ${L.isOverflowing ? 'animate-pulse bg-rose-500' : 'bg-gradient-to-r from-teal-600 to-teal-300'}`}
                    style={{ width: `${Math.min(depthPct, 100)}%` }}
                  />
                  <div className="absolute inset-y-0 left-[23%] w-px bg-slate-500/60" title="Permanent pool / rack sill 1.5 m" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Surface elev" value={fmt(L.surfaceElevM, 2)} sub="m ASL" />
                <Stat
                  label="Overflow in"
                  value={L.isOverflowing ? 'NOW' : L.timeToOverflowMin === null ? 'none' : `${L.timeToOverflowMin.toFixed(0)} min`}
                  tone={L.isOverflowing || L.timeToOverflowMin !== null ? 'text-rose-400' : 'text-emerald-400'}
                  sub="if rain persists"
                />
                <Stat label="Q out" value={`${fmt(L.orificeFlowCms, 2)}`} sub={`m³/s · in ${fmt(L.inflowCms, 1)}`} />
              </div>
              <div
                className={`rounded-lg p-2 text-[11px] ring-1 ${
                  chokeBound ? 'bg-orange-500/10 text-orange-200 ring-orange-400/40' : rackBound ? 'bg-rose-500/10 text-rose-200 ring-rose-400/40' : 'bg-slate-800/50 text-slate-400 ring-white/5'
                }`}
              >
                <div className="text-[9px] uppercase tracking-wider opacity-70">Governing hydraulic bottleneck</div>
                <div className="font-semibold">
                  {chokeBound
                    ? '1.5 m × 1.7 m unfinished rock tunnel choke (4.44 m³/s)'
                    : rackBound
                      ? 'City Camp steel trash-rack orifice'
                      : 'None — lagoon at permanent pool'}
                </div>
                <div className="font-mono text-[9px] opacity-70">{L.bottleneck}</div>
              </div>
              <div className="flex justify-between font-mono text-[10px]">
                <span className="text-cyan-flow">NORMAL {p.state.statusCounts.NORMAL}</span>
                <span className="text-amber-flow">ELEV {p.state.statusCounts.ELEVATED}</span>
                <span className="text-tangerine">CRIT {p.state.statusCounts.CRITICAL}</span>
                <span className="text-surge">SURCH {p.state.statusCounts.SURCHARGED}</span>
              </div>
            </div>
          </Section>

          {/* Fusion */}
          <Section icon={<ShieldCheck size={11} />} title="Multi-sensor fusion cross-check">
            <div className={`space-y-1.5 rounded-xl border p-3 text-[11px] ${FUSION_TONE[p.fusion.severity]}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-semibold">{p.fusion.root_cause}</span>
                <span className="font-mono text-[10px] opacity-70">{(p.fusion.confidence * 100).toFixed(0)}%</span>
              </div>
              <div className="leading-snug">{p.fusion.action}</div>
              {p.fusion.suppressed_false_alarm && (
                <div className="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 ring-1 ring-emerald-400/30">
                  EN-08 “TRASH_BLOCKAGE” suppressed — vision shows a clear rack.
                </div>
              )}
              <ul className="space-y-0.5 font-mono text-[9px] opacity-80">
                {p.fusion.evidence.map((e) => (
                  <li key={e}>• {e}</li>
                ))}
              </ul>
            </div>
          </Section>

          {live && p.dspHistory.length > 1 && (
            <Section icon={<Activity size={11} />} title={`Edge DSP · ${p.dspSensor} raw vs Kalman`}>
              <RawVsKalmanChart samples={p.dspHistory} />
            </Section>
          )}

          {live && p.live?.frame && (
            <Section icon={<Play size={11} />} title="ST-GNN nowcast">
              <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-900/60 p-2 ring-1 ring-white/5">
                {p.live.frame.nowcast.horizons.map((h) => (
                  <div key={h.minutes} className="min-w-0">
                    <div className="text-[9px] uppercase text-slate-500">+{h.minutes} min</div>
                    <div className="font-mono text-[13px] text-teal-200">{h.lagoon_depth_m.toFixed(2)} m</div>
                    <div className="font-mono text-[9px] text-rose-300">P(surch) {h.surcharge_probability_pct.toFixed(0)}%</div>
                    <div className="font-mono text-[9px] text-slate-500">{h.time_to_overflow_min === null ? 'no overflow' : `ovf ${h.time_to_overflow_min.toFixed(0)} min`}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* View */}
          <Section icon={<Maximize2 size={11} />} title="Pipe visibility scale">
            <Seg items={PIPE_SCALES} value={p.scale} onChange={p.onScale} fmt={(v) => (v === 1 ? '1.0× true scale' : '2.5× visibility')} />
          </Section>
          <Section icon={<Crosshair size={11} />} title="Camera">
            <div className="grid grid-cols-2 gap-1">
              {p.cameras.map((c) => (
                <button
                  key={c.id}
                  onClick={() => p.onCamera(c.id)}
                  className="rounded-lg bg-slate-900/70 px-2 py-1.5 text-left text-[11px] ring-1 ring-white/5 transition hover:bg-slate-800/80 hover:ring-sky-400/30"
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Section>
        </div>
      )}
    </aside>
  );
}

export const TwinControlHUD = memo(TwinControlHUDImpl);
