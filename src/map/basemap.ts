import type { GeoJSONSourceSpecification, Map as MapLibreMap, SkySpecification, StyleSpecification } from 'maplibre-gl';
import type { LocalFrame } from '../three/frame';
import type { Theme } from '../three/theme';

export const BASEMAP_SOURCE_ID = 'openfreemap';
const GRID_EXTENT_M = 3200;
const GRID_MINOR_M = 100;
const GRID_MAJOR_M = 500;

/** Metric survey grid around the anchor; stays visible when tiles can't load (offline demo). */
function gridGeoJSON(frame: LocalFrame): GeoJSONSourceSpecification['data'] {
  const features = [];
  for (let v = -GRID_EXTENT_M; v <= GRID_EXTENT_M; v += GRID_MINOR_M) {
    const major = v % GRID_MAJOR_M === 0;
    features.push(
      { type: 'Feature' as const, properties: { major }, geometry: { type: 'LineString' as const, coordinates: [frame.toLngLat(v, -GRID_EXTENT_M), frame.toLngLat(v, GRID_EXTENT_M)] } },
      { type: 'Feature' as const, properties: { major }, geometry: { type: 'LineString' as const, coordinates: [frame.toLngLat(-GRID_EXTENT_M, v), frame.toLngLat(GRID_EXTENT_M, v)] } },
    );
  }
  return { type: 'FeatureCollection' as const, features };
}

const roadWidth = (k: number) =>
  ['interpolate', ['exponential', 1.6], ['zoom'], 13, 0.4 * k, 17, 3 * k, 20, 14 * k] as unknown as number;

type Paint = Record<string, unknown>;
const GREEN_CLASSES = ['grass', 'scrub', 'park', 'meadow', 'farmland'];

/** Per-theme paint for every basemap layer (applied with setPaintProperty on a theme toggle). */
export const BASEMAP_PAINT: Record<Theme, Record<string, Paint>> = {
  daylight: {
    canvas: { 'background-color': '#F3F4EE' },
    landcover: {
      'fill-color': ['match', ['get', 'class'], ['wood', 'forest'], '#A3D98B', GREEN_CLASSES, '#CBE8BA', '#E6E8E0'],
      'fill-opacity': 0.85,
    },
    park: { 'fill-color': '#CBE8BA', 'fill-opacity': 0.9 },
    water: { 'fill-color': '#7DD3FC' },
    waterway: { 'line-color': '#38BDF8', 'line-width': 1.2 },
    'building-footprints': { 'fill-color': '#E9ECE4', 'fill-outline-color': '#D5DAD0', 'fill-opacity': 0.9 },
    'roads-casing': { 'line-color': '#FFFFFF', 'line-opacity': 1 },
    'roads-minor': { 'line-color': '#D9DDD2' },
    'roads-major': { 'line-color': '#D2D7CA' },
    'grid-minor': { 'line-color': '#DDE2D6', 'line-opacity': 0.55 },
    'grid-major': { 'line-color': '#C9D1C2', 'line-opacity': 0.7 },
  },
  xray: {
    canvas: { 'background-color': '#090D16' },
    landcover: { 'fill-color': '#0C1A1C', 'fill-opacity': 0.6 },
    park: { 'fill-color': '#0D1F1E', 'fill-opacity': 0.7 },
    water: { 'fill-color': '#0A2236' },
    waterway: { 'line-color': '#12405E', 'line-width': 1 },
    'building-footprints': { 'fill-color': '#111827', 'fill-outline-color': '#1F2A3D', 'fill-opacity': 0.8 },
    'roads-casing': { 'line-color': '#0F172A', 'line-opacity': 0 },
    'roads-minor': { 'line-color': '#1B2638' },
    'roads-major': { 'line-color': '#26354D' },
    'grid-minor': { 'line-color': '#1E293B', 'line-opacity': 0.45 },
    'grid-major': { 'line-color': '#334155', 'line-opacity': 0.6 },
  },
};

