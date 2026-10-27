// Capacity colour ramps in GLSL — must match DAY_BANDS / XRAY_BANDS in src/three/palette.ts.
export const RAMP_GLSL = /* glsl */ `
vec3 rampDay(float c) {
  if (c <= 0.45) return mix(vec3(0.0627, 0.7255, 0.5059), vec3(0.0235, 0.7137, 0.8314), c / 0.45); // #10B981 -> #06B6D4
  if (c <= 0.75) return mix(vec3(0.5176, 0.8000, 0.0863), vec3(0.9608, 0.6196, 0.0431), (c - 0.45) / 0.30); // #84CC16 -> #F59E0B
  if (c <= 0.94) return vec3(0.9765, 0.4510, 0.0863);   // #F97316
  return vec3(0.9373, 0.2667, 0.2667);                  // #EF4444
}
vec3 rampXray(float c) {
  if (c <= 0.40) return vec3(0.0706, 0.7098, 0.7961);   // #12B5CB
  if (c <= 0.75) return vec3(0.9882, 0.7882, 0.2039);   // #FCC934
  if (c <= 0.94) return vec3(0.9804, 0.5647, 0.2431);   // #FA903E
  return vec3(0.9608, 0.2196, 0.6275);                  // #F538A0
}
vec3 capacityRamp(float c, float day) { return day > 0.5 ? rampDay(c) : rampXray(c); }
`;
