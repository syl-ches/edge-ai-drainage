// Deep-link state <-> URL query (?lat=&lng=&z=&pitch=&bearing=&rain=&clog=&scale=&sel=&mode=&api=
//   &theme=day|xray&shader=solid|wire|glass&bld=&veg=&net=&badges=&sim=node|profile&simnode=EN-xx).
// `xray=0` from older links is still honoured (it means buildings off).
// Writes go through a debounced history.replaceState so slider scrubbing never touches
// the history stack or blocks a frame.

import type { ShadingMode } from '../three/materials/buildingMaterials';
import type { Theme } from '../three/theme';

export type HudMode = 'SIM' | 'LIVE';
export type SimView = 'node' | 'profile';

export interface LayerFlags {
  buildings: boolean;
  vegetation: boolean;
  network: boolean;
  badges: boolean;
}

export interface CameraState {
  lat: number;
  lng: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface UrlState {
  camera: CameraState | null;
  rain: number;
  clog: number;
  scale: number;
  theme: Theme;
  shader: ShadingMode;
  layers: LayerFlags;
  /** Cross-Section Simulator: closed (null) or which view is open */
  sim: SimView | null;
  simNode: string;
  sel: string | null; // "conduit:LGD-C07" | "node:TUN-J08" | "sensor:EN-07" | "rack:CITY_CAMP_TRASH_RACK"
  mode: HudMode;
  api: string | null; // backend base URL override, e.g. http://192.168.1.23:8000
}

export const DEFAULT_URL_STATE: UrlState = {
  camera: null,
  rain: 25,
  clog: 0,
  scale: 1,
  theme: 'daylight',
  shader: 'glass',
  layers: { buildings: true, vegetation: true, network: true, badges: true },
  sim: null,
  simNode: 'EN-08',
  sel: null,
  mode: 'LIVE', // Live Weather & Telemetry is the startup mode (Phase 7A)
  api: null,
};

const num = (v: string | null, lo: number, hi: number): number | null => {
  if (v === null || v.trim() === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : null;
};

const flag = (v: string | null, fallback: boolean) => (v === null ? fallback : v !== '0' && v !== 'false');

export function parseUrlState(search: string = window.location.search): UrlState {
  const q = new URLSearchParams(search);
  const lat = num(q.get('lat'), -85, 85);
  const lng = num(q.get('lng'), -180, 180);
  const zoom = num(q.get('z'), 0, 24);
  const camera =
    lat !== null && lng !== null && zoom !== null
      ? { lat, lng, zoom, pitch: num(q.get('pitch'), 0, 85) ?? 62, bearing: num(q.get('bearing'), -180, 360) ?? 0 }
      : null;
  const sel = q.get('sel');
  return {
    camera,
    rain: num(q.get('rain'), 0, 250) ?? DEFAULT_URL_STATE.rain,
    clog: num(q.get('clog'), 0, 95) ?? DEFAULT_URL_STATE.clog,
    scale: num(q.get('scale'), 1, 2.5) ?? DEFAULT_URL_STATE.scale,
    theme: q.get('theme') === 'xray' ? 'xray' : 'daylight',
    shader: (['solid', 'wire', 'glass'] as const).find((m) => m === q.get('shader')) ?? DEFAULT_URL_STATE.shader,
    layers: {
      buildings: flag(q.get('bld'), q.get('xray') !== '0'),
      vegetation: flag(q.get('veg'), true),
      network: flag(q.get('net'), true),
      badges: flag(q.get('badges'), true),
    },
    sim: q.get('sim') === 'node' || q.get('sim') === 'profile' ? (q.get('sim') as SimView) : null,
    simNode: /^EN-\d{2}$/.test(q.get('simnode') ?? '') ? (q.get('simnode') as string) : DEFAULT_URL_STATE.simNode,
    sel: sel && /^(conduit|node|sensor|rack):[\w.-]+$/.test(sel) ? sel : null,
    mode: q.get('mode') === 'sim' ? 'SIM' : 'LIVE',
    api: q.get('api'),
  };
}

export function serializeUrlState(s: UrlState): string {
  const q = new URLSearchParams();
  if (s.camera) {
    q.set('lat', s.camera.lat.toFixed(6));
    q.set('lng', s.camera.lng.toFixed(6));
    q.set('z', s.camera.zoom.toFixed(2));
    q.set('pitch', s.camera.pitch.toFixed(1));
    q.set('bearing', s.camera.bearing.toFixed(1));
  }
  q.set('rain', s.rain.toFixed(0));
  q.set('clog', s.clog.toFixed(0));
  q.set('scale', String(s.scale));
  q.set('theme', s.theme === 'xray' ? 'xray' : 'day');
  q.set('shader', s.shader);
  q.set('bld', s.layers.buildings ? '1' : '0');
  q.set('veg', s.layers.vegetation ? '1' : '0');
  q.set('net', s.layers.network ? '1' : '0');
  q.set('badges', s.layers.badges ? '1' : '0');
  if (s.sim) {
    q.set('sim', s.sim);
    q.set('simnode', s.simNode);
  }
  if (s.sel) q.set('sel', s.sel);
  if (s.mode === 'SIM') q.set('mode', 'sim');
  if (s.api) q.set('api', s.api);
  return q.toString();
}

let timer: number | undefined;
export function writeUrlStateDebounced(s: UrlState, delayMs = 250): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const qs = serializeUrlState(s);
    window.history.replaceState(null, '', `${window.location.pathname}?${qs}${window.location.hash}`);
  }, delayMs);
}

/** Current URL with its origin swapped for a LAN IP / deployed host, for QR sharing. */
export function shareUrl(hostOverride: string): string {
  const here = new URL(window.location.href);
  const raw = hostOverride.trim();
  if (!raw) return here.toString();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${here.protocol}//${raw}`;
  try {
    const target = new URL(withScheme);
    if (!/:\d+$/.test(raw.replace(/^https?:\/\//i, '').split('/')[0]) && here.port && !/^https?:\/\//i.test(raw)) {
      target.port = here.port; // "192.168.1.23" keeps the dev-server port
    }
    target.pathname = here.pathname;
    target.search = here.search;
    target.hash = here.hash;
    return target.toString();
  } catch {
    return here.toString();
  }
}
