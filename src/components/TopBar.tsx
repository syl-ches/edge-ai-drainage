import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Boxes, Building2, Clapperboard, Cpu, Cloud, FileText, CloudRain, CloudSun, Gauge, Layers3, Moon, Radio, SlidersHorizontal, Sun, TreePine, Waves } from 'lucide-react';
import type { Theme } from '../three/theme';
import type { HudMode, LayerFlags } from '../utils/urlState';
import type { WeatherNow } from '../live/weather';
import type { LiveTarget } from '../live/liveDriver';

interface Props {
  mode: HudMode;
  onMode(m: HudMode): void;
  weather: WeatherNow;
  liveTarget: LiveTarget;
  theme: Theme;
  onTheme(t: Theme): void;
  layers: LayerFlags;
  onToggleLayer(key: keyof LayerFlags): void;
  simOpen: boolean;
  onSimulator(): void;
  inspectorOpen: boolean;
  onInspector(): void;
  onHardwareSim(): void;
  onReport(): void;
  onStudio(): void;
}

/** Short label below 2xl (1536 px), the full label above. */
function Label({ short, full }: { short: string; full: string }) {
  return (
    <>
      <span className="whitespace-nowrap 2xl:hidden">{short}</span>
      <span className="hidden whitespace-nowrap 2xl:inline">{full}</span>
    </>
  );
}

const LAYER_DEFS: { key: keyof LayerFlags; label: string; short: string; icon: ReactNode }[] = [
  { key: 'buildings', label: 'Surface Buildings', short: 'Buildings', icon: <Building2 size={13} /> },
  { key: 'vegetation', label: '3D Vegetation & Parks', short: 'Vegetation', icon: <TreePine size={13} /> },
  { key: 'network', label: 'Subsurface Drainage Network', short: 'Drainage', icon: <Waves size={13} /> },
  { key: 'badges', label: 'Node Fullness Badges', short: 'Sensors', icon: <Gauge size={13} /> },
];

const pill = 'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px]';

/** Status line of the weather pill: what is driving the twin right now. */
export function weatherStatus(mode: HudMode, weather: WeatherNow, target: LiveTarget): string {
  if (mode === 'SIM') return 'Simulation mode · live weather paused';
  if (target.source !== 'WEATHER') return target.label;
  if (weather.source === 'OPEN_METEO') return 'Live Weather Synced • Click "Simulation Mode" to stress-test';
  return weather.source === 'CACHED' ? 'Offline · last synced reading' : 'Offline · baseline weather';
}

