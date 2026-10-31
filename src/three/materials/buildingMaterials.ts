// Shared surface-building materials for the main map and the Subsurface Utility Inspector.
//   solid — matte architectural white (#EFEFEF walls and roofs, ArchiMap scale-model look; no
//           floor bands, no outlines), shaded only by the studio sun + hemisphere; dark slate
//           massing in X-ray. The default shading mode since Phase 9B.
//   wire  — the only mode with edge lines: #059669 crowns -> #475569 footings over a 4 % fill.
//   glass — outline-free Schlick-Fresnel glass: crystal-clear core, soft emerald grazing rim
//           (X-ray: slate core + cyan rim); depthWrite off so the drainage always shows through.
import {
  BufferGeometry,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  ShaderMaterial,
  Shape,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LIGHT_UNIFORMS, STUDIO_LIGHT_GLSL, THEME_UNIFORMS } from '../theme';

export type ShadingMode = 'solid' | 'wire' | 'glass';
export const SHADING_MODES: { id: ShadingMode; label: string }[] = [
  { id: 'solid', label: 'Solid Concrete' },
  { id: 'wire', label: 'Holo Wireframe' },
  { id: 'glass', label: 'Fresnel Glass' },
];

/** Daylight albedo of Solid Concrete massing: #EFEFEF. */
export const SOLID_ALBEDO = 0xef / 255;
/** Solid Concrete <-> Fresnel Glass crossfade length (s). */
export const SHADING_FADE_S = 0.7;

/** Edge LineSegments are drawn in Holo Wireframe only (solid and glass are outline-free). */
export const SHADING_SHOWS_EDGES: Record<ShadingMode, boolean> = { solid: false, wire: true, glass: false };

/** Daylight Fresnel glass constants (CLAUDE.md §11). */
export const GLASS = {
  core: [0.95, 0.99, 1.0],
  rim: [0.06, 0.72, 0.58],
  baseOpacity: 0.08,
  rimPower: 2.8,
  rimGain: 0.48,
  alphaMin: 0.06,
  alphaMax: 0.62,
} as const;

export interface Footprint {
  ring: Vector2[]; // scene metres, open ring
  baseZ: number; // scene z of the footprint base
  height: number; // metres
}

const vertex = /* glsl */ `
attribute float aZ;
attribute float aH;
varying vec3 vPos;
varying vec3 vNormal;
varying float vZ;
varying float vH;
void main() {
  vPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vZ = aZ; vH = aH;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const varyings = /* glsl */ `
