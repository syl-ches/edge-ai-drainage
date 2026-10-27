// City Camp Lagoon water body.
// Daylight: deep #0E7490 -> shallow #38BDF8 teal-blue with sun glints and raindrop splash
// rings; X-ray: the original calm teal. Both pulse crimson above the 1433.0 m rim.
export const waterVertex = /* glsl */ `
varying vec3 vWorld;
varying float vTop;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vTop = step(0.999, position.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const waterFragment = /* glsl */ `
uniform float uTime;
uniform float uOverflow;
uniform float uRain;
uniform float uDay;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
varying vec3 vWorld;
varying float vTop;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float ripple = sin(vWorld.x * 0.16 + uTime * 1.1) * sin(vWorld.y * 0.13 - uTime * 1.4)
               + 0.5 * sin((vWorld.x + vWorld.y) * 0.37 + uTime * 2.3);
  // Raindrop splash rings: 3 m cells, random phase, density follows rainfall.
  vec2 cell = floor(vWorld.xy / 3.0);
  float rnd = hash(cell);
  float life = fract(uTime * 1.1 + rnd * 9.0);
  vec2 c = (vec2(hash(cell + 1.7), hash(cell + 4.3)) - 0.5) * 0.6;
  float d = length(fract(vWorld.xy / 3.0) - 0.5 - c) * 3.0;
  float splash = (1.0 - smoothstep(0.0, 0.12, abs(d - life * 1.3))) * (1.0 - life) * step(rnd, uRain) * vTop;

  // Daylight palette with a Fresnel-ish shallow rim and sun glints.
  vec3 V = normalize(uCameraPos - vWorld);
  float facing = clamp(V.z, 0.0, 1.0);
  vec3 deepDay = vec3(0.055, 0.455, 0.565);     // #0E7490
  vec3 shallowDay = vec3(0.220, 0.741, 0.973);  // #38BDF8
  vec3 day = mix(shallowDay, deepDay, 0.35 + 0.45 * facing) + 0.06 * ripple * vTop;
  vec3 n = normalize(vec3(0.08 * cos(vWorld.x * 0.4 + uTime * 1.7), 0.08 * sin(vWorld.y * 0.35 - uTime * 1.3), 1.0));
  float spec = pow(max(dot(reflect(-uSunDir, n), V), 0.0), 48.0) * vTop;
  day += vec3(1.0, 0.98, 0.9) * spec * 0.9;
  day = mix(day, vec3(0.92, 0.98, 1.0), splash * 0.85);

  vec3 deepDark = vec3(0.02, 0.32, 0.33);
  vec3 shallowDark = vec3(0.10, 0.72, 0.66);
  vec3 dark = mix(deepDark, shallowDark, 0.55 + 0.18 * ripple * vTop);
  dark += vTop * smoothstep(1.15, 1.45, ripple) * 0.35 + splash * 0.4;

  vec3 col = mix(dark, day, uDay);
  // Overflow: pulsing crimson with choppier ripples.
  vec3 crimson = vec3(0.86, 0.08, 0.2);
  float pulse = 0.6 + 0.4 * sin(uTime * 4.0);
  col = mix(col, crimson * (0.75 + 0.35 * pulse) + vTop * 0.12 * ripple, uOverflow * 0.85);
  float alpha = mix(mix(0.32, 0.56, vTop), mix(0.55, 0.82, vTop), uDay) + uOverflow * 0.12;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
}`;
