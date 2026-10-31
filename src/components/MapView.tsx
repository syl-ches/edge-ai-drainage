import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
// MapLibre 6 runs its tile worker from a standalone ES module; ship it as a hashed asset.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { TwinData } from '../data/loadTwin';
import { BASEMAP_SOURCE_ID, buildBasemapStyle } from '../map/basemap';
import { TwinEngine, type PickHit } from '../three/TwinEngine';
import type { CameraState } from '../utils/urlState';
import type { Theme } from '../three/theme';

setWorkerUrl(maplibreWorkerUrl);

export const DPR_CLAMP = 1.75;

export interface PointerHit extends PickHit {
  x: number;
  y: number;
}

interface Props {
  data: TwinData;
  onReady(engine: TwinEngine): void;
  onHover(hit: PointerHit | null): void;
  onClick(hit: PointerHit | null): void;
  onBasemapOffline(): void;
  onCamera(c: CameraState): void;
  /** Deep-linked camera: the map opens on the overview and flies here once loaded. */
  initialCamera: CameraState | null;
  initialTheme: Theme;
}

export function MapView({ data, onReady, onHover, onClick, onBasemapOffline, onCamera, initialCamera, initialTheme }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onReady, onHover, onClick, onBasemapOffline, onCamera });
  handlers.current = { onReady, onHover, onClick, onBasemapOffline, onCamera };
  const initial = useRef(initialCamera);
  const initialThemeRef = useRef(initialTheme);

  useEffect(() => {
    const engine = new TwinEngine(data);
    const { lon, lat } = data.network.meta.anchor;
    const map = new MapLibreMap({
      container: container.current!,
      style: buildBasemapStyle(engine.frame, initialThemeRef.current),
      center: [lon, lat],
      zoom: 15.8,
      pitch: 62,
      bearing: -25,
      maxPitch: 85,
      pixelRatio: Math.min(window.devicePixelRatio, DPR_CLAMP),
      canvasContextAttributes: { antialias: true },
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

    let offlineReported = false;
    map.on('error', (e) => {
      const sourceId = (e as unknown as { sourceId?: string }).sourceId;
      if (sourceId === BASEMAP_SOURCE_ID) {
        if (!offlineReported) handlers.current.onBasemapOffline();
        offlineReported = true;
        return; // tile failures are expected offline; the grid + 3D scene keep working
      }
      console.error(e.error);
    });

    // Debug handle for console / automated verification.
    (window as unknown as { __cityCampTwin?: unknown }).__cityCampTwin = { map, engine };

    map.on('load', () => {
      map.addLayer(engine);
      handlers.current.onReady(engine);
      const cam = initial.current;
      map.fire('moveend'); // publish the starting camera to the URL immediately
      if (cam) {
        map.flyTo({ center: [cam.lng, cam.lat], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, duration: 1800, essential: true });
      }
    });
    map.on('moveend', () => {
      const c = map.getCenter();
      handlers.current.onCamera({ lat: c.lat, lng: c.lng, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
    });

    let pending: { x: number; y: number } | null = null;
    let raf = 0;
    map.on('mousemove', (e) => {
      pending = { x: e.point.x, y: e.point.y };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!pending) return;
        const hit = engine.pick(pending.x, pending.y);
        engine.setHover(hit);
        map.getCanvas().style.cursor = hit ? 'pointer' : '';
        handlers.current.onHover(hit ? { ...hit, ...pending } : null);
      });
    });
    map.on('mouseout', () => {
      engine.setHover(null);
      handlers.current.onHover(null);
    });
    map.on('click', (e) => {
      const hit = engine.pick(e.point.x, e.point.y);
      engine.setSelected(hit);
      handlers.current.onClick(hit ? { ...hit, x: e.point.x, y: e.point.y } : null);
    });

    // The workspace side panels collapse / expand: keep the canvas matched to its container.
    const ro = new ResizeObserver(() => map.resize());
    if (container.current) ro.observe(container.current);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      map.remove();
    };
  }, [data]);

  // maplibre-gl.css sets `.maplibregl-map { position: relative }` (unlayered, beats Tailwind
  // utilities), so the map element fills an absolutely positioned wrapper instead.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  );
}
