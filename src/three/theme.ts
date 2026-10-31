// Shared theme + studio-lighting state for every custom shader in the scene.
//
// Two looks: 'daylight' (sunlit white & lush-green architectural scale model, default) and
// 'xray' (the original obsidian X-ray). All ShaderMaterials reference the *same* uniform
// objects below, so a theme switch is one uniform write — no geometry or material rebuilds.
//
// Lighting is evaluated in our own GLSL (studioLight) rather than three's lit materials:
// the MapLibre mercator mapping mirrors y, which flips gl_FrontFacing and would invert
// three's double-sided normals. Real HemisphereLight / DirectionalLight objects with the
// same values are still added to the scene for any stock material.
import { Color, Vector3 } from 'three';

export type Theme = 'daylight' | 'xray';

export const LIGHTING = {
  skyColor: 0xffffff,
  groundColor: 0xd8e8d4,
  hemiIntensity: 1.15,
  sunColor: 0xfffbeb,
  sunIntensity: 1.35,
  // From the south-east, high in the sky (scene axes: x east, y north, z up).
  sunDirection: new Vector3(0.45, -0.38, 0.81).normalize(),
} as const;

/** `uDay` = 1 in daylight, 0 in X-ray. Shared by reference across all materials. */
export const THEME_UNIFORMS = {
  uDay: { value: 1 },
};

export const LIGHT_UNIFORMS = {
  uSkyColor: { value: new Color(LIGHTING.skyColor) },
  uGroundColor: { value: new Color(LIGHTING.groundColor) },
  uHemiIntensity: { value: LIGHTING.hemiIntensity },
  uSunColor: { value: new Color(LIGHTING.sunColor) },
  uSunIntensity: { value: LIGHTING.sunIntensity },
  uSunDir: { value: LIGHTING.sunDirection.clone() },
};

export function setThemeUniforms(theme: Theme): void {
  THEME_UNIFORMS.uDay.value = theme === 'daylight' ? 1 : 0;
}

/** GLSL: hemisphere + directional Lambert, tuned so sunlit white roofs just reach white. */
export const STUDIO_LIGHT_GLSL = /* glsl */ `
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uHemiIntensity;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSunDir;
vec3 studioLight(vec3 albedo, vec3 n) {
  n = normalize(n);
  vec3 hemi = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.z) * uHemiIntensity;
  float diffuse = max(dot(n, uSunDir), 0.0);
  return albedo * (hemi * 0.6 + uSunColor * uSunIntensity * diffuse * 0.4);
}
`;

// ---------------------------------------------------------------- 3D palettes
// Daylight = the ArchiMap architectural scale-model look (Phase 9B): alabaster ground, white
// streets with warm-grey edges, muted sage greens, matte #EFEFEF massing (map/basemap.ts ARCHIMAP).
export const DAY = {
  land: '#F8FAFC',
  landBand: '#F0F1EF',
  road: '#FFFFFF',
  roadCasing: '#DDD7CC',
  park: '#A3B19B',
  parkDeep: '#9CAF88',
  waterDeep: '#0E7490',
  waterShallow: '#38BDF8',
  contourMinor: '#E2DDD3',
  contourMajor: '#C9C1B4',
  buildingWall: '#EFEFEF',
  buildingRoof: '#EFEFEF',
  buildingEdge: '#DDD8CF',
  greenRoof: '#9CAF88',
  glassCore: '#F5FCF8',
  glassRim: '#10B981',
  wireEmerald: '#10B981',
  wireSlate: '#64748B',
  // Emerald + sage tree clusters over the sage parks.
  foliage: ['#4E7D57', '#5F8A5B', '#6E9768', '#86A27A'],
  trunk: '#7A6450',
  rain: ['#0284C7', '#0EA5E9'],
} as const;

export const XRAY = {
  land: '#0B1324',
  landHigh: '#1F4E64',
  road: '#1B2638',
  roadCasing: '#26354D',
  contourMinor: '#2C6E8A',
  contourMajor: '#5FD4F4',
  glassCore: '#0F172A',
  glassRim: '#38BDF8',
  foliage: ['#14532D', '#166534', '#15803D', '#1E7A4A'],
} as const;
