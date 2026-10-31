// Phase 9A "Baguio Flood Intelligence" workspace shell: one pure reducer for the layout the
// header, the two side panels, the dock tiles and the mobile bottom sheet share. The header
// SOLID / X-RAY pill and the dock X-RAY tile dispatch the same actions, so they can never
// disagree.
import type { ShadingMode } from '../three/materials/buildingMaterials';
import type { HudMode } from '../utils/urlState';
import type { WeatherNow } from '../live/weather';
import type { LiveTarget } from '../live/liveDriver';
import type { LiveSnapshot } from '../live/telemetry';

/** Surface rendering: matte massing (default), Fresnel glass X-ray, or holo wireframe. */
export type SurfaceMode = 'solid' | 'fresnel' | 'wire';
export type Dimension = '2d' | '3d';
/** Panel tiles of the right dock (the X-RAY and CCTV tiles are actions, not panels). */
export type DockPanel = 'network' | 'capacity' | 'section' | 'report';
export type DockTile = DockPanel | 'xray' | 'cctv';
export type SheetTab = 'nodes' | 'section' | 'forecast';
export type SectionView = 'profile' | 'cutaway';

export const MOBILE_MAX_PX = 768;
export const HEADER_PX = 48;
export const LEFT_PX = 280;
export const RIGHT_PX = 320;
export const PITCH_3D = 60;

export interface ShellState {
  surface: SurfaceMode;
  dimension: Dimension;
  leftOpen: boolean;
  rightOpen: boolean;
  mobile: boolean;
  panel: DockPanel;
  sheetTab: SheetTab;
  sheetOpen: boolean;
  sectionView: SectionView;
  /** Panels were closed by the phone breakpoint (reopened when the window widens again). */
  autoCollapsed: boolean;
}

export type ShellAction =
  | { type: 'surface'; mode: SurfaceMode }
  | { type: 'toggleXray' }
  | { type: 'dimension'; dimension: Dimension }
  | { type: 'left'; open?: boolean }
  | { type: 'right'; open?: boolean }
  | { type: 'viewport'; width: number }
  | { type: 'tile'; tile: DockTile }
  | { type: 'sheet'; tab?: SheetTab; open?: boolean }
  | { type: 'sectionView'; view: SectionView };

export function surfaceOf(shader: ShadingMode): SurfaceMode {
  return shader === 'glass' ? 'fresnel' : shader;
}

export function shaderOf(surface: SurfaceMode): ShadingMode {
  return surface === 'fresnel' ? 'glass' : surface;
}

export function isMobileWidth(width: number): boolean {
  return width < MOBILE_MAX_PX;
}

export function initialShell(width: number, shader: ShadingMode = 'solid'): ShellState {
  const mobile = isMobileWidth(width);
  return {
    surface: surfaceOf(shader),
    dimension: '3d',
    leftOpen: !mobile,
    rightOpen: !mobile,
    mobile,
    panel: 'section',
    sheetTab: 'nodes',
    sheetOpen: false,
    sectionView: 'profile',
    autoCollapsed: mobile,
  };
}

export function shellReducer(s: ShellState, a: ShellAction): ShellState {
  switch (a.type) {
    case 'surface':
      return s.surface === a.mode ? s : { ...s, surface: a.mode };
    case 'toggleXray':
      return { ...s, surface: s.surface === 'fresnel' ? 'solid' : 'fresnel' };
    case 'dimension':
      return { ...s, dimension: a.dimension };
    case 'left':
      return { ...s, leftOpen: a.open ?? !s.leftOpen, autoCollapsed: false };
    case 'right':
      return { ...s, rightOpen: a.open ?? !s.rightOpen, autoCollapsed: false };
    case 'viewport': {
      const mobile = isMobileWidth(a.width);
      if (mobile === s.mobile) return s;
      if (mobile) return { ...s, mobile, leftOpen: false, rightOpen: false, autoCollapsed: true };
      return s.autoCollapsed ? { ...s, mobile, leftOpen: true, rightOpen: true, autoCollapsed: false, sheetOpen: false } : { ...s, mobile, sheetOpen: false };
    }
    case 'tile':
      if (a.tile === 'xray') return { ...s, surface: s.surface === 'fresnel' ? 'solid' : 'fresnel' };
      if (a.tile === 'cctv') return s; // the App opens the CCTV monitor
      return { ...s, panel: a.tile, rightOpen: true };
    case 'sheet':
      return { ...s, sheetTab: a.tab ?? s.sheetTab, sheetOpen: a.open ?? (a.tab ? true : !s.sheetOpen) };
    case 'sectionView':
      return { ...s, sectionView: a.view };
  }
}

