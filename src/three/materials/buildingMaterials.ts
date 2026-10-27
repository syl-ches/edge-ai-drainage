// Shared surface-building materials for the main map and the Subsurface Utility Inspector.
//   solid — crisp matte architectural white (walls #FFFFFF, roofs #F8FAFC, green civic roofs),
//           studio-lit, with faint floor-band window strips; dark slate massing in X-ray.
//   wire  — architectural wireframe (emerald crown → slate base edges) over a 4 % fill.
//   glass — Schlick-Fresnel frost white-mint core with an emerald rim (daylight) or the
//           original slate/cyan glass (X-ray); depthWrite off so the drainage shows through.
import { BufferGeometry, Color, DoubleSide, EdgesGeometry, ExtrudeGeometry, Float32BufferAttribute, ShaderMaterial, Shape, Vector2, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LIGHT_UNIFORMS, STUDIO_LIGHT_GLSL, THEME_UNIFORMS } from '../theme';

export type ShadingMode = 'solid' | 'wire' | 'glass';
export const SHADING_MODES: { id: ShadingMode; label: string }[] = [
  { id: 'solid', label: 'Solid Concrete' },
  { id: 'wire', label: 'Holo Wireframe' },
  { id: 'glass', label: 'Fresnel Glass' },
];

export interface Footprint {
  ring: Vector2[];   // scene metres, open ring
  baseZ: number;     // scene z of the footprint base
  height: number;    // metres
  greenRoof: boolean;
}

const vertex = /* glsl */ `
attribute float aZ;
attribute float aH;
attribute float aGreen;
varying vec3 vPos;
varying vec3 vNormal;
varying float vZ;
varying float vH;
varying float vGreen;
void main() {
  vPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vZ = aZ; vH = aH; vGreen = aGreen;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const varyings = /* glsl */ `
