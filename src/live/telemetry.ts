// LIVE TELEMETRY PREVIEW MODE sources.
//  1. BACKEND_WS: FastAPI `WS /ws/live` (Phase 4) streaming TwinFrame JSON.
//  2. LOCAL_PLAYBACK: offline typhoon progression with the exact same storm profile as
//     backend/intelligence.py::storm_profile, used whenever the backend is unreachable.
// The source auto-falls back to local playback and keeps retrying the socket.

import type { TwinFrame } from '../types/live';

export const STORM_PERIOD_S = 120;

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

export type LiveSourceKind = 'LOCAL_PLAYBACK' | 'BACKEND_WS';

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

export function startLive(apiOverride: string | null, onSnapshot: (s: LiveSnapshot) => void): () => void {
  const base = backendBase(apiOverride);
  const wsUrl = `${base.replace(/^http/, 'ws')}/ws/live`;
  let ws: WebSocket | null = null;
  let wsLive = false;
  let stopped = false;
  let raf = 0;
  let retry: number | undefined;
  let lastEmit = 0;
  const t0 = performance.now();

  const local = (now: number) => {
    raf = requestAnimationFrame(local);
    if (wsLive || now - lastEmit < 33) return; // ~30 Hz is plenty for HUD + 3D state
    lastEmit = now;
    const clockS = ((now - t0) / 1000) % STORM_PERIOD_S;
    const { rain, clog } = stormProfile(clockS / STORM_PERIOD_S);
    onSnapshot({ source: 'LOCAL_PLAYBACK', rain, clog, clockS, periodS: STORM_PERIOD_S, frame: null, wsUrl });
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
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(retry);
    ws?.close();
  };
}