function WeatherPill({ mode, weather, target }: { mode: HudMode; weather: WeatherNow; target: LiveTarget }) {
  const Icon = weather.rainMmHr > 0.05 ? CloudRain : weather.code !== null && weather.code >= 2 ? Cloud : weather.code === null ? CloudSun : Sun;
  const synced = weather.source === 'OPEN_METEO';
  const status = weatherStatus(mode, weather, target);
  return (
    <div
      className="btn-idle flex shrink-0 items-center gap-2 rounded-xl px-2.5 py-1"
      title={`Baguio City live weather (Open-Meteo, 16.4093° N, 120.5863° E)${weather.observedAt ? ` · observed ${weather.observedAt}` : ''}\n${status}`}
      aria-label="Baguio City Live Weather"
    >
      <Icon size={16} className="shrink-0" />
      <div className="min-w-0 leading-tight">
        <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-bold">
          <span className="hidden xl:inline">Baguio City Live Weather</span>
          <span className="xl:hidden">Baguio</span>
          <span className="font-mono">{weather.rainMmHr.toFixed(1)} mm/hr</span>
          <span className="font-mono">{weather.temperatureC !== null ? `${weather.temperatureC.toFixed(0)}°C` : '—°C'}</span>
          <span>{weather.label}</span>
        </div>
        <div className="flex items-center gap-1 whitespace-nowrap text-[10px] font-medium opacity-80">
          <span className={`h-1.5 w-1.5 rounded-full ${synced && mode === 'LIVE' ? 'animate-pulse bg-[#10b981]' : 'bg-[#f59e0b]'}`} />
          <span className="max-w-[300px] truncate">{status}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Mode switcher (Live Weather / Simulation), live Baguio weather, theme, layer toggles and the
 * two tool launchers. Publishes its height as --topbar-h so panels below it can clear it.
 */
function TopBarImpl(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty('--topbar-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className="pointer-events-auto absolute inset-x-2 top-2 z-30 sm:left-[404px] sm:right-3 sm:top-3">
      <div className="hud-card flex items-center gap-1.5 overflow-x-auto rounded-2xl p-1.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-x-visible">
        <div className="flex shrink-0 gap-1" role="radiogroup" aria-label="Twin mode">
          <button
            role="radio"
            aria-checked={p.mode === 'LIVE'}
            onClick={() => p.onMode('LIVE')}
            className={`${pill} ${p.mode === 'LIVE' ? 'btn-accent' : 'btn-idle'}`}
            title="Live Weather & Telemetry Mode"
          >
            {p.mode === 'LIVE' ? <span className="h-2 w-2 animate-pulse rounded-full bg-[#fecaca]" /> : <Radio size={13} />}
            <Label short="Live Weather" full="Live Weather & Telemetry" />
          </button>
          <button
            role="radio"
            aria-checked={p.mode === 'SIM'}
            onClick={() => p.onMode('SIM')}
            className={`${pill} ${p.mode === 'SIM' ? 'btn-active' : 'btn-idle'}`}
            title="Scenario Simulation Mode (manual rainfall & blockage sliders)"
          >
            <SlidersHorizontal size={13} />
            <Label short="Simulation Mode" full="Scenario Simulation Mode" />
          </button>
        </div>
        <WeatherPill mode={p.mode} weather={p.weather} target={p.liveTarget} />
        <span className="mx-0.5 h-6 w-px shrink-0 bg-[#94a3b8]/50" />
        <div className="flex shrink-0 gap-1" role="radiogroup" aria-label="Theme">
          {(
            [
              ['daylight', 'Daylight Diorama', <Sun key="s" size={13} />],
              ['xray', 'Dark X-Ray', <Moon key="m" size={13} />],
            ] as const
          ).map(([t, label, icon]) => (
            <button
              key={t}
              role="radio"
              aria-checked={p.theme === t}
              aria-label={label}
              onClick={() => p.onTheme(t)}
              title={label}
              className={`flex shrink-0 items-center rounded-full p-2 ${p.theme === t ? 'btn-active' : 'btn-idle'}`}
            >
              {icon}
              <span className="sr-only">{label}</span>
            </button>
          ))}
        </div>
        {LAYER_DEFS.map((d) => {
          const on = p.layers[d.key];
          return (
            <button
              key={d.key}
              onClick={() => p.onToggleLayer(d.key)}
              title={`${d.label}: ${on ? 'on (click to hide)' : 'off (click to show)'}`}
              aria-pressed={on}
              className={`${pill} ${on ? 'btn-active' : 'btn-idle'}`}
            >
              {d.icon}
              <Label short={d.short} full={d.label} />
            </button>
          );
        })}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-[#94a3b8]/50" />
        <button onClick={p.onSimulator} title="Cross-Section Simulator" className={`${pill} ${p.simOpen ? 'btn-active' : 'btn-accent'}`}>
          <Layers3 size={13} />
          <Label short="Simulator" full="Cross-Section Simulator" />
        </button>
        <button onClick={p.onInspector} title="Subsurface Utility Inspector" className={`${pill} ${p.inspectorOpen ? 'btn-active' : 'btn-sky'}`}>
          <Boxes size={13} />
          <Label short="Inspector" full="Utility Inspector" />
        </button>
        <button
          onClick={p.onHardwareSim}
          title="Open the Arduino / ESP32 & aquarium drainage simulator in a new tab (syncs live with this map)"
          className={`${pill} btn-amber`}
        >
          <Cpu size={13} />
          <span className="whitespace-nowrap">Arduino &amp; Aquarium Sim ↗</span>
        </button>
        <button onClick={p.onStudio} title="Ultra-HD 3D subsurface cutaway and aquarium bench for the initial pitch" className={`${pill} btn-accent`}>
          <Clapperboard size={13} />
          <span className="whitespace-nowrap">Ultra-HD Pitch Studio</span>
        </button>
        <button onClick={p.onReport} title="Data analytics and the official LGU PDF report" className={`${pill} btn-active`}>
          <FileText size={13} />
          <span className="whitespace-nowrap">Analytics &amp; PDF Report</span>
        </button>
      </div>
    </div>
  );
}

export const TopBar = memo(TopBarImpl);