uniform float uDay;
uniform vec3 uCameraPos;
varying vec3 vPos;
varying vec3 vNormal;
varying float vZ;
varying float vH;
varying float vGreen;
`;

const solidFragment = /* glsl */ `
${varyings}
${STUDIO_LIGHT_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  bool roof = n.z > 0.8;
  vec3 wallDay = vec3(1.0);
  vec3 roofDay = mix(vec3(0.973, 0.980, 0.988), vec3(0.639, 0.851, 0.545), vGreen);   // #F8FAFC | #A3D98B
  vec3 wallDark = vec3(0.118, 0.161, 0.231);
  vec3 roofDark = mix(vec3(0.20, 0.255, 0.333), vec3(0.15, 0.32, 0.22), vGreen);
  vec3 albedo = roof ? mix(roofDark, roofDay, uDay) : mix(wallDark, wallDay, uDay);
  // Architectural-model window strips: a slightly cooler band in every 3 m storey.
  float storey = fract(vZ / 3.0);
  float glazing = (!roof && vZ > 1.0 && vZ < vH - 0.6) ? smoothstep(0.35, 0.40, storey) * (1.0 - smoothstep(0.78, 0.83, storey)) : 0.0;
  albedo = mix(albedo, mix(vec3(0.20, 0.30, 0.42), vec3(0.886, 0.910, 0.941), uDay), glazing * 0.55);
  vec3 col = studioLight(albedo, n);
  if (uDay < 0.5) col += albedo * 0.25;
  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
}`;

const glassFragment = /* glsl */ `
${varyings}
uniform float uBaseOpacity;
uniform float uRimPower;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vPos);
  float fresnel = pow(1.0 - clamp(abs(dot(V, N)), 0.0, 1.0), uRimPower);
  // Daylight: pure frost white-mint core + emerald/teal rim. X-ray: slate core + cyan rim.
  vec3 core = mix(vec3(0.059, 0.090, 0.165), vec3(0.96, 0.99, 0.97), uDay);
  vec3 rim = mix(vec3(0.220, 0.741, 0.973), vec3(0.06, 0.72, 0.50), uDay);
  vec3 col = mix(core, rim, fresnel * 0.85);
  float alpha = clamp(uBaseOpacity + fresnel * 0.42, 0.10, 0.58);
  gl_FragColor = vec4(col, alpha);
}`;

const wireFillFragment = /* glsl */ `
${varyings}
void main() {
  gl_FragColor = vec4(mix(vec3(0.06, 0.09, 0.16), vec3(0.925, 0.992, 0.961), uDay), 0.04);
}`;

const edgeFragment = /* glsl */ `
${varyings}
uniform float uMode; // 0 solid, 1 wire, 2 glass
void main() {
  float k = clamp(vZ / max(vH, 1.0), 0.0, 1.0);
  vec3 slate = vec3(0.392, 0.455, 0.545);   // #64748B
  vec3 emerald = vec3(0.063, 0.725, 0.506); // #10B981
  vec3 col;
  float alpha;
  if (uMode < 0.5) {            // solid: subtle #CBD5E1 outlines
    col = mix(vec3(0.28, 0.33, 0.41), vec3(0.796, 0.835, 0.882), uDay);
    alpha = 0.9;
  } else if (uMode < 1.5) {     // holo wireframe: emerald crowns, slate footings
    col = mix(mix(vec3(0.20, 0.55, 0.75), vec3(0.22, 0.74, 0.97), k), mix(slate, emerald, k), uDay);
    alpha = 0.95;
  } else {                      // glass: soft rim lines
    col = mix(vec3(0.220, 0.741, 0.973), emerald, uDay);
    alpha = mix(0.32, 0.45, uDay);
  }
  gl_FragColor = vec4(col, alpha);
}`;

export interface BuildingMaterials {
  solid: ShaderMaterial;
  glass: ShaderMaterial;
  wireFill: ShaderMaterial;
  edges: ShaderMaterial;
  setMode(mode: ShadingMode): void;
  setGlassOpacity(v: number): void;
}

export function createBuildingMaterials(cameraPos: Vector3): BuildingMaterials {
  const base = { uDay: THEME_UNIFORMS.uDay, uCameraPos: { value: cameraPos } };
  const solid = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: solidFragment,
    uniforms: { ...base, ...LIGHT_UNIFORMS },
    side: DoubleSide,
  });
  const glass = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: glassFragment,
    uniforms: { ...base, uBaseOpacity: { value: 0.14 }, uRimPower: { value: 2.6 } },
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
  const mode = { value: 2 };
  const edges = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: edgeFragment,
    uniforms: { ...base, uMode: mode },
    transparent: true,
    depthWrite: false,
  });
  return {
    solid,
    glass,
    wireFill,
    edges,
    setMode(m) {
      mode.value = m === 'solid' ? 0 : m === 'wire' ? 1 : 2;
    },
    setGlassOpacity(v) {
      glass.uniforms.uBaseOpacity.value = v;
    },
  };
}

function withAttributes(g: BufferGeometry, baseZ: number, height: number, green: boolean): BufferGeometry {
  const pos = g.getAttribute('position');
  const n = pos.count;
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = pos.getZ(i) - baseZ;
  g.setAttribute('aZ', new Float32BufferAttribute(z, 1));
  g.setAttribute('aH', new Float32BufferAttribute(new Float32Array(n).fill(height), 1));
  g.setAttribute('aGreen', new Float32BufferAttribute(new Float32Array(n).fill(green ? 1 : 0), 1));
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
    solids.push(withAttributes(flat, f.baseZ, f.height, f.greenRoof));
    const e = new EdgesGeometry(g, 30);
    e.setAttribute('normal', new Float32BufferAttribute(new Float32Array(e.getAttribute('position').count * 3), 3));
    edges.push(withAttributes(e, f.baseZ, f.height, f.greenRoof));
  }
  return { solid: mergeGeometries(solids, false)!, edges: mergeGeometries(edges, false)! };
}

export const GREEN_ROOF_COLOR = new Color('#A3D98B');