uniform float uDay;
uniform vec3 uCameraPos;
varying vec3 vPos;
varying vec3 vNormal;
varying float vZ;
varying float vH;
`;

const solidFragment = /* glsl */ `
${varyings}
uniform float uOpacity;
${STUDIO_LIGHT_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  bool roof = n.z > 0.8;
  // Daylight: one matte #EFEFEF albedo; faces read only through the sun/hemisphere shading.
  vec3 dark = roof ? vec3(0.20, 0.255, 0.333) : vec3(0.118, 0.161, 0.231);
  vec3 albedo = mix(dark, vec3(${SOLID_ALBEDO.toFixed(4)}), uDay);
  vec3 col = studioLight(albedo, n);
  if (uDay < 0.5) col += albedo * 0.25;
  gl_FragColor = vec4(min(col, vec3(1.0)), uOpacity);
}`;

const glassFragment = /* glsl */ `
${varyings}
uniform vec3 uCoreColor;
uniform vec3 uRimColor;
uniform float uBaseOpacity;
uniform float uRimPower;
uniform float uFade;
void main() {
  // Schlick Fresnel. The custom mercator projection has no usable view matrix, so N and V are
  // taken in world space (eye = inverse(MVP)·(0,0,1,0)); |N·V| is the same in any frame.
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vPos);
  float fresnel = pow(1.0 - clamp(abs(dot(V, N)), 0.0, 1.0), uRimPower);
  vec3 core = mix(vec3(0.059, 0.090, 0.165), uCoreColor, uDay);
  vec3 rim = mix(vec3(0.220, 0.741, 0.973), uRimColor, uDay);
  vec3 color = mix(core, rim, fresnel);
  float alpha = clamp(uBaseOpacity + fresnel * ${GLASS.rimGain.toFixed(2)}, ${GLASS.alphaMin.toFixed(2)}, ${GLASS.alphaMax.toFixed(2)});
  gl_FragColor = vec4(color, alpha * uFade);
}`;

const wireFillFragment = /* glsl */ `
${varyings}
void main() {
  gl_FragColor = vec4(mix(vec3(0.06, 0.09, 0.16), vec3(0.925, 0.992, 0.961), uDay), 0.04);
}`;

const edgeFragment = /* glsl */ `
${varyings}
void main() {
  // Holo wireframe only: crisp #059669 crowns fading to #475569 footings (X-ray: cyan).
  float k = clamp(vZ / max(vH, 1.0), 0.0, 1.0);
  vec3 slate = vec3(0.278, 0.333, 0.412);   // #475569
  vec3 emerald = vec3(0.020, 0.588, 0.412); // #059669
  vec3 col = mix(mix(vec3(0.20, 0.55, 0.75), vec3(0.22, 0.74, 0.97), k), mix(slate, emerald, k), uDay);
  gl_FragColor = vec4(col, 0.95);
}`;

export interface BuildingMeshes {
  solid: Object3D;
  glass: Object3D;
  wireFill: Object3D;
  edges: Object3D;
}

export interface BuildingMaterials {
  solid: ShaderMaterial;
  glass: ShaderMaterial;
  wireFill: ShaderMaterial;
  edges: ShaderMaterial;
  /** Shows the meshes of one shading mode (edge lines only in Holo Wireframe). */
  apply(mode: ShadingMode, meshes: BuildingMeshes): void;
  /** Solid <-> glass crossfade at k in 0..1 (both meshes drawn; solid fades with depth kept). */
  crossfade(from: 'solid' | 'glass', k: number, meshes: BuildingMeshes): void;
  setGlassOpacity(v: number): void;
}

export function createBuildingMaterials(cameraPos: Vector3): BuildingMaterials {
  const base = { uDay: THEME_UNIFORMS.uDay, uCameraPos: { value: cameraPos } };
  // Transparent only so it can fade; at uOpacity 1 it is opaque and still writes depth.
  const solid = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: solidFragment,
    uniforms: { ...base, ...LIGHT_UNIFORMS, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
  });
  const glass = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: glassFragment,
    uniforms: {
      ...base,
      uCoreColor: { value: new Vector3(...GLASS.core) },
      uRimColor: { value: new Vector3(...GLASS.rim) },
      uBaseOpacity: { value: GLASS.baseOpacity },
      uRimPower: { value: GLASS.rimPower },
      uFade: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
  });
  const wireFill = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: wireFillFragment,
    uniforms: base,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  const edges = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: edgeFragment,
    uniforms: base,
    transparent: true,
    depthWrite: false,
  });
  return {
    solid,
    glass,
    wireFill,
    edges,
    apply(m, meshes) {
      solid.uniforms.uOpacity.value = 1;
      glass.uniforms.uFade.value = 1;
      meshes.solid.visible = m === 'solid';
      meshes.glass.visible = m === 'glass';
      meshes.wireFill.visible = m === 'wire';
      meshes.edges.visible = SHADING_SHOWS_EDGES[m];
    },
    crossfade(from, k, meshes) {
      const toGlass = from === 'solid' ? k : 1 - k;
      meshes.solid.visible = toGlass < 0.999;
      meshes.glass.visible = toGlass > 0.001;
      meshes.wireFill.visible = false;
      meshes.edges.visible = false;
      solid.uniforms.uOpacity.value = 1 - toGlass;
      glass.uniforms.uFade.value = toGlass;
    },
    setGlassOpacity(v) {
      glass.uniforms.uBaseOpacity.value = v;
    },
  };
}

function withAttributes(g: BufferGeometry, baseZ: number, height: number): BufferGeometry {
  const pos = g.getAttribute('position');
  const n = pos.count;
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = pos.getZ(i) - baseZ;
  g.setAttribute('aZ', new Float32BufferAttribute(z, 1));
  g.setAttribute('aH', new Float32BufferAttribute(new Float32Array(n).fill(height), 1));
  return g;
}

/** One merged solid geometry + one merged edge geometry for a set of footprints. */
export function buildingGeometries(footprints: Footprint[]): { solid: BufferGeometry; edges: BufferGeometry } {
  const solids: BufferGeometry[] = [];
  const edges: BufferGeometry[] = [];
  for (const f of footprints) {
    const g = new ExtrudeGeometry(new Shape(f.ring), { depth: f.height, bevelEnabled: false });
    g.translate(0, 0, f.baseZ);
    const flat = g.index ? g.toNonIndexed() : g;
    flat.deleteAttribute('uv');
    solids.push(withAttributes(flat, f.baseZ, f.height));
    const e = new EdgesGeometry(g, 30);
    e.setAttribute('normal', new Float32BufferAttribute(new Float32Array(e.getAttribute('position').count * 3), 3));
    edges.push(withAttributes(e, f.baseZ, f.height));
  }
  return { solid: mergeGeometries(solids, false)!, edges: mergeGeometries(edges, false)! };
}
