// Nearest Command Center CCTV resolver (Phase 9B) ≡ backend/cctv.py, locked by
// tests/frontend/fixtures/cctv_golden.json.
//
// The twin is middleware over the Baguio Smart City Command Center / CDRRMO VMS: it never
// installs cameras, it maps each Edge-AI node to the nearest existing feeds. The committed
// inventory (public/data/cctv_cameras.json) is a placeholder; real stream URLs are configured
// at runtime (backend CITYCAMP_CCTV_STREAMS, or a clip in public/cctv/), never committed.
import type { Sensor } from '../types/twin';

export type CctvScene = 'CCL_A' | 'CCL_B';

export interface CctvStream {
  protocol: 'hls' | 'http' | 'file' | 'webrtc';
  url: string;
}

export interface CctvCamera {
  camera_id: string;
  name: string;
  osd_label: string;
  sector: string;
  vms: string;
  lon: number;
  lat: number;
  elev_m: number;
  heading_deg: number;
  pitch_deg: number;
  fov_deg: number;
  /** Procedural replay scene for this camera, or null (no scene: needs a real stream or clip). */
  scene: CctvScene | null;
  /** Pose in the intake-compound frame (src/intake/compound.ts), for the procedural replay. */
  local_pose: { position: [number, number, number]; target: [number, number, number] } | null;
  stream: CctvStream | null;
  registry_status: 'PLACEHOLDER' | 'COMMAND_CENTER';
  source_type: string;
  is_active: boolean;
}

export interface CctvRegistry {
  meta: { schema_version: number; vms: string; coverage_radius_m: number; disclaimer: string };
  cameras: CctvCamera[];
}

export interface NearestFeed {
  camera: CctvCamera;
  distanceM: number;
  inCoverage: boolean;
}

const R_EARTH = 6371008.8;

/** Great-circle distance (m) ≡ backend/lut.py::haversine_m. */
export function haversineM(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const [lon1, lat1, lon2, lat2] = [a[0] * rad, a[1] * rad, b[0] * rad, b[1] * rad];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/** The k nearest active cameras to a sensor's surface position (distance rounded to 0.1 m, ties by id). */
export function nearestCameras(sensor: Pick<Sensor, 'coordinates'>, registry: CctvRegistry, k = 2): NearestFeed[] {
  const p: [number, number] = [sensor.coordinates[0], sensor.coordinates[1]];
  return registry.cameras
    .filter((c) => c.is_active)
    .map((c) => ({ camera: c, distanceM: Math.round(haversineM(p, [c.lon, c.lat]) * 10) / 10 }))
    .sort((x, y) => x.distanceM - y.distanceM || (x.camera.camera_id < y.camera.camera_id ? -1 : 1))
    .slice(0, k)
    .map((f) => ({ ...f, inCoverage: f.distanceM <= registry.meta.coverage_radius_m }));
}

export type FeedSource = 'VMS_STREAM' | 'LOCAL_CLIP' | 'PROCEDURAL' | 'NO_SIGNAL';

/** What a viewport can actually show for a camera. */
export function feedSource(camera: CctvCamera, localClip: string | null): FeedSource {
  if (camera.stream) return 'VMS_STREAM';
  if (localClip) return 'LOCAL_CLIP';
  return camera.scene ? 'PROCEDURAL' : 'NO_SIGNAL';
}

/**
 * Connection badge. It never claims a live VMS link that is not configured: with no stream URL the
 * feed is the procedural replay and the badge says so.
 */
export function connectionBadge(feed: NearestFeed, sensorId: string, source: FeedSource): string {
  const d = `${feed.distanceM.toFixed(0)} m from ${sensorId}`;
  switch (source) {
    case 'VMS_STREAM':
      return `Command Center VMS stream · auto-retrieved nearest feed (${d})`;
    case 'LOCAL_CLIP':
      return `Local clip loaded for ${feed.camera.camera_id} · nearest mapped feed (${d})`;
    case 'PROCEDURAL':
      return `Procedural replay · VMS stream not configured · nearest mapped feed (${d})`;
    default:
      return `No signal · VMS stream not configured for ${feed.camera.camera_id} (${d})`;
  }
}

let cache: Promise<CctvRegistry> | null = null;

/** Registry from /data/cctv_cameras.json, with backend stream overrides when the API answers. */
export function loadCctvRegistry(apiBase?: string | null): Promise<CctvRegistry> {
  cache ??= (async () => {
    const reg = (await (await fetch(`${import.meta.env.BASE_URL}data/cctv_cameras.json`)).json()) as CctvRegistry;
    if (!apiBase) return reg;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`${apiBase}/api/v1/cctv/cameras`, { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) {
        const live = (await r.json()) as { cameras: CctvCamera[] };
        const streams = new Map(live.cameras.filter((c) => c.stream).map((c) => [c.camera_id, c.stream]));
        return { ...reg, cameras: reg.cameras.map((c) => ({ ...c, stream: streams.get(c.camera_id) ?? c.stream })) };
      }
    } catch {
      // backend offline: the committed registry is enough for the procedural replay
    }
    return reg;
  })();
  return cache;
}

/** Optional local footage manifest: public/cctv/manifest.json = { "CAM-CCL-A": "cam-ccl-a.mp4", ... }. */
export async function loadLocalClips(): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}cctv/manifest.json`);
    if (!r.ok) return {};
    const m = (await r.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === 'string' && v && !k.startsWith('_')) out[k] = `${import.meta.env.BASE_URL}cctv/${v}`;
    return out;
  } catch {
    return {};
  }
}
