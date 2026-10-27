import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  ShaderMaterial,
} from 'three';
import type { NetworkFile } from '../../types/twin';
import { Z_REF_M, type LocalFrame } from '../frame';
import { DAY, THEME_UNIFORMS, XRAY, type Theme } from '../theme';

const CELL_M = 15;
const MARGIN_M = 180;
const MINOR_INTERVAL_M = 5;
const MAJOR_INTERVAL_M = 25;
const ROAD_CLEAR_M = 9;

interface Sample {
  x: number;
  y: number;
  z: number;
}

/** Surface elevation samples: node rims, building bases and the lagoon bowl profile. */
function collectSamples(net: NetworkFile, frame: LocalFrame): Sample[] {
  const samples: Sample[] = [];
  for (const n of net.nodes) {
    if (n.type === 'STORAGE') continue;
    const p = frame.toLocal(n.coordinates[0], n.coordinates[1]);
    samples.push({ x: p.x, y: p.y, z: n.rim_elev_m });
  }
  for (const b of net.buildings) {
    const ring = b.coordinates[0];
    let cx = 0;
    let cy = 0;
    for (const [lng, lat] of ring.slice(0, -1)) {
      const p = frame.toLocal(lng, lat);
      cx += p.x;
      cy += p.y;
    }
    samples.push({ x: cx / (ring.length - 1), y: cy / (ring.length - 1), z: b.ground_elev_m });
  }
  const lag = net.lagoon;
  const rim = lag.polygon[0].slice(0, -1).map(([lng, lat]) => frame.toLocal(lng, lat));
  const profile: [number, number][] = [
    [1.0, lag.rim_elev_m],
    [0.85, lag.invert_elev_m + 0.7 * lag.max_depth_m],
    [0.7, lag.invert_elev_m + 0.3 * lag.max_depth_m],
    [0.45, lag.invert_elev_m + 0.05 * lag.max_depth_m],
  ];
  for (const [k, z] of profile) {
    rim.forEach((p, i) => {
      if (k < 1 && i % 3 !== 0) return;
      samples.push({ x: p.x * k, y: p.y * k, z });
    });
  }
  samples.push({ x: 0, y: 0, z: lag.invert_elev_m });
  return samples;
}

function idw(samples: Sample[], x: number, y: number): number {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d2 < 1) return s.z;
    const w = 1 / (d2 * Math.sqrt(d2)); // power 3: tighter local influence on steep slopes
    num += w * s.z;
    den += w;
  }
  return num / den;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / l2, 0), 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Deterministic 2D hash in [0, 1). */
export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// Marching-squares edge pairs per case (edges: 0 a-b, 1 b-c, 2 c-d, 3 d-a).
const CASES: number[][] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
  [2, 3], [0, 2], [0, 1, 2, 3], [1, 2], [1, 3], [0, 1], [0, 3], [],
];

const terrainVertex = /* glsl */ `
attribute float aGreen;
attribute float aShade;
attribute float aEdge;
varying vec3 vWorld;
varying float vGreen;
varying float vShade;
varying float vEdge;
void main() {
  vWorld = position;
  vGreen = aGreen; vShade = aShade; vEdge = aEdge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const terrainFragment = /* glsl */ `
