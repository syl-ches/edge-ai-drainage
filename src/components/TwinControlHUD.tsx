import { memo, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CloudRain,
  CloudSun,
  Cpu,
  Crosshair,
  Maximize2,
  Play,
  QrCode,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Usb,
  Waves,
  WifiOff,
} from 'lucide-react';
import type { CameraPreset, CameraPresetId } from '../three/TwinEngine';
import type { FusionVerdict } from '../types/live';
import type { LiveSnapshot } from '../live/telemetry';
import type { LiveDriver, LiveTarget } from '../live/liveDriver';
import type { WeatherNow } from '../live/weather';
import type { Forecast, StormDef } from '../forecast/stgnn';
import type { UsbRig } from '../live/useUsbRig';
import { ForecastPanel } from './ForecastPanel';
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
  driver: LiveDriver;
  onDriver(d: LiveDriver): void;
  liveTarget: LiveTarget;
  weather: WeatherNow;
  storms: StormDef[];
  forecast: Forecast | null;
  forecastOrigin: 'BACKEND' | 'BROWSER';
  usb: UsbRig;
  usbSensorId: string;
  onHardwareSim(): void;
  fusion: FusionVerdict;
  dspHistory: DspSample[];
  dspSensor: string;
  onShare(): void;
  basemapOffline: boolean;
}

