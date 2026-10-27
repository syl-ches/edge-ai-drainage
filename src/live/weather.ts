// Live Baguio City weather (Phase 7A) from the free, zero-key Open-Meteo forecast API.
// `current` values come from 15-minutely model data: `precipitation` is the total over the
// preceding `current.interval` seconds, so the rate is precipitation * 3600 / interval.
// Offline / blocked: the last good reading cached in localStorage, else a dry baseline.

export const BAGUIO = { lat: 16.4093, lon: 120.5863 } as const;
export const OPEN_METEO_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${BAGUIO.lat}&longitude=${BAGUIO.lon}` +
  '&current=temperature_2m,precipitation,rain,showers,weather_code,wind_speed_10m' +
  '&minutely_15=precipitation&hourly=precipitation&forecast_minutely_15=8&forecast_hours=3&timezone=Asia%2FManila';
export const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const CACHE_KEY = 'citycamp.weather.v1';

export type WeatherSource = 'OPEN_METEO' | 'CACHED' | 'BASELINE';

export interface WeatherNow {
  rainMmHr: number;
  temperatureC: number | null;
  windKmh: number | null;
  code: number | null;
  label: string;
  /** Open-Meteo observation time (local, ISO) or null */
  observedAt: string | null;
  source: WeatherSource;
  /** basin rate for minutes 0..60 (Open-Meteo nowcast), null when unknown */
  trajectoryMmHr?: number[] | null;
}

export const BASELINE_WEATHER: WeatherNow = {
  rainMmHr: 0,
  temperatureC: null,
  windKmh: null,
  code: null,
  label: 'Baseline (offline)',
  observedAt: null,
  source: 'BASELINE',
};

const WMO: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly Clear',
  2: 'Partly Cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime Fog',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Dense Drizzle',
  56: 'Freezing Drizzle',
  57: 'Freezing Drizzle',
  61: 'Light Rain',
  63: 'Moderate Rain',
  65: 'Heavy Rain',
  66: 'Freezing Rain',
  67: 'Freezing Rain',
  71: 'Light Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  77: 'Snow Grains',
  80: 'Light Shower',
  81: 'Moderate Shower',
  82: 'Heavy Monsoon Shower',
  85: 'Snow Shower',
  86: 'Snow Shower',
  95: 'Thunderstorm',
  96: 'Thunderstorm + Hail',
  99: 'Thunderstorm + Hail',
};

/** Human condition label from the WMO code, corrected by the measured rate. */
export function weatherLabel(code: number | null, rainMmHr: number): string {
  const base = code !== null ? (WMO[code] ?? `WMO ${code}`) : rainMmHr > 0 ? 'Rain' : 'Clear';
  if (rainMmHr >= 30 && (code === null || code < 95)) return 'Heavy Monsoon Shower';
  if (rainMmHr > 0.05 && (code === null || code <= 3)) return 'Light Rain';
  return base;
}

/** Precipitation rate (mm/hr) from an Open-Meteo `current` block, clamped to the LUT axis. */
export function precipRateMmHr(current: { precipitation?: number; rain?: number; showers?: number; interval?: number }): number {
  const interval = current.interval && current.interval > 0 ? current.interval : 900;
  const total = Math.max(current.precipitation ?? 0, (current.rain ?? 0) + (current.showers ?? 0), 0);
  return Math.min((total * 3600) / interval, 250);
}

interface OpenMeteoResponse {
  minutely_15?: { time?: string[]; precipitation?: (number | null)[] };
  hourly?: { time?: string[]; precipitation?: (number | null)[] };
  current?: {
    time?: string;
    interval?: number;
    temperature_2m?: number;
    precipitation?: number;
    rain?: number;
    showers?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
}

export function parseOpenMeteo(json: unknown): WeatherNow {
  const c = (json as OpenMeteoResponse | null)?.current;
  if (!c || typeof c.temperature_2m !== 'number') throw new Error('Open-Meteo: no current block');
  const rainMmHr = Math.round(precipRateMmHr(c) * 10) / 10;
  const code = typeof c.weather_code === 'number' ? c.weather_code : null;
  return {
    rainMmHr,
    temperatureC: c.temperature_2m,
    windKmh: typeof c.wind_speed_10m === 'number' ? c.wind_speed_10m : null,
    code,
    label: weatherLabel(code, rainMmHr),
    observedAt: c.time ?? null,
    source: 'OPEN_METEO',
    trajectoryMmHr: c.time ? parseOpenMeteoTrajectory(json as OpenMeteoResponse) : null,
  };
}

const localMs = (ts: string) => Date.parse(`${ts.replace('Z', '')}Z`); // naive Asia/Manila stamps, compared as-is
const MIN_MS = 60_000;

/**
 * 0..60 min rate trajectory (backend/weather_feed.py::parse_open_meteo): minute 0 is the current
 * rate; `minutely_15[i]` totals the 15 min ending at time[i] (x4 -> mm/hr); beyond it the hourly
 * total is mm/hr; gaps persist the last value.
 */
export function parseOpenMeteoTrajectory(json: OpenMeteoResponse): number[] {
  const c = json.current!;
  const now = localMs(c.time!);
  const q = (json.minutely_15?.time ?? []).map((t, i) => [localMs(t), (json.minutely_15?.precipitation?.[i] ?? 0) * 4] as const);
  const h = (json.hourly?.time ?? []).map((t, i) => [localMs(t), json.hourly?.precipitation?.[i] ?? 0] as const);
  const out = [Math.round(precipRateMmHr(c) * 1000) / 1000];
  let last = precipRateMmHr(c);
  for (let t = 1; t <= 60; t++) {
    const at = now + t * MIN_MS;
    let rate = q.find(([end]) => end >= at && end - 15 * MIN_MS < at)?.[1];
    if (rate === undefined) rate = h.find(([end]) => end >= at && end - 60 * MIN_MS < at)?.[1];
    if (rate !== undefined) last = Math.min(Math.max(rate, 0), 250);
    out.push(Math.round(last * 1000) / 1000);
  }
  return out;
}

export async function fetchBaguioWeather(signal?: AbortSignal): Promise<WeatherNow> {
  const res = await fetch(OPEN_METEO_URL, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return parseOpenMeteo(await res.json());
}

export function readCachedWeather(): WeatherNow | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const w = JSON.parse(raw) as WeatherNow;
    return typeof w.rainMmHr === 'number' ? { ...w, source: 'CACHED' } : null;
  } catch {
    return null;
  }
}

function writeCachedWeather(w: WeatherNow): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(w));
  } catch {
    /* storage blocked: the live value still drives this session */
  }
}

/**
 * Emits the cached (or baseline) weather immediately, then live readings every 10 min.
 * Failed fetches keep the last value and retry after 60 s.
 */
export function startWeather(onWeather: (w: WeatherNow) => void): () => void {
  let stopped = false;
  let timer: number | undefined;
  let ctrl: AbortController | null = null;
  let haveLive = false;
  onWeather(readCachedWeather() ?? BASELINE_WEATHER);

  const tick = async () => {
    ctrl = new AbortController();
    const abort = window.setTimeout(() => ctrl?.abort(), 8000);
    try {
      const w = await fetchBaguioWeather(ctrl.signal);
      if (stopped) return;
      haveLive = true;
      writeCachedWeather(w);
      onWeather(w);
      timer = window.setTimeout(tick, WEATHER_REFRESH_MS);
    } catch {
      if (stopped) return;
      if (!haveLive) onWeather(readCachedWeather() ?? BASELINE_WEATHER);
      timer = window.setTimeout(tick, RETRY_MS);
    } finally {
      window.clearTimeout(abort);
    }
  };
  void tick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    ctrl?.abort();
  };
}
