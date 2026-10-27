// Instanced architectural scale-model vegetation (one InstancedMesh, one draw call).
//
// Trees are planted deterministically on three kinds of green ground:
//   1. the City Camp Lagoon perimeter park belt (12–80 m outside the rim),
//   2. avenue trees along both kerbs of every surface street (synthetic alignments),
//   3. wooded hillside buffers / pocket parks wherever the terrain green mask is high,
// keeping clear of building footprints, carriageways and the bowl itself.
import {
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type BufferGeometry,
  Color,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { NetworkFile } from '../types/twin';
import { Z_REF_M, type LocalFrame } from './frame';
import { hash2 } from './layers/terrain';
import { DAY, LIGHT_UNIFORMS, STUDIO_LIGHT_GLSL, THEME_UNIFORMS } from './theme';

export const TREE_TARGET = 560;
const MIN_SPACING_M = 5.5;

const vertex = /* glsl */ `
uniform float uTime;
uniform float uWind;
attribute float aPart;      // 0 trunk, 1 crown
attribute vec3 aTint;
attribute float aPhase;
varying vec3 vNormal;
varying vec3 vTint;
varying float vPart;
void main() {
  vec3 p = position;
  // Crown sway grows with height above the trunk and with storm wind.
  float sway = aPart * (p.z - 2.0) * 0.06 * (0.25 + uWind) * sin(uTime * (1.4 + uWind * 2.5) + aPhase);
  p.x += sway;
  p.y += sway * 0.6;
  vec4 w = instanceMatrix * vec4(p, 1.0);
  vNormal = normalize(mat3(instanceMatrix) * normal);
  vTint = aTint;
  vPart = aPart;
  gl_Position = projectionMatrix * modelViewMatrix * w;
}`;

const fragment = /* glsl */ `
uniform float uDay;
uniform vec3 uTrunk;
varying vec3 vNormal;
varying vec3 vTint;
varying float vPart;
${STUDIO_LIGHT_GLSL}
void main() {
  vec3 albedo = vPart < 0.5 ? uTrunk : vTint;
  vec3 lit = studioLight(albedo, vNormal);
  // X-ray: dim, cool foliage so it never competes with the drainage glow.
  vec3 dark = albedo * 0.32 + vec3(0.0, 0.05, 0.04);
  gl_FragColor = vec4(mix(dark, min(lit, vec3(1.0)), uDay), 1.0);
}`;

export interface VegetationLayer {
  group: Group;
  count: number;
  setVisible(on: boolean): void;
  setTime(t: number): void;
  setWind(rainMmHr: number): void;
}

function treeGeometry(): BufferGeometry {
  const trunk = new CylinderGeometry(0.22, 0.3, 2.4, 6, 1).rotateX(Math.PI / 2).translate(0, 0, 1.2).toNonIndexed();
  const crown = new IcosahedronGeometry(2.1, 0).scale(1, 1, 1.25).translate(0, 0, 4.1);
  const crownTop = new IcosahedronGeometry(1.35, 0).translate(0.35, -0.25, 5.6);
  const parts: BufferGeometry[] = [];
  for (const [g, part] of [[trunk, 0], [crown, 1], [crownTop, 1]] as const) {
    g.deleteAttribute('uv');
    g.setAttribute('aPart', new Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(part), 1));
    parts.push(g);
  }
  return mergeGeometries(parts, false)!;
}

