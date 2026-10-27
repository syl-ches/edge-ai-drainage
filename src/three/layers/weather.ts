import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineSegments,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { THEME_UNIFORMS } from '../theme';

export const RAIN_STREAKS = 6000;

// All motion happens on the GPU: each streak's fall phase is fract(seed + t·speed), its
// plan position is world-locked and tiled around the camera focus with mod(), and the
// visible count is gated by comparing a per-streak random to uDensity. The CPU only
// writes ~8 uniforms per frame.
const rainVertex = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform float uBox;
uniform float uHeight;
uniform float uSpeed;
uniform float uLen;
uniform vec2 uWind;
uniform float uDensity;
attribute vec4 aSeed;   // x, y: plan position 0..1; z: fall phase; w: density rank / speed jitter
attribute float aEnd;   // 0 = head, 1 = tail
varying float vAlpha;
varying float vHue;
void main() {
  vHue = aSeed.w;
  float fall = fract(aSeed.z + uTime * uSpeed * (0.85 + 0.3 * aSeed.w));
  float h = uHeight * (1.0 - fall);
  vec2 origin = uCenter.xy - 0.5 * uBox;
  vec2 xy = origin + mod(aSeed.xy * uBox - origin, uBox) + uWind * h;
  vec3 p = vec3(xy, uCenter.z + h);
  p += normalize(vec3(uWind, 1.0)) * uLen * aEnd;
  float visible = step(aSeed.w, uDensity);
  vAlpha = visible * mix(1.0, 0.0, aEnd) * smoothstep(0.0, 0.06, fall) * smoothstep(1.0, 0.85, fall);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const rainFragment = /* glsl */ `
uniform float uOpacity;
uniform float uDay;
varying float vAlpha;
varying float vHue;
void main() {
  if (vAlpha <= 0.002) discard;
  // Daylight: high-visibility cobalt / sky-blue streaks (#0284C7, #0EA5E9) on the white city.
  vec3 day = mix(vec3(0.008, 0.518, 0.780), vec3(0.055, 0.647, 0.914), vHue);
  vec3 col = mix(vec3(0.72, 0.84, 1.0), day, uDay);
  gl_FragColor = vec4(col, vAlpha * uOpacity);
}`;

// Full-screen storm veil drawn first in the 3D layer: X-ray darkens the basemap; daylight
// stays high-key with only a faint, bright overcast haze.
const darkVertex = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const darkFragment = /* glsl */ `
uniform float uDark;
uniform float uDay;
void main() {
  vec3 col = mix(vec3(0.015, 0.025, 0.05), vec3(0.90, 0.94, 0.97), uDay);
  gl_FragColor = vec4(col, uDark * mix(1.0, 0.28, uDay));
}`;

export interface WeatherLayer {
  group: Group;
  setRain(mmHr: number): void;
  update(time: number, focus: Vector3, cameraDistanceM: number): void;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWeather(): WeatherLayer {
  const rand = mulberry32(20240917);
  const seeds = new Float32Array(RAIN_STREAKS * 2 * 4);
  const ends = new Float32Array(RAIN_STREAKS * 2);
  for (let i = 0; i < RAIN_STREAKS; i++) {
    const s = [rand(), rand(), rand(), rand()];
    seeds.set(s, i * 8);
    seeds.set(s, i * 8 + 4);
    ends[i * 2] = 0;
    ends[i * 2 + 1] = 1;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(RAIN_STREAKS * 2 * 3), 3));
  geom.setAttribute('aSeed', new BufferAttribute(seeds, 4));
  geom.setAttribute('aEnd', new BufferAttribute(ends, 1));

  const uniforms = {
    uTime: { value: 0 },
    uCenter: { value: new Vector3() },
    uBox: { value: 600 },
    uHeight: { value: 300 },
    uSpeed: { value: 1 },
    uLen: { value: 6 },
    uWind: { value: new Vector2() },
    uDensity: { value: 0 },
    uOpacity: { value: 0 },
    uDay: THEME_UNIFORMS.uDay,
  };
  const rain = new LineSegments(
    geom,
    new ShaderMaterial({ vertexShader: rainVertex, fragmentShader: rainFragment, uniforms, transparent: true, depthWrite: false }),
  );
  rain.frustumCulled = false;
  rain.renderOrder = 40;

  const darkUniforms = { uDark: { value: 0 }, uDay: THEME_UNIFORMS.uDay };
  const dark = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      vertexShader: darkVertex,
      fragmentShader: darkFragment,
      uniforms: darkUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  dark.frustumCulled = false;
  dark.renderOrder = -100;

  const group = new Group();
  group.name = 'weather';
  group.add(dark, rain);

  // Typhoon winds over Baguio come mostly from the ENE; streaks slant toward the WSW.
  const windDir = new Vector2(-Math.cos(Math.PI / 8), -Math.sin(Math.PI / 8));
  let k = 0;
  return {
    group,
    setRain(mmHr) {
      k = Math.min(Math.max(mmHr / 250, 0), 1);
      uniforms.uDensity.value = mmHr <= 0.05 ? 0 : Math.min(0.04 + Math.pow(k, 0.75), 1);
      uniforms.uOpacity.value = THEME_UNIFORMS.uDay.value > 0.5 ? 0.65 : 0.22 + 0.5 * k;
      (uniforms.uWind.value as Vector2).copy(windDir).multiplyScalar(0.04 + 0.5 * k * k);
      darkUniforms.uDark.value = 0.5 * Math.pow(k, 0.8);
      rain.visible = mmHr > 0.05;
    },
    update(time, focus, cameraDistanceM) {
      const box = Math.min(Math.max(cameraDistanceM * 1.15, 40), 2200);
      uniforms.uTime.value = time;
      (uniforms.uCenter.value as Vector3).set(focus.x, focus.y, focus.z - box * 0.05);
      uniforms.uBox.value = box;
      uniforms.uHeight.value = box * 0.55;
      uniforms.uSpeed.value = 0.9 + 1.4 * k;
      uniforms.uLen.value = box * (0.012 + 0.02 * k);
    },
  };
}
