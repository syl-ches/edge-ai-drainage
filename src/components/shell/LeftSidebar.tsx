// Collapsible 280 px left sidebar (Phase 9A): coordinates + node search, CATCHMENT SCOPE,
// TELEMETRY · WEATHER (Live Weather | Storm Sim) and LAYER cards. Catchment figures are
// computed from the network file, never typed in.
import { memo, useMemo, type ReactNode } from 'react';
import { ChevronLeft, CloudRain, Crosshair, Droplets, Mountain, Play, RotateCcw, Thermometer, Waves, Wind } from 'lucide-react';
import type { NetworkFile } from '../../types/twin';
import type { TwinState } from '../../utils/lutInterpolator';
import type { HudMode, LayerFlags } from '../../utils/urlState';
import type { WeatherNow } from '../../live/weather';
import type { LiveDriver, LiveTarget } from '../../live/liveDriver';
import type { LiveSnapshot } from '../../live/telemetry';
import type { StormDef } from '../../forecast/stgnn';
import type { CatchmentScope } from '../../three/TwinEngine';
import { SearchBox, type SearchPick } from '../SearchBox';
import { dms, LIVE_PITCH_PRESETS, STORM_SIM_PRESETS, weatherStatus, type SurfaceMode } from '../../ui/shell';

export interface CatchmentStats {
  invertM: number;
  rimM: number;
  areaHa: number;
  barangays: number;
  conduits: number;
  nodes: number;
  edgeNodes: number;
  tunnelKm: number;
}

/** Figures for the CATCHMENT SCOPE card, all derived from city_camp_network.json. */
export function catchmentStats(net: NetworkFile): CatchmentStats {
  const active = <T extends { is_active: boolean }>(xs: T[]) => xs.filter((x) => x.is_active);
  return {
    invertM: net.lagoon.invert_elev_m,
    rimM: net.lagoon.rim_elev_m,
    areaHa: active(net.nodes).reduce((s, n) => s + (n.catchment_area_ha ?? 0), 0),
    barangays: new Set(active(net.buildings).map((b) => b.barangay)).size,
    conduits: active(net.conduits).length,
    nodes: active(net.nodes).length,
    edgeNodes: active(net.sensors).length,
    tunnelKm: active(net.conduits).filter((c) => c.network === 'TUNNEL').reduce((s, c) => s + c.length_m, 0) / 1000,
  };
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="sh-card rounded-md p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="sh-title">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-[12px]">
      <span className="sh-muted shrink-0">{k}</span>
      <span className="sh-mono sh-ink truncate text-right text-[11.5px]">{v}</span>
    </div>
  );
}

function Scrubber({ label, value, max, unit, onChange }: { label: string; value: number; max: number; unit: string; onChange(v: number): void }) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[12px]">
        <span className="sh-muted">{label}</span>
        <span className="sh-mono sh-ink">
          {value.toFixed(0)} {unit}
        </span>
      </span>
      <input type="range" min={0} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="sh-range mt-1 w-full" />
      <span className="sh-mono sh-muted flex justify-between text-[10px]">
        <span>0</span>
        <span>{max}</span>
      </span>
    </label>
  );
}

interface Props {
  open: boolean;
  onToggle(): void;
  network: NetworkFile;
  state: TwinState;
  onSearchPick(p: SearchPick): void;
  scope: CatchmentScope;
  onScope(s: CatchmentScope): void;
  onRecenter(): void;
  onReset(): void;
  mode: HudMode;
  onMode(m: HudMode): void;
  weather: WeatherNow;
  liveTarget: LiveTarget;
  live: LiveSnapshot | null;
  driver: LiveDriver;
  onDriver(d: LiveDriver): void;
  storms: StormDef[];
  rain: number;
  clog: number;
  onRain(v: number): void;
  onClog(v: number): void;
  layers: LayerFlags;
  onToggleLayer(k: keyof LayerFlags): void;
  surface: SurfaceMode;
  onSurface(m: SurfaceMode): void;
}

const SCOPES: { id: CatchmentScope; label: string; icon: ReactNode }[] = [
  { id: 'bowl', label: 'Basin Bowl', icon: <Droplets size={18} strokeWidth={1.5} /> },
  { id: 'tunnel', label: 'Tunnel Choke', icon: <Mountain size={18} strokeWidth={1.5} /> },
  { id: 'grid', label: 'Full Grid', icon: <Waves size={18} strokeWidth={1.5} /> },
];

