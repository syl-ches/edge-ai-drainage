// LIVE WEATHER & TELEMETRY MODE link to the Phase 4 backend.
//  1. BACKEND_WS: FastAPI `WS /ws/live` streaming TwinFrame JSON; `send()` pushes scenario
//     commands back over the same socket ({"type":"scenario", ...}).
//  2. LOCAL_PLAYBACK: offline replay of the storm `replay()` returns (DESIGN_TYPHOON_12H uses the
//     exact backend/intelligence.py::storm_profile; library storms their hyetograph), 6 storm-min
//     per wall-s like the backend.
//  3. OFFLINE: no backend and no replay requested (live weather drives the twin alone).
// The socket keeps retrying every 5 s.

import type { TwinFrame } from '../types/live';
import { hyetographRate, type StormDef } from '../forecast/stgnn';

export const STORM_PERIOD_S = 120;
export const STORM_MIN_PER_WALL_S = 6;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Typhoon build-up / peak / recession over one period (t in [0, 1)). */
export function stormProfile(t: number): { rain: number; clog: number } {
  const rain = 2 + 238 * Math.exp(-(((t - 0.42) / 0.17) ** 2));
  // Debris load builds on the rising limb; a clearing crew pulls part of it off late in the event.
  const clog = 6 + 82 * smooth(0.2, 0.62, t) - 30 * smooth(0.78, 0.98, t);
  return { rain: Math.min(rain, 250), clog: Math.min(Math.max(clog, 0), 95) };
}

export type LiveSourceKind = 'LOCAL_PLAYBACK' | 'BACKEND_WS' | 'OFFLINE';

export interface LiveSnapshot {
  source: LiveSourceKind;
  rain: number;
  clog: number;
  clockS: number;
  periodS: number;
  frame: TwinFrame | null;
  wsUrl: string;
}

export function backendBase(apiOverride: string | null): string {
  if (apiOverride) return apiOverride.replace(/\/$/, '');
  const { protocol, hostname } = window.location;
  return `${protocol === 'https:' ? 'https' : 'http'}://${hostname || 'localhost'}:8000`;
}

export interface LiveLink {
  stop(): void;
  /** Send a JSON command over the socket; false when the backend is not connected. */
  send(msg: object): boolean;
}

/** Rain / blockage of a replayed storm at `clockS` wall seconds into the loop. */
export function replayAt(storm: StormDef, clockS: number, clog = 0): { rain: number; clog: number; periodS: number } {
  const periodS = storm.duration_min / STORM_MIN_PER_WALL_S;
  if (storm.id === 'DESIGN_TYPHOON_12H') return { ...stormProfile((clockS % periodS) / periodS), periodS };
  return { rain: hyetographRate(storm, clockS * STORM_MIN_PER_WALL_S), clog, periodS };
}

export function startLive(apiOverride: string | null, onSnapshot: (s: LiveSnapshot) => void, replay: () => StormDef | null): LiveLink {
  const base = backendBase(apiOverride);
  const wsUrl = `${base.replace(/^http/, 'ws')}/ws/live`;
  let ws: WebSocket | null = null;
  let wsLive = false;
  let stopped = false;
  let raf = 0;
  let retry: number | undefined;
  let lastEmit = 0;
  let replayT0: number | null = null;
  let replayId: string | null = null;

  const local = (now: number) => {
    raf = requestAnimationFrame(local);
    if (wsLive) return;
    const storm = replay();
    if (!storm) {
      replayT0 = null;
      if (now - lastEmit < 1000) return; // offline heartbeat
      lastEmit = now;
      onSnapshot({ source: 'OFFLINE', rain: 0, clog: 0, clockS: 0, periodS: STORM_PERIOD_S, frame: null, wsUrl });
      return;
    }
    if (now - lastEmit < 33) return; // ~30 Hz is plenty for HUD + 3D state
    lastEmit = now;
    if (replayId !== storm.id) {
      replayId = storm.id;
      replayT0 = now;
    }
    replayT0 ??= now;
    const periodS = storm.duration_min / STORM_MIN_PER_WALL_S;
    const clockS = ((now - replayT0) / 1000) % periodS;
    const { rain, clog } = replayAt(storm, clockS);
    onSnapshot({ source: 'LOCAL_PLAYBACK', rain, clog, clockS, periodS, frame: null, wsUrl });
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      retry = window.setTimeout(connect, 5000);
      return;
    }
    ws.onopen = () => {
      wsLive = true;
    };
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data as string) as TwinFrame;
        if (frame.type !== 'twin_frame') return;
        onSnapshot({
          source: 'BACKEND_WS',
          rain: frame.scenario.rainfall_mm_hr,
          clog: frame.scenario.trash_rack_blockage_pct,
          clockS: frame.storm_clock_s,
          periodS: frame.storm_period_s,
          frame,
          wsUrl,
        });
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      wsLive = false;
      ws = null;
      if (!stopped) retry = window.setTimeout(connect, 5000);
    };
    ws.onerror = () => ws?.close();
  };

  raf = requestAnimationFrame(local);
  connect();
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(retry);
      ws?.close();
    },
    send(msg) {
      if (!ws || !wsLive || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
  };
}