export const DOCK_TILES: { id: DockTile; label: string }[] = [
  { id: 'network', label: 'Network' },
  { id: 'xray', label: 'X-Ray' },
  { id: 'capacity', label: 'Capacity' },
  { id: 'cctv', label: 'CCTV VMS' },
  { id: 'section', label: 'Section' },
  { id: 'report', label: 'LGU Report' },
];

/** Whether a dock tile renders as active. */
export function tileActive(s: ShellState, tile: DockTile): boolean {
  if (tile === 'xray') return s.surface === 'fresnel';
  if (tile === 'cctv') return false;
  return s.panel === tile;
}

/** Degrees-minutes-seconds label, e.g. 16°24'33"N 120°35'11"E. */
export function dms(lat: number, lon: number): string {
  const f = (v: number, pos: string, neg: string) => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.floor((a - d) * 60);
    let sec = Math.round(((a - d) * 60 - m) * 60);
    if (sec === 60) {
      sec = 0;
      m += 1;
    }
    if (m === 60) {
      m = 0;
      d += 1;
    }
    return `${d}°${String(m).padStart(2, '0')}'${String(sec).padStart(2, '0')}"${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

/** Stress-test presets of the Storm Sim card: (rainfall mm/hr, rack occlusion %). */
export const STORM_SIM_PRESETS = [
  { id: 'normal', label: 'Normal', rain: 5, clog: 0 },
  { id: 'typhoon', label: 'Typhoon Surge', rain: 200, clog: 30 },
  { id: 'clog', label: 'Trash Clog', rain: 25, clog: 78 },
  { id: 'choke', label: 'Rock Choke Backwater', rain: 25, clog: 0 },
] as const;

/** Status line for the live weather readout: what is driving the twin right now. */
export function weatherStatus(mode: HudMode, weather: WeatherNow, target: LiveTarget): string {
  if (mode === 'SIM') return 'Simulation mode · live weather paused';
  if (target.source !== 'WEATHER') return target.label;
  if (weather.source === 'OPEN_METEO') return 'Live Weather Synced • Click "Simulation Mode" to stress-test';
  return weather.source === 'CACHED' ? 'Offline · last synced reading' : 'Offline · baseline weather';
}

/** Header LIVE TELEMETRY badge: names only the sources actually connected. */
export function liveBadge(weather: WeatherNow, live: LiveSnapshot | null): { color: string; source: string; title: string } {
  const met = weather.source === 'OPEN_METEO';
  const backend = live?.source === 'BACKEND_WS';
  const source = [met ? 'Open-Meteo' : weather.source === 'CACHED' ? 'Open-Meteo (cached)' : 'Weather offline', backend ? 'Edge backend' : 'Backend offline'].join(' · ');
  return {
    color: met && backend ? '#10b981' : met || backend ? '#f59e0b' : '#94a3b8',
    source,
    title: `Rainfall ${met ? 'from Open-Meteo (zero-key)' : 'feed unavailable'}; edge telemetry ${backend ? 'streaming from the FastAPI backend' : 'not connected'}.`,
  };
}

/** Live-pitch scenarios pushed to the edge fleet in Live mode (driver PITCH). */
export const LIVE_PITCH_PRESETS = [
  { id: 'choke', label: 'Light Rain / Choke Test', rain: 25, clog: 0 },
  { id: 'monsoon', label: 'Monsoon Surge', rain: 100, clog: 50 },
  { id: 'typhoon', label: 'Ondoy/Typhoon Worst-Case', rain: 200, clog: 85 },
] as const;