uniform float uDay;
uniform float uTime;
uniform float uRain;
uniform float uZRef;
uniform vec2 uZRange;
uniform vec3 uLand;
uniform vec3 uLandBand;
uniform vec3 uPark;
uniform vec3 uParkDeep;
uniform float uParks;
uniform vec3 uDarkLow;
uniform vec3 uDarkHigh;
varying vec3 vWorld;
varying float vGreen;
varying float vShade;
varying float vEdge;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float elev = vWorld.z + uZRef;
  // Daylight: alabaster land with crisp alternating 5 m elevation bands + sage/emerald parks.
  float band = mod(floor(elev / 5.0), 2.0);
  vec3 land = mix(uLand, uLandBand, band * 0.85);
  vec3 park = mix(uPark, uParkDeep, smoothstep(0.35, 0.95, vShade * 0.6 + vGreen * 0.5));
  vec3 day = mix(land, park, smoothstep(0.25, 0.55, vGreen) * uParks);
  // Raindrop splash rings on the street plane (4 m cells, random phase per cell).
  vec2 cell = floor(vWorld.xy / 4.0);
  float rnd = hash(cell);
  float life = fract(uTime * 0.9 + rnd * 7.0);
  float dist = length(fract(vWorld.xy / 4.0) - 0.5 - (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.5) * 4.0;
  float ring = (1.0 - smoothstep(0.0, 0.18, abs(dist - life * 1.6))) * (1.0 - life) * step(rnd, uRain);
  day = mix(day, vec3(0.88, 0.95, 0.99), ring * 0.65);
  // X-ray: the original navy -> teal elevation ramp.
  vec3 dark = mix(uDarkLow, uDarkHigh, clamp((elev - uZRange.x) / max(uZRange.y - uZRange.x, 1.0), 0.0, 1.0));
  vec3 col = mix(dark, day, uDay);
  float alpha = mix(0.2, 0.94, uDay) * vEdge;
  gl_FragColor = vec4(col, alpha);
}`;

export interface TerrainLayer {
  group: Group;
  /** Terrain elevation (m ASL) at scene x/y, bilinear on the DEM grid. */
  sampleElevation(x: number, y: number): number;
  /** Park / green-belt mask 0..1 at scene x/y. */
  greenAt(x: number, y: number): number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  setTheme(theme: Theme): void;
  setTime(t: number): void;
  setRain(mmHr: number): void;
  /** Park / green-belt tint on or off (the "3D Vegetation & Parks" toggle). */
  setParks(on: boolean): void;
}

/**
 * DEM surface interpolated from the network's own surface elevations, + 5 m contour lines
 * (25 m majors). Daylight: an opaque-ish alabaster/sage diorama ground; X-ray: a faint
 * translucent navy surface. It never writes depth, so the buried drainage stays visible.
 */
export function buildTerrain(net: NetworkFile, frame: LocalFrame): TerrainLayer {
  const samples = collectSamples(net, frame);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
  }
  minX -= MARGIN_M;
  minY -= MARGIN_M;
  maxX += MARGIN_M;
  maxY += MARGIN_M;
  const nx = Math.ceil((maxX - minX) / CELL_M) + 1;
  const ny = Math.ceil((maxY - minY) / CELL_M) + 1;

  const elev = new Float32Array(nx * ny);
  const pos = new Float32Array(nx * ny * 3);
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = minX + i * CELL_M;
      const y = minY + j * CELL_M;
      const z = idw(samples, x, y);
      elev[k] = z;
      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
      pos.set([x, y, z - Z_REF_M], k * 3);
    }
  }

  // ---- green-belt mask: lagoon perimeter park, wooded steep hillsides, pocket parks
  const rim = net.lagoon.polygon[0].slice(0, -1).map(([lng, lat]) => frame.toLocal(lng, lat));
  const rimAngles = rim.map((p) => ({ a: Math.atan2(p.y, p.x), r: Math.hypot(p.x, p.y) })).sort((p, q) => p.a - q.a);
  const rimRadius = (a: number) => {
    let best = rimAngles[0];
    let bestD = Infinity;
    for (const p of rimAngles) {
      const d = Math.abs(Math.atan2(Math.sin(a - p.a), Math.cos(a - p.a)));
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best.r;
  };
  const roads = net.conduits
    .filter((c) => c.network !== 'TUNNEL')
    .map((c) => {
      const a = frame.toLocal(c.coordinates[0][0], c.coordinates[0][1]);
      const b = frame.toLocal(c.coordinates[1][0], c.coordinates[1][1]);
      return [a.x, a.y, b.x, b.y] as const;
    });
  const bldg = net.buildings.map((b) => {
    const pts = b.coordinates[0].slice(0, -1).map(([lng, lat]) => frame.toLocal(lng, lat));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const r = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    return { cx, cy, r };
  });
  const parks: { x: number; y: number; r: number }[] = [];
  for (let k = 0; k < 14; k++) {
    const ang = hash2(k, 1.3) * Math.PI * 2;
    const rad = 170 + hash2(k, 2.9) * 420;
    parks.push({ x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, r: 28 + hash2(k, 5.1) * 40 });
  }
  const smooth = (e0: number, e1: number, v: number) => {
    const t = Math.min(Math.max((v - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const green = new Float32Array(nx * ny);
  const shade = new Float32Array(nx * ny);
  const edge = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = minX + i * CELL_M;
      const y = minY + j * CELL_M;
      const r = Math.hypot(x, y);
      const d = r - rimRadius(Math.atan2(y, x));
      const zx = (elev[j * nx + Math.min(i + 1, nx - 1)] - elev[j * nx + Math.max(i - 1, 0)]) / (2 * CELL_M);
      const zy = (elev[Math.min(j + 1, ny - 1) * nx + i] - elev[Math.max(j - 1, 0) * nx + i]) / (2 * CELL_M);
      const slope = Math.hypot(zx, zy);
      let g = Math.max(
        smooth(4, 12, d) * (1 - smooth(55, 85, d)),          // lagoon perimeter park belt
        smooth(0.13, 0.22, slope) * 0.9,                      // wooded hillside buffer slopes
        ...parks.map((p) => 1 - smooth(p.r * 0.7, p.r, Math.hypot(x - p.x, y - p.y))),
      );
      if (d < 2) g = 0;                                       // inside the bowl
      let road = Infinity;
      for (const [ax, ay, bx, by] of roads) road = Math.min(road, segDist(x, y, ax, ay, bx, by));
      g *= smooth(ROAD_CLEAR_M - 3, ROAD_CLEAR_M + 3, road);
      for (const b of bldg) g *= smooth(b.r, b.r + 6, Math.hypot(x - b.cx, y - b.cy));
      green[k] = g;
      shade[k] = hash2(Math.floor(x / 45), Math.floor(y / 45));
      const toEdge = Math.min(x - minX, maxX - x, y - minY, maxY - y);
      edge[k] = smooth(0, 160, toEdge);
    }
  }

  const index: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      index.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
    }
  }
  const surfGeom = new BufferGeometry();
  surfGeom.setAttribute('position', new BufferAttribute(pos, 3));
  surfGeom.setAttribute('aGreen', new BufferAttribute(green, 1));
  surfGeom.setAttribute('aShade', new BufferAttribute(shade, 1));
  surfGeom.setAttribute('aEdge', new BufferAttribute(edge, 1));
  surfGeom.setIndex(index);
  const uniforms = {
    uDay: THEME_UNIFORMS.uDay,
    uTime: { value: 0 },
    uRain: { value: 0 },
    uZRef: { value: Z_REF_M },
    uZRange: { value: [zMin, zMax] },
    uLand: { value: new Color(DAY.land) },
    uLandBand: { value: new Color(DAY.landBand) },
    uPark: { value: new Color(DAY.park) },
    uParkDeep: { value: new Color(DAY.parkDeep) },
    uParks: { value: 1 },
    uDarkLow: { value: new Color(XRAY.land) },
    uDarkHigh: { value: new Color(XRAY.landHigh) },
  };
  const surface = new Mesh(
    surfGeom,
    new ShaderMaterial({ vertexShader: terrainVertex, fragmentShader: terrainFragment, uniforms, transparent: true, depthWrite: false, side: DoubleSide }),
  );
  surface.renderOrder = 1;

  const minor: number[] = [];
  const major: number[] = [];
  const first = Math.ceil(zMin / MINOR_INTERVAL_M) * MINOR_INTERVAL_M;
  for (let level = first; level <= zMax; level += MINOR_INTERVAL_M) {
    const out = level % MAJOR_INTERVAL_M === 0 ? major : minor;
    const zl = level - Z_REF_M + 0.15;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const ka = j * nx + i;
        const corners = [ka, ka + 1, ka + nx + 1, ka + nx];
        const zs = corners.map((k) => elev[k]);
        const idx = (zs[0] > level ? 1 : 0) | (zs[1] > level ? 2 : 0) | (zs[2] > level ? 4 : 0) | (zs[3] > level ? 8 : 0);
        const edges = CASES[idx];
        for (let e = 0; e < edges.length; e++) {
          const p = edges[e];
          const q = (p + 1) % 4;
          const t = (level - zs[p]) / (zs[q] - zs[p]);
          out.push(
            pos[corners[p] * 3] + t * (pos[corners[q] * 3] - pos[corners[p] * 3]),
            pos[corners[p] * 3 + 1] + t * (pos[corners[q] * 3 + 1] - pos[corners[p] * 3 + 1]),
            zl,
          );
        }
      }
    }
  }
  const minorMat = new LineBasicMaterial({ transparent: true, depthWrite: false });
  const majorMat = new LineBasicMaterial({ transparent: true, depthWrite: false });
  const lines = (data: number[], mat: LineBasicMaterial) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(data, 3));
    const l = new LineSegments(g, mat);
    l.renderOrder = 2;
    return l;
  };

  const group = new Group();
  group.name = 'terrain';
  group.add(surface, lines(minor, minorMat), lines(major, majorMat));
  group.traverse((o) => (o.frustumCulled = false));

  const bilinear = (arr: Float32Array, x: number, y: number) => {
    const fx = Math.min(Math.max((x - minX) / CELL_M, 0), nx - 1.001);
    const fy = Math.min(Math.max((y - minY) / CELL_M, 0), ny - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const k = j * nx + i;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + nx] * (1 - tx) + arr[k + nx + 1] * tx) * ty;
  };

  const layer: TerrainLayer = {
    group,
    sampleElevation: (x, y) => bilinear(elev, x, y),
    greenAt: (x, y) => bilinear(green, x, y),
    bounds: { minX, minY, maxX, maxY },
    setTheme(theme) {
      const day = theme === 'daylight';
      minorMat.color.set(day ? DAY.contourMinor : XRAY.contourMinor);
      minorMat.opacity = day ? 0.55 : 0.32;
      majorMat.color.set(day ? DAY.contourMajor : XRAY.contourMajor);
      majorMat.opacity = day ? 0.75 : 0.55;
    },
    setTime(t) {
      uniforms.uTime.value = t;
    },
    setRain(mmHr) {
      uniforms.uRain.value = mmHr <= 0.05 ? 0 : Math.min(0.08 + mmHr / 250, 1);
    },
    setParks(on) {
      uniforms.uParks.value = on ? 1 : 0;
    },
  };
  layer.setTheme('daylight');
  return layer;
}

