// Dual-shell "see-through" conduits (CLAUDE.md §11):
//   CORE  — opaque luminous water volume, inset 10 % inside the wall, clipped at the live
//           water surface (depth/rise) with a velocity-driven wave, capacity-ramp colour and
//           downstream chevrons;
//   SHELL — translucent Schlick-Fresnel glass wall showing the true cross-section;
//   EDGE  — crisp structural outlines (box haunches, arch springing lines).
// Shared by swept (RECT_CLOSED / ARCH, define SWEPT) and instanced (CIRCULAR) geometry.
// Per-conduit state texel: r = capacity_ratio, g = velocity_ms, b = depth/rise, a = status code.
import { RAMP_GLSL } from './ramp';

const header = /* glsl */ `
uniform sampler2D uState;
uniform float uPipeScale;
uniform float uTime;
uniform float uHover;
uniform float uSelected;
uniform float uFlowSpeed;
uniform float uDay;
uniform vec3 uCameraPos;
`;

const varyings = /* glsl */ `
varying float vU;
varying float vT;
varying float vS;
varying float vIndex;
varying vec4 vState;
varying vec3 vNormal;
varying vec3 vWorld;
`;

export const conduitVertex = /* glsl */ `
${header}
${varyings}
attribute float aConduit;
#ifdef SWEPT
attribute vec3 aCenter;
attribute float aU;
attribute float aT;
attribute float aS;
#else
attribute float aLength;
#endif
void main() {
#ifdef CORE
  float inset = 0.9;
#else
  float inset = 1.0;
#endif
  vec3 p;
#ifdef SWEPT
  p = aCenter + (position - aCenter) * uPipeScale * inset;
  vU = aU; vT = aT; vS = aS;
  vNormal = normal;
#else
  vec3 lp = vec3(position.x * uPipeScale * inset, position.y, position.z * uPipeScale * inset);
  p = (instanceMatrix * vec4(lp, 1.0)).xyz;
  vU = position.y * aLength; vT = position.z + 0.5; vS = position.x;
  vNormal = normalize(mat3(instanceMatrix) * normal);
#endif
  vIndex = aConduit;
  vWorld = p;
  vState = texelFetch(uState, ivec2(int(aConduit + 0.5), 0), 0);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const highlight = /* glsl */ `
float highlightOf(float idx) {
  return max(1.0 - step(0.5, abs(idx - uHover)), 1.0 - step(0.5, abs(idx - uSelected)));
}`;

export const conduitCoreFragment = /* glsl */ `
${header}
${varyings}
${RAMP_GLSL}
${highlight}
void main() {
  float cap = vState.r;
  float vel = vState.g;
  float fill = clamp(vState.b, 0.0, 1.0);
  bool surge = cap > 0.94 || vState.a > 2.5;
  // Free-surface wave: faster, taller ripples at higher velocity; flat when pressurized.
  float amp = fill >= 0.999 ? 0.0 : 0.012 + 0.035 * clamp(vel / 6.0, 0.0, 1.0);
  float level = fill + amp * sin(vU * 0.9 - uTime * (1.5 + vel * 2.2) + vS * 6.0);
  if (fill < 0.004 || vT > level) discard;

  vec3 base = capacityRamp(surge ? 1.0 : cap, uDay);
  float pulse = surge ? 0.62 + 0.38 * sin(uTime * 6.0) : 1.0;
  float spacing = 7.0;
  float phase = fract((vU + abs(vS) * 3.0) / spacing - uTime * vel * uFlowSpeed / spacing);
  float chevron = smoothstep(0.0, 0.05, phase) * (1.0 - smoothstep(0.12, 0.24, phase)) * step(0.03, vel);
  float depthShade = mix(0.72, 1.06, clamp(vT / max(level, 0.001), 0.0, 1.0));
  vec3 col = base * depthShade * pulse + chevron * mix(base, vec3(1.0), 0.55) * 0.6;
  col = mix(col, vec3(1.0), highlightOf(vIndex) * 0.35);
  gl_FragColor = vec4(col, 1.0);
}`;

export const conduitShellFragment = /* glsl */ `
${header}
${varyings}
${RAMP_GLSL}
${highlight}
void main() {
  vec3 V = normalize(uCameraPos - vWorld);
  float fresnel = pow(1.0 - clamp(abs(dot(normalize(vNormal), V)), 0.0, 1.0), 2.6);
  bool surge = vState.r > 0.94 || vState.a > 2.5;
  vec3 status = capacityRamp(surge ? 1.0 : vState.r, uDay);
  // Daylight: frosted #E2F8F0 glass with an emerald rim; X-ray: dark glass with a status rim.
  vec3 core = mix(vec3(0.07, 0.11, 0.18), vec3(0.886, 0.973, 0.941), uDay);
  vec3 rim = mix(status, vec3(0.06, 0.72, 0.50), uDay * (surge ? 0.0 : 1.0));
  vec3 col = mix(core, rim, fresnel * 0.85);
  float alpha = mix(0.08, 0.16, uDay) + fresnel * mix(0.38, 0.42, uDay);
  if (surge) alpha += 0.12 * (0.5 + 0.5 * sin(uTime * 6.0));
  float hl = highlightOf(vIndex);
  col = mix(col, vec3(1.0), hl * 0.5);
  gl_FragColor = vec4(col, clamp(max(alpha, hl * 0.55), 0.06, 0.62));
}`;

export const conduitEdgeFragment = /* glsl */ `
${header}
${varyings}
${RAMP_GLSL}
${highlight}
void main() {
  bool surge = vState.r > 0.94 || vState.a > 2.5;
  vec3 status = capacityRamp(surge ? 1.0 : vState.r, uDay);
  vec3 col = mix(mix(status, vec3(1.0), 0.45), mix(vec3(0.39, 0.45, 0.55), status, 0.35), uDay);
  float hl = highlightOf(vIndex);
  gl_FragColor = vec4(mix(col, uDay > 0.5 ? vec3(0.02, 0.47, 0.34) : vec3(1.0), hl * 0.6), mix(0.55, 0.7, uDay) + 0.3 * hl);
}`;
