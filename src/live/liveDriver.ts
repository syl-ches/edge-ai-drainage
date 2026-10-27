// What drives the twin in LIVE WEATHER & TELEMETRY MODE (the default, Phase 7A / 7B).
// Priority: a physical full-catchment hardware uplink (backend HARDWARE mode) > the user's choice:
//   WEATHER (live Baguio rainfall: the backend LIVE_FEED when connected, else Open-Meteo in the
//            browser; rack assumed clean),
//   PITCH   (a pinned demo scenario pushed to the backend fleet as precip source TWIN), or
//   REPLAY  (a historical storm from public/data/precip_library.json: backend HISTORICAL, or the
//            local replay when offline; DESIGN_TYPHOON_12H is the original 12 h typhoon).
import type { TwinFrame } from '../types/live';
import type { LiveSnapshot } from './telemetry';
import type { WeatherNow } from './weather';

export const DESIGN_STORM_ID = 'DESIGN_TYPHOON_12H';

export type LiveDriver =
  | { kind: 'WEATHER' }
  | { kind: 'PITCH'; id: string; label: string; rain: number; clog: number }
  | { kind: 'REPLAY'; stormId: string; label: string };

export type LiveTargetSource = 'HARDWARE' | 'WEATHER' | 'PITCH' | 'REPLAY';

export interface LiveTarget {
  rain: number;
  clog: number;
  source: LiveTargetSource;
  label: string;
}

/** Live weather carries no blockage information: the rack is assumed clean until EN-09 says otherwise. */
export const WEATHER_BASE_CLOG = 0;

/** Whether a backend frame already describes the driver the user picked. */
export function frameMatchesDriver(driver: LiveDriver, frame: Pick<TwinFrame, 'mode' | 'precip_source' | 'storm_id'>): boolean {
  if (frame.mode === 'HARDWARE') return true;
  if (driver.kind === 'WEATHER') return frame.precip_source === 'LIVE_FEED';
  if (driver.kind === 'PITCH') return frame.precip_source === 'TWIN';
  return frame.precip_source === 'HISTORICAL' && frame.storm_id === driver.stormId;
}

export function resolveLiveTarget(driver: LiveDriver, weather: WeatherNow, snap: LiveSnapshot | null): LiveTarget {
  const f = snap?.frame;
  if (f && f.mode === 'HARDWARE') {
    return {
      rain: f.scenario.rainfall_mm_hr,
      clog: f.scenario.trash_rack_blockage_pct,
      source: 'HARDWARE',
      label: `Hardware override${f.hardware_override ? ` · ${f.hardware_override.sensor_id}` : ''}`,
    };
  }
  if (driver.kind === 'PITCH') return { rain: driver.rain, clog: driver.clog, source: 'PITCH', label: `Pitch: ${driver.label}` };
  if (driver.kind === 'REPLAY') {
    const live = snap && snap.source !== 'OFFLINE';
    return { rain: live ? snap.rain : 0, clog: live ? snap.clog : 0, source: 'REPLAY', label: `Replay: ${driver.label}` };
  }
  // WEATHER: the backend's own feed once it serves LIVE_FEED frames, else the browser's reading.
  const backendRain = f && frameMatchesDriver(driver, f) ? f.scenario.rainfall_mm_hr : null;
  return {
    rain: backendRain ?? weather.rainMmHr,
    clog: WEATHER_BASE_CLOG,
    source: 'WEATHER',
    label: `Live weather · ${weather.label}`,
  };
}

/** `/ws/live` control message that makes the backend fleet + forecaster follow the same driver. */
export function backendCommand(driver: LiveDriver) {
  if (driver.kind === 'REPLAY') return { type: 'control', precip_source: 'HISTORICAL', storm_id: driver.stormId } as const;
  if (driver.kind === 'PITCH')
    return { type: 'control', precip_source: 'TWIN', rainfall_mm_hr: driver.rain, trash_rack_blockage_pct: driver.clog } as const;
  return { type: 'control', precip_source: 'LIVE_FEED', trash_rack_blockage_pct: WEATHER_BASE_CLOG } as const;
}