export function buildVegetation(
  net: NetworkFile,
  frame: LocalFrame,
  sampleElevation: (x: number, y: number) => number,
  greenAt: (x: number, y: number) => number,
): VegetationLayer {
  const rim = net.lagoon.polygon[0].slice(0, -1).map(([lng, lat]) => frame.toLocal(lng, lat));
  const rimR = (a: number) => {
    let best = Infinity;
    let r = 100;
    for (const p of rim) {
      const d = Math.abs(Math.atan2(Math.sin(a - Math.atan2(p.y, p.x)), Math.cos(a - Math.atan2(p.y, p.x))));
      if (d < best) {
        best = d;
        r = Math.hypot(p.x, p.y);
      }
    }
    return r;
  };
  const roads = net.conduits
    .filter((c) => c.network !== 'TUNNEL')
    .map((c) => {
      const a = frame.toLocal(c.coordinates[0][0], c.coordinates[0][1]);
      const b = frame.toLocal(c.coordinates[1][0], c.coordinates[1][1]);
      return { a, b, half: c.network === 'ARTERIAL' ? 5.9 : 4.4 };
    });
  const bldg = net.buildings.map((b) => {
    const pts = b.coordinates[0].slice(0, -1).map(([lng, lat]) => frame.toLocal(lng, lat));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { cx, cy, r: Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) };
  });
  const roadDist = (x: number, y: number) => {
    let d = Infinity;
    for (const r of roads) {
      const dx = r.b.x - r.a.x;
      const dy = r.b.y - r.a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(Math.max(((x - r.a.x) * dx + (y - r.a.y) * dy) / l2, 0), 1) : 0;
      d = Math.min(d, Math.hypot(x - (r.a.x + t * dx), y - (r.a.y + t * dy)) - r.half);
    }
    return d;
  };
  const taken = new Map<string, { x: number; y: number }[]>();
  const placed: { x: number; y: number; s: number }[] = [];
  const free = (x: number, y: number) => {
    const gx = Math.floor(x / MIN_SPACING_M);
    const gy = Math.floor(y / MIN_SPACING_M);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const p of taken.get(`${gx + i},${gy + j}`) ?? []) if (Math.hypot(p.x - x, p.y - y) < MIN_SPACING_M) return false;
    return true;
  };
  const tryPlace = (x: number, y: number, scale: number) => {
    if (placed.length >= TREE_TARGET) return;
    const r = Math.hypot(x, y);
    if (r - rimR(Math.atan2(y, x)) < 6) return;                 // not in the bowl
    if (roadDist(x, y) < 1.2) return;                           // not on the carriageway
    for (const b of bldg) if (Math.hypot(x - b.cx, y - b.cy) < b.r + 3) return;
    if (!free(x, y)) return;
    const key = `${Math.floor(x / MIN_SPACING_M)},${Math.floor(y / MIN_SPACING_M)}`;
    taken.set(key, [...(taken.get(key) ?? []), { x, y }]);
    placed.push({ x, y, s: scale });
  };

  // 1. Lagoon perimeter park belt: two staggered rings.
  for (let k = 0; k < 150; k++) {
    const a = (k / 150) * Math.PI * 2 + hash2(k, 0.7) * 0.02;
    const off = 16 + hash2(k, 1.9) * 52;
    const r = rimR(a) + off;
    tryPlace(Math.cos(a) * r, Math.sin(a) * r, 0.9 + hash2(k, 3.3) * 0.5);
  }
  // 2. Avenue trees on both kerbs every ~20 m.
  roads.forEach((rd, ri) => {
    const len = rd.a.distanceTo(rd.b);
    const ux = (rd.b.x - rd.a.x) / len;
    const uy = (rd.b.y - rd.a.y) / len;
    for (let s = 6; s < len - 4; s += 20) {
      for (const side of [-1, 1]) {
        const off = rd.half + 2.6;
        tryPlace(rd.a.x + ux * s - side * uy * off, rd.a.y + uy * s + side * ux * off, 0.75 + hash2(ri + s, side) * 0.3);
      }
    }
  });
  // 3. Wooded hillsides and pocket parks from the terrain green mask.
  for (let k = 0; k < 9000 && placed.length < TREE_TARGET; k++) {
    const ang = hash2(k, 11.1) * Math.PI * 2;
    const rad = 110 + Math.sqrt(hash2(k, 12.7)) * 640;
    const x = Math.cos(ang) * rad;
    const y = Math.sin(ang) * rad;
    if (greenAt(x, y) < 0.45 + hash2(k, 13.9) * 0.3) continue;
    tryPlace(x, y, 0.85 + hash2(k, 14.2) * 0.75);
  }

  const geom = treeGeometry();
  const material = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: { ...LIGHT_UNIFORMS, uDay: THEME_UNIFORMS.uDay, uTime: { value: 0 }, uWind: { value: 0 }, uTrunk: { value: new Color(DAY.trunk) } },
    side: DoubleSide,
  });
  const mesh = new InstancedMesh(geom, material, placed.length);
  const tint = new Float32Array(placed.length * 3);
  const phase = new Float32Array(placed.length);
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 0, 1);
  const c = new Color();
  placed.forEach((p, i) => {
    const z = sampleElevation(p.x, p.y) - Z_REF_M;
    q.setFromAxisAngle(up, hash2(p.x, p.y) * Math.PI * 2);
    const h = p.s * (0.9 + hash2(p.y, p.x) * 0.25);
    m.compose(new Vector3(p.x, p.y, z), q, new Vector3(p.s, p.s, h));
    mesh.setMatrixAt(i, m);
    c.set(DAY.foliage[Math.floor(hash2(i, 0.37) * DAY.foliage.length) % DAY.foliage.length]);
    tint.set([c.r, c.g, c.b], i * 3);
    phase[i] = hash2(i, 9.1) * 6.283;
  });
  geom.setAttribute('aTint', new InstancedBufferAttribute(tint, 3));
  geom.setAttribute('aPhase', new InstancedBufferAttribute(phase, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = 18;
  mesh.frustumCulled = false;

  const group = new Group();
  group.name = 'vegetation';
  group.add(mesh);
  return {
    group,
    count: placed.length,
    setVisible(on) {
      group.visible = on;
    },
    setTime(t) {
      material.uniforms.uTime.value = t;
    },
    setWind(rainMmHr) {
      material.uniforms.uWind.value = Math.min(rainMmHr / 200, 1.2);
    },
  };
}