export const SKY: Record<Theme, SkySpecification> = {
  daylight: {
    'sky-color': '#DDEFF6',
    'horizon-color': '#F3F4EE',
    'fog-color': '#F3F4EE',
    'sky-horizon-blend': 0.7,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.85,
    'atmosphere-blend': 0,
  },
  xray: {
    'sky-color': '#090D16',
    'horizon-color': '#0B1324',
    'fog-color': '#090D16',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.9,
    'atmosphere-blend': 0,
  },
};

export function applyBasemapTheme(map: MapLibreMap, theme: Theme): void {
  for (const [layer, paint] of Object.entries(BASEMAP_PAINT[theme])) {
    if (!map.getLayer(layer)) continue;
    for (const [prop, value] of Object.entries(paint)) {
      map.setPaintProperty(layer, prop as never, value as never);
    }
  }
  map.setSky(SKY[theme]);
}

/** Basemap green layers follow the "3D Vegetation & Parks" toggle with the 3D trees. */
export function setBasemapParks(map: MapLibreMap, on: boolean): void {
  for (const id of ['landcover', 'park']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}

/**
 * Zero-API-key style: OpenFreeMap (OpenMapTiles schema) vector tiles with hand-tuned,
 * label-free layers in two looks (daylight alabaster/green diorama, obsidian X-ray) plus a
 * procedural 100 m grid. No glyphs or sprites are requested, so if the tile CDN is
 * unreachable the grid, terrain and the whole 3D scene still render.
 */
export function buildBasemapStyle(frame: LocalFrame, theme: Theme = 'daylight'): StyleSpecification {
  const P = BASEMAP_PAINT[theme];
  const paint = (id: string, extra: Paint = {}) => ({ ...P[id], ...extra }) as never;
  const lineLayout = { 'line-cap': 'round', 'line-join': 'round' } as const;
  return {
    version: 8,
    sky: SKY[theme],
    sources: {
      [BASEMAP_SOURCE_ID]: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
      grid: { type: 'geojson', data: gridGeoJSON(frame) },
    },
    layers: [
      { id: 'canvas', type: 'background', paint: paint('canvas') },
      { id: 'landcover', type: 'fill', source: BASEMAP_SOURCE_ID, 'source-layer': 'landcover', paint: paint('landcover') },
      { id: 'park', type: 'fill', source: BASEMAP_SOURCE_ID, 'source-layer': 'park', paint: paint('park') },
      { id: 'water', type: 'fill', source: BASEMAP_SOURCE_ID, 'source-layer': 'water', paint: paint('water') },
      { id: 'waterway', type: 'line', source: BASEMAP_SOURCE_ID, 'source-layer': 'waterway', paint: paint('waterway') },
      {
        id: 'building-footprints',
        type: 'fill',
        source: BASEMAP_SOURCE_ID,
        'source-layer': 'building',
        minzoom: 14,
        paint: paint('building-footprints'),
      },
      {
        id: 'roads-casing',
        type: 'line',
        source: BASEMAP_SOURCE_ID,
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
        layout: lineLayout,
        paint: paint('roads-casing', { 'line-width': roadWidth(1.45) }),
      },
      {
        id: 'roads-minor',
        type: 'line',
        source: BASEMAP_SOURCE_ID,
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], ['minor', 'service', 'track', 'path'], true, false],
        layout: lineLayout,
        paint: paint('roads-minor', { 'line-width': roadWidth(0.6) }),
      },
      {
        id: 'roads-major',
        type: 'line',
        source: BASEMAP_SOURCE_ID,
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false],
        layout: lineLayout,
        paint: paint('roads-major', { 'line-width': roadWidth(1) }),
      },
      { id: 'grid-minor', type: 'line', source: 'grid', filter: ['==', ['get', 'major'], false], paint: paint('grid-minor', { 'line-width': 0.6 }) },
      { id: 'grid-major', type: 'line', source: 'grid', filter: ['==', ['get', 'major'], true], paint: paint('grid-major', { 'line-width': 1.1 }) },
    ],
  };
}