function Section({ icon, title, right, children }: { icon: ReactNode; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
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
    <div className="flex gap-1">
      {items.map((it) => (
        <button
          key={it}
          onClick={() => onChange(it)}
          className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] ${Math.abs(it - value) < 1e-6 ? 'btn-active' : 'btn-idle'}`}
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
      <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`truncate font-mono text-[13px] font-semibold ${tone}`}>{value}</div>
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
      className="hud-card pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex max-h-[62vh] flex-col rounded-t-2xl text-slate-200 sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-3 sm:max-h-[calc(100vh-24px)] sm:w-[380px] sm:rounded-2xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-3">
        <button onClick={() => setOpen(!open)} className="min-w-0 text-left">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-700 sm:hidden" />
          <div className="btn-accent inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-[0.16em]">
            <Waves size={10} /> Edge-AI Digital Twin
          </div>
          <h1 className="mt-1 text-[15px] font-bold leading-tight text-white">City Camp Lagoon 3D Subsurface Digital Twin</h1>
          <div className="text-[11px] font-medium text-slate-400">Baguio City · Mirador karst doline · 1426.5 m ASL</div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {p.basemapOffline && <WifiOff size={14} className="text-amber-400" aria-label="Basemap offline" />}
          <span className={`font-mono text-[10px] ${fpsTone}`}>
            <Activity size={11} className="mr-0.5 inline" />
            {p.fps.toFixed(0)}
          </span>
          <button onClick={p.onShare} className="btn-idle rounded-lg p-1.5" aria-label="Share via QR">
            <QrCode size={15} />
          </button>
          <button onClick={() => setOpen(!open)} className="btn-idle rounded-lg p-1.5" aria-label="Collapse panel">
            {open ? <ChevronDown size={15} className="sm:rotate-180" /> : <ChevronUp size={15} className="sm:rotate-180" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-4 overflow-y-auto overscroll-contain px-4 pb-4">
          {/* Mode switch */}
          <div className="grid grid-cols-2 gap-1">
            {(
              [
                ['LIVE', 'Live Weather & Telemetry', <Radio key="i" size={12} />],
                ['SIM', 'Scenario Simulation', <SlidersHorizontal key="i" size={12} />],
              ] as const
            ).map(([m, label, icon]) => (
              <button
                key={m}
                onClick={() => p.onMode(m)}
                className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[10px] uppercase tracking-wider ${
                  p.mode === m ? (m === 'LIVE' ? 'btn-accent' : 'btn-active') : 'btn-idle'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {live && (
            <div className="space-y-2 rounded-xl bg-slate-900/60 p-3 ring-1 ring-slate-700">
              <div className="flex items-center justify-between gap-2 text-[10px]">
                <span className="flex min-w-0 items-center gap-1.5 font-bold uppercase tracking-wider text-emerald-300">
                  <span className={`h-2 w-2 shrink-0 animate-pulse rounded-full ${p.liveTarget.source === 'HARDWARE' ? 'bg-[#dc2626]' : 'bg-[#10b981]'}`} />
                  <span className="truncate">{p.liveTarget.label}</span>
                </span>
                <span className="shrink-0 font-mono font-semibold text-slate-400">
                  {p.live?.source === 'BACKEND_WS' ? 'backend ● live' : 'backend offline'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-200">
                <CloudSun size={14} className="shrink-0 text-sky-300" />
                <span className="font-mono">{p.weather.rainMmHr.toFixed(1)} mm/hr</span>
                <span className="font-mono">{p.weather.temperatureC !== null ? `${p.weather.temperatureC.toFixed(1)} °C` : '— °C'}</span>
                <span className="truncate">{p.weather.label}</span>
                <span className="ml-auto shrink-0 text-[9px] font-medium uppercase text-slate-500">
                  {p.weather.source === 'OPEN_METEO' ? 'Open-Meteo' : p.weather.source === 'CACHED' ? 'cached' : 'baseline'}
                </span>
              </div>
              {p.driver.kind === 'REPLAY' && p.live && p.live.source !== 'OFFLINE' && (
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-gradient-to-r from-sky-400 via-amber-400 to-rose-500" style={{ width: `${(p.live.clockS / p.live.periodS) * 100}%` }} />
                </div>
              )}
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Live pitch scenarios (pushed to the edge fleet)</div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => p.onDriver({ kind: 'WEATHER' })}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] ${p.driver.kind === 'WEATHER' ? 'btn-accent' : 'btn-idle'}`}
                >
                  <CloudSun size={11} /> Live weather
                </button>
                {HUD_PRESETS.filter((pr) => pr.id !== 'dry').map((pr) => (
                  <button
                    key={pr.id}
                    onClick={() => p.onDriver({ kind: 'PITCH', id: pr.id, label: pr.label, rain: pr.rain, clog: pr.clog })}
                    className={`rounded-full px-2.5 py-1 text-[10px] ${p.driver.kind === 'PITCH' && p.driver.id === pr.id ? 'btn-active' : 'btn-idle'}`}
                  >
                    {pr.label}
                  </button>
                ))}
              </div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Historical Baguio storm replay (ST-GNN source)</div>
              <div className="flex gap-1.5">
                <select
                  aria-label="Historical storm"
                  value={p.driver.kind === 'REPLAY' ? p.driver.stormId : ''}
                  onChange={(e) => {
                    const st = p.storms.find((x) => x.id === e.target.value);
                    if (st) p.onDriver({ kind: 'REPLAY', stormId: st.id, label: st.label });
                  }}
                  className="btn-idle min-w-0 flex-1 rounded-lg px-2 py-1 text-[10px]"
                >
                  <option value="" disabled>
                    Choose a storm hyetograph…
                  </option>
                  {p.storms.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.label} · peak {st.peak_mm_hr.toFixed(0)} mm/h · {(st.duration_min / 60).toFixed(0)} h
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const st = p.storms.find((x) => x.id === (p.driver.kind === 'REPLAY' ? p.driver.stormId : 'DESIGN_TYPHOON_12H')) ?? p.storms[0];
                    p.onDriver({ kind: 'REPLAY', stormId: st.id, label: st.label });
                  }}
                  className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10px] ${p.driver.kind === 'REPLAY' ? 'btn-danger' : 'btn-amber'}`}
                >
                  <Play size={11} /> Replay
                </button>
              </div>
              <div className="text-[9px] text-slate-500">Synthetic design hyetographs shaped after each event, not gauge records.</div>
              {p.live?.frame?.hardware_override && (
                <div className="btn-danger flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px]">
                  <Cpu size={12} /> Hardware override · {p.live.frame.hardware_override.sensor_id} ({p.live.frame.hardware_override.age_s.toFixed(0)} s ago)
                </div>
              )}
              <div className="truncate font-mono text-[9px] text-slate-500">
                {p.live?.source === 'BACKEND_WS' ? `${p.live.wsUrl} · seq ${p.live.frame?.seq ?? 0}` : `Waiting for ${p.live?.wsUrl ?? 'backend'} (auto-retry 5 s)`}
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
              <span className="font-mono text-2xl font-bold text-white">
                {p.rain.toFixed(p.rain < 10 && p.rain % 1 !== 0 ? 1 : 0)}
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
              <span className="font-mono text-2xl font-bold text-white">
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
                    className={`rounded-full px-2.5 py-1 text-[10px] ${active ? 'btn-active' : 'btn-idle'}`}
                  >
                    {pr.label}
                    <span className="ml-1 font-mono opacity-70">
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

          {p.forecast && (
            <Section icon={<Play size={11} />} title="ST-GNN forecast · +15 / +30 / +60 min">
              <ForecastPanel forecast={p.forecast} origin={p.forecastOrigin} />
            </Section>
          )}

          {/* Physical rig */}
          <Section icon={<Cpu size={11} />} title="Arduino / ESP32 hardware rig">
            <div className="space-y-2 rounded-xl bg-slate-900/60 p-3 ring-1 ring-slate-700">
              <div className="flex flex-wrap gap-1.5">
                {p.usb.status === 'connected' ? (
                  <button onClick={() => void p.usb.disconnect()} className="btn-danger flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px]">
                    <Usb size={12} /> Disconnect {p.usb.label}
                  </button>
                ) : (
                  <button
                    onClick={() => void p.usb.connect()}
                    disabled={p.usb.status === 'unsupported' || p.usb.status === 'connecting'}
                    title={p.usb.status === 'unsupported' ? 'Web Serial needs Chrome or Edge on desktop (or use scripts/serial_bridge.py)' : 'Pick the board in the browser port dialog (115200 baud)'}
                    className="btn-active flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px] disabled:opacity-50"
                  >
                    <Usb size={12} /> {p.usb.status === 'connecting' ? 'Connecting…' : 'Connect Physical USB Arduino / ESP32'}
                  </button>
                )}
                <button onClick={p.onHardwareSim} className="btn-amber flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px]">
                  <Cpu size={12} /> Aquarium Sim ↗
                </button>
              </div>
              <div className="text-[10px] font-medium text-slate-400">
                {p.usb.status === 'unsupported'
                  ? 'Web Serial unavailable in this browser: use Chrome / Edge, the Aquarium Sim tab, or scripts/serial_bridge.py.'
                  : p.usb.status === 'connected'
                    ? `Streaming to ${p.usbSensorId} (select a sensor to retarget). Last: ${p.usb.lines.at(-1) ?? '—'}`
                    : `Targets ${p.usbSensorId}. Accepts [EDGE_TX] frames, DIST_MM / DIST_CM / FILL_PCT lines or plain distances.`}
                {p.usb.error && <span className="block text-rose-300">{p.usb.error}</span>}
              </div>
            </div>
          </Section>

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
                  className="btn-idle rounded-lg px-2 py-1.5 text-left text-[11px]"
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