const LAYER_ROWS: { key: keyof LayerFlags; label: string }[] = [
  { key: 'network', label: 'Subsurface Conduits' },
  { key: 'waterways', label: 'Surface Waterways' },
  { key: 'buildings', label: '3D Buildings' },
  { key: 'vegetation', label: 'Tree Canopy' },
  { key: 'badges', label: 'Sensor Pins & Badges' },
];

function LeftSidebarImpl(p: Props) {
  const stats = useMemo(() => catchmentStats(p.network), [p.network]);
  const a = p.network.meta.anchor;
  const sim = p.mode === 'SIM';
  return (
    <aside className="sh-panel sh-hair-r relative flex h-full w-[280px] shrink-0 flex-col" aria-label="Catchment controls" data-testid="left-sidebar">
      <button onClick={p.onToggle} className="sh-btn absolute -right-[19px] top-3 z-20 rounded-r-md border-l-0 px-0.5 py-3" aria-label="Collapse left sidebar">
        <ChevronLeft size={14} strokeWidth={1.5} />
      </button>
      <div className="space-y-2.5 overflow-y-auto overscroll-contain p-2.5">
        <SearchBox network={p.network} state={p.state} onPick={p.onSearchPick} variant="field" placeholder={dms(a.lat, a.lon)} />

        <Card title="Catchment Scope">
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Catchment scope">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                role="radio"
                aria-checked={p.scope === s.id}
                aria-pressed={p.scope === s.id}
                onClick={() => p.onScope(s.id)}
                className="sh-tile sh-scope flex h-[68px] flex-col items-center justify-center gap-1 rounded-md text-[11px] font-medium"
              >
                {s.icon}
                {s.label}
              </button>
            ))}
          </div>
          <div className="mt-2.5">
            <KV k="Elevation" v={`${stats.invertM.toFixed(1)}–${stats.rimM.toFixed(1)} m ASL`} />
            <KV k="Area" v={`${stats.areaHa.toFixed(1)} ha · ${stats.barangays} barangays`} />
            <KV k="Network" v={`${stats.conduits} conduits · ${stats.edgeNodes} nodes`} />
            <KV k="Tunnel" v={`${stats.tunnelKm.toFixed(2)} km to Crystal Cave`} />
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            <button onClick={p.onRecenter} className="sh-btn flex items-center justify-center gap-1 whitespace-nowrap rounded-md py-1.5 text-[11.5px] font-medium">
              <Crosshair size={13} strokeWidth={1.5} /> Recenter Basin
            </button>
            <button onClick={p.onReset} className="sh-btn flex items-center justify-center gap-1 whitespace-nowrap rounded-md py-1.5 text-[11.5px] font-medium">
              <RotateCcw size={13} strokeWidth={1.5} /> Reset View
            </button>
          </div>
        </Card>

        <Card title="Telemetry · Weather">
          <div className="sh-seg mb-2.5 !rounded-md" role="radiogroup" aria-label="Driver">
            {(
              [
                ['LIVE', 'Live Weather'],
                ['SIM', 'Storm Sim'],
              ] as const
            ).map(([m, label]) => (
              <button key={m} role="radio" aria-checked={p.mode === m} onClick={() => p.onMode(m)} className="flex-1 !rounded-[5px]">
                {label}
              </button>
            ))}
          </div>
          {!sim ? (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    [<CloudRain key="r" size={13} strokeWidth={1.5} />, `${p.weather.rainMmHr.toFixed(1)}`, 'mm/hr'],
                    [<Thermometer key="t" size={13} strokeWidth={1.5} />, p.weather.temperatureC !== null ? p.weather.temperatureC.toFixed(1) : '—', '°C'],
                    [<Wind key="w" size={13} strokeWidth={1.5} />, p.weather.windKmh !== null ? p.weather.windKmh.toFixed(0) : '—', 'km/h'],
                  ] as const
                ).map(([icon, v, u], i) => (
                  <div key={i} className="sh-card rounded-md px-2 py-1.5">
                    <div className="sh-muted">{icon}</div>
                    <div className="sh-mono sh-ink text-[15px] font-bold leading-tight">{v}</div>
                    <div className="sh-muted text-[10px]">{u}</div>
                  </div>
                ))}
              </div>
              <div className="text-[11px]">
                <span className="sh-ink font-medium">{p.weather.label}</span>
                <span className="sh-muted block">{weatherStatus(p.mode, p.weather, p.liveTarget)}</span>
                <span className="sh-muted block">
                  Source: {p.weather.source === 'OPEN_METEO' ? 'Open-Meteo' : p.weather.source === 'CACHED' ? 'Open-Meteo (cached)' : 'baseline'} · edge{' '}
                  {p.live?.source === 'BACKEND_WS' ? 'backend live' : 'backend offline'} · ESP32 serial ready
                </span>
              </div>
              <div className="sh-label pt-1">Pitch scenarios (pushed to the edge fleet)</div>
              <div className="flex flex-wrap gap-1">
                <button onClick={() => p.onDriver({ kind: 'WEATHER' })} className={`sh-btn rounded-md px-2 py-1 text-[11px] ${p.driver.kind === 'WEATHER' ? 'sh-on' : ''}`}>
                  Live weather
                </button>
                {LIVE_PITCH_PRESETS.map((pr) => (
                  <button
                    key={pr.id}
                    onClick={() => p.onDriver({ kind: 'PITCH', id: pr.id, label: pr.label, rain: pr.rain, clog: pr.clog })}
                    className={`sh-btn rounded-md px-2 py-1 text-[11px] ${p.driver.kind === 'PITCH' && p.driver.id === pr.id ? 'sh-on' : ''}`}
                  >
                    {pr.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <select
                  aria-label="Historical storm"
                  value={p.driver.kind === 'REPLAY' ? p.driver.stormId : ''}
                  onChange={(e) => {
                    const st = p.storms.find((x) => x.id === e.target.value);
                    if (st) p.onDriver({ kind: 'REPLAY', stormId: st.id, label: st.label });
                  }}
                  className="sh-input min-w-0 flex-1 rounded-md px-2 py-1 text-[11px]"
                >
                  <option value="" disabled>
                    Historical storm replay…
                  </option>
                  {p.storms.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.label} · peak {st.peak_mm_hr.toFixed(0)} mm/h
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const st = p.storms.find((x) => x.id === (p.driver.kind === 'REPLAY' ? p.driver.stormId : 'DESIGN_TYPHOON_12H')) ?? p.storms[0];
                    p.onDriver({ kind: 'REPLAY', stormId: st.id, label: st.label });
                  }}
                  className={`sh-btn flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${p.driver.kind === 'REPLAY' ? 'sh-on' : ''}`}
                >
                  <Play size={12} strokeWidth={1.5} /> Replay
                </button>
              </div>
              <div className="sh-muted text-[10px]">Storm replays are synthetic design hyetographs shaped after each event, not gauge records.</div>
            </div>
          ) : (
            <div className="space-y-3">
              <Scrubber label="Rainfall intensity" value={p.rain} max={250} unit="mm/hr" onChange={p.onRain} />
              <Scrubber label="Trash rack occlusion" value={p.clog} max={95} unit="%" onChange={p.onClog} />
              <label className="block text-[12px]">
                <span className="sh-muted">Preset scenario</span>
                <select
                  aria-label="Preset scenario"
                  value={STORM_SIM_PRESETS.find((pr) => Math.abs(pr.rain - p.rain) < 0.5 && Math.abs(pr.clog - p.clog) < 0.5)?.id ?? ''}
                  onChange={(e) => {
                    const pr = STORM_SIM_PRESETS.find((x) => x.id === e.target.value);
                    if (!pr) return;
                    p.onRain(pr.rain);
                    p.onClog(pr.clog);
                  }}
                  className="sh-input mt-1 w-full rounded-md px-2 py-1.5"
                >
                  <option value="" disabled>
                    Custom ({p.rain.toFixed(0)} mm/hr · {p.clog.toFixed(0)} %)
                  </option>
                  {STORM_SIM_PRESETS.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.label} · {pr.rain} mm/hr · {pr.clog} %
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </Card>

        <Card title="Layer">
          <div className="space-y-0.5">
            {LAYER_ROWS.map((r) => (
              <label key={r.key} className="flex cursor-pointer items-center justify-between rounded px-1 py-1 text-[12px] hover:bg-[var(--sh-hover)]">
                <span className="sh-ink">{r.label}</span>
                <input type="checkbox" checked={p.layers[r.key]} onChange={() => p.onToggleLayer(r.key)} className="sh-range h-3.5 w-3.5" aria-label={r.label} />
              </label>
            ))}
          </div>
          <div className="mt-2">
            <div className="sh-label mb-1">Massing</div>
            <div className="sh-seg !rounded-md" role="radiogroup" aria-label="Building massing">
              {(
                [
                  ['solid', 'Solid'],
                  ['wire', 'Wire'],
                  ['fresnel', 'Glass'],
                ] as const
              ).map(([m, label]) => (
                <button key={m} role="radio" aria-checked={p.surface === m} onClick={() => p.onSurface(m)} className="flex-1 !rounded-[5px]">
                  {label}
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </aside>
  );
}

export const LeftSidebar = memo(LeftSidebarImpl);
