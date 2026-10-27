// Manhole / drop-shaft columns: water column up to the node HGL, flooding pulses.
// uNodeState texel: r = HGL (scene z, m), g = is_flooding.
export const shaftVertex = /* glsl */ `
uniform sampler2D uNodeState;
uniform float uPipeScale;
attribute float aNode;
attribute float aKind;
varying float vZ;
varying float vKind;
varying float vIndex;
varying vec4 vState;
void main() {
  vec3 lp = vec3(position.x * uPipeScale, position.y, position.z * uPipeScale);
  vec4 p = instanceMatrix * vec4(lp, 1.0);
  vZ = p.z;
  vKind = aKind;
  vIndex = aNode;
  vState = texelFetch(uNodeState, ivec2(int(aNode + 0.5), 0), 0);
  gl_Position = projectionMatrix * p;
}`;

export const shaftFragment = /* glsl */ `
uniform float uTime;
uniform float uHover;
uniform float uSelected;
uniform float uDay;
varying float vZ;
varying float vKind;
varying float vIndex;
varying vec4 vState;
void main() {
  // kinds: 0 manhole, 1 tunnel station, 2 drop shaft, 3 outfall portal
  float wet = step(vZ, vState.r);
  bool drop = vKind > 1.5 && vKind < 2.5;
  // Dry chamber: frosted glass (daylight) or slate ghost (X-ray); drop shafts read amber.
  vec3 dryDay = drop ? vec3(0.96, 0.62, 0.04) : vec3(0.80, 0.93, 0.89);
  vec3 dryDark = drop ? vec3(0.96, 0.62, 0.04) : vec3(0.39, 0.45, 0.55);
  vec3 dry = mix(dryDark, dryDay, uDay);
  float dryA = vKind > 0.5 && vKind < 1.5 ? 0.10 : (vKind > 1.5 ? 0.45 : mix(0.28, 0.42, uDay));
  float pulse = 0.6 + 0.4 * sin(uTime * 6.0);
  vec3 flood = mix(vec3(0.96, 0.22, 0.63), vec3(0.937, 0.267, 0.267), uDay) * pulse;
  vec3 water = vState.g > 0.5 ? flood : mix(vec3(0.22, 0.74, 0.97), vec3(0.055, 0.647, 0.914), uDay);
  vec3 col = mix(dry, water, wet);
  float alpha = mix(dryA, 0.88, wet);
  float hl = max(1.0 - step(0.5, abs(vIndex - uHover)), 1.0 - step(0.5, abs(vIndex - uSelected)));
  gl_FragColor = vec4(mix(col, uDay > 0.5 ? vec3(0.02, 0.47, 0.34) : vec3(1.0), hl * 0.45), max(alpha, hl * 0.85));
}`;

// Expanding surcharge ring on a manhole lid; aActive 0..1 fades it in above 100 % capacity.
export const ringVertex = /* glsl */ `
uniform float uTime;
uniform float uPipeScale;
attribute float aActive;
attribute float aPhase;
varying float vActive;
varying float vPulse;
varying vec2 vUv2;
void main() {
  vActive = aActive;
  float t = fract(uTime * 0.8 + aPhase);
  vPulse = t;
  float s = (0.6 + 1.6 * t) * mix(1.0, 1.8, step(1.5, uPipeScale));
  vec3 p = vec3(position.xy * s * step(0.001, aActive), position.z);
  gl_Position = projectionMatrix * (instanceMatrix * vec4(p, 1.0));
}`;

export const ringFragment = /* glsl */ `
uniform float uDay;
varying float vActive;
varying float vPulse;
void main() {
  if (vActive <= 0.001) discard;
  float a = vActive * (1.0 - vPulse) * 0.9;
  vec3 hot = mix(vec3(0.96, 0.22, 0.63), vec3(0.937, 0.267, 0.267), uDay);
  vec3 glow = mix(vec3(1.0, 0.85, 0.95), vec3(1.0, 0.80, 0.80), uDay);
  gl_FragColor = vec4(mix(hot, glow, 1.0 - vPulse), a);
}`;
