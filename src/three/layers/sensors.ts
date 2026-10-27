// Edge-AI sensor nodes as surface telemetry markers (Phase 7A): a flat concentric sonar pad
// flush with the street over the manhole, an inverted-teardrop locator pin hovering above the
// grate (a diamond for the Jetson vision node), a dashed tether down to the exact underground
// point the sensor measures, and — when the node is in alarm (>= 80 % full, surcharged or a live
// hardware surge) — expanding red ripples on the street while pad and pin blink
// #DC2626 <-> #FCA5A5 at 3 Hz.
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  OctahedronGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Conduit, Lagoon, Orifice, Sensor } from '../../types/twin';
import { alarmBlink, MARKER_COLORS, markerTone, type MarkerTone } from '../../utils/fullness';
import type { SensorState } from '../../utils/lutInterpolator';
import type { LocalFrame } from '../frame';
import { LIGHT_UNIFORMS, STUDIO_LIGHT_GLSL, THEME_UNIFORMS, type Theme } from '../theme';

/** Marker size multiplier: readable from street zoom up to the catchment overview. */
const MARKER_SCALE = 1.7;
/** Height of the badge anchor / pick segment above the street (m). */
export const MARKER_TOP_M = 11.5;
const PIN_Z_M = 2.2; // teardrop tip above the grate
const RIPPLES = 3;
const RIPPLE_PERIOD_S = 1.4;
const RIPPLE_MAX_M = 11;

export interface SensorBeacon {
  index: number;
  id: string;
  sensor: Sensor;
  measure: Vector3; // underground measurement point (scene m)
  base: Vector3; // street surface over the manhole
  top: Vector3; // badge anchor above the pin
}

export interface SensorsLayer {
  group: Group;
  beacons: SensorBeacon[];
  applyState(states: SensorState[]): void;
  setTheme(theme: Theme): void;
  /** Show / hide the surface markers (the "Node Fullness Badges" layer toggle). */
  setGaugesVisible(on: boolean): void;
  setTime(t: number): void;
  setHover(id: string | null): void;
}

/** Where the sensor actually looks: conduit crown at its outlet, lagoon floor, or rack sill. */
function measurePoint(s: Sensor, conduits: Map<string, Conduit>, lagoon: Lagoon, rack: Orifice, frame: LocalFrame): Vector3 {
  if (s.attached_kind === 'CONDUIT') {
    const c = conduits.get(s.attached_to);
    if (c) {
      const [lng, lat, inv] = c.coordinates[1];
      return frame.toLocal(lng, lat, inv + c.geometry.rise_m);
    }
  }
  if (s.attached_kind === 'STORAGE') return frame.toLocal(s.coordinates[0], s.coordinates[1], lagoon.invert_elev_m);
  return frame.toLocal(rack.coordinates[0], rack.coordinates[1], rack.sill_elev_m + rack.height_m);
}

const pinVertex = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const pinFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uDay;
uniform float uHot;
varying vec3 vNormal;
${STUDIO_LIGHT_GLSL}
void main() {
  vec3 lit = studioLight(uColor, vNormal) * 1.08 + uColor * 0.12;
  vec3 col = mix(uColor * 1.15, lit, uDay);
  gl_FragColor = vec4(mix(col, vec3(1.0), uHot * 0.25), 1.0);
}`;

function teardrop(): BufferGeometry {
  // Inverted teardrop: sphere head over a downward cone whose tip touches PIN_Z_M.
  const head = new SphereGeometry(1.1, 24, 16).translate(0, 0, PIN_Z_M + 3.0);
  const cone = new ConeGeometry(1.02, 2.6, 24, 1, true).rotateX(-Math.PI / 2).translate(0, 0, PIN_Z_M + 1.3);
  return mergeGeometries([head.toNonIndexed(), cone.toNonIndexed()], false)!;
}

function sonarPad(): BufferGeometry {
  const disc = new CircleGeometry(0.95, 32);
  const inner = new RingGeometry(1.55, 1.85, 48);
  const outer = new RingGeometry(2.65, 2.9, 64);
  return mergeGeometries([disc.toNonIndexed(), inner.toNonIndexed(), outer.toNonIndexed()], false)!;
}

export function buildSensors(
  sensors: Sensor[],
  conduits: Conduit[],
  lagoon: Lagoon,
  rack: Orifice,
  frame: LocalFrame,
  _cameraPos: Vector3,
): SensorsLayer {
  const byId = new Map(conduits.map((c) => [c.id, c]));
  const group = new Group();
  group.name = 'sensors';
  const padGeom = sonarPad();
  const pinGeom = teardrop();
  const diamondGeom = new OctahedronGeometry(1.5, 0).scale(1, 1, 1.45).translate(0, 0, PIN_Z_M + 2.2);
  const rippleGeom = new RingGeometry(0.9, 1.0, 64);
  const beacons: SensorBeacon[] = [];
  const parts: {
    marker: Group;
    pin: Mesh;
    pinMat: ShaderMaterial;
    padMat: MeshBasicMaterial;
    ripples: Mesh[];
    rippleMat: MeshBasicMaterial[];
    tether: LineDashedMaterial;
    tone: MarkerTone;
  }[] = [];

  sensors.forEach((s, index) => {
    const isVision = s.hardware === 'JETSON_YOLO_TRASHRACK';
    const base = frame.toLocal(s.coordinates[0], s.coordinates[1], s.coordinates[2]);
    if (s.attached_kind === 'ORIFICE') {
      // Both rack nodes share the rack's coordinates: stand them 6 m either side so the 3 m
      // grate itself stays visible between them.
      const lateral = new Vector3(-base.y, base.x, 0).normalize();
      base.addScaledVector(lateral, isVision ? -6 : 6);
    }
    const top = base.clone().setZ(base.z + MARKER_TOP_M);
    const measure = measurePoint(s, byId, lagoon, rack, frame);
    beacons.push({ index, id: s.sensor_id, sensor: s, measure, base, top });

    const marker = new Group();
    marker.position.copy(base);
    marker.scale.setScalar(MARKER_SCALE);
    const padMat = new MeshBasicMaterial({ color: MARKER_COLORS.normal, transparent: true, opacity: 0.92, side: DoubleSide, depthWrite: false });
    const pad = new Mesh(padGeom, padMat);
    pad.position.z = 0.12;
    pad.renderOrder = 30;
    const pinMat = new ShaderMaterial({
      vertexShader: pinVertex,
      fragmentShader: pinFragment,
      uniforms: { ...LIGHT_UNIFORMS, uDay: THEME_UNIFORMS.uDay, uColor: { value: new Color(MARKER_COLORS.normal) }, uHot: { value: 0 } },
      side: DoubleSide,
    });
    const pin = new Mesh(isVision ? diamondGeom : pinGeom, pinMat);
    pin.renderOrder = 31;
    const ripples: Mesh[] = [];
    const rippleMat: MeshBasicMaterial[] = [];
    for (let k = 0; k < RIPPLES; k++) {
      const m = new MeshBasicMaterial({ color: MARKER_COLORS.alarm, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
      const r = new Mesh(rippleGeom, m);
      r.position.z = 0.1;
      r.renderOrder = 29;
      r.visible = false;
      ripples.push(r);
      rippleMat.push(m);
    }
    marker.add(pad, pin, ...ripples);

    const tetherMat = new LineDashedMaterial({ color: '#334155', dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.7, depthWrite: false });
    const tether = new Line(new BufferGeometry().setFromPoints([measure, base]), tetherMat);
    tether.computeLineDistances();
    tether.renderOrder = 30;
    group.add(marker, tether);
    parts.push({ marker, pin, pinMat, padMat, ripples, rippleMat, tether: tetherMat, tone: 'normal' });
  });
  group.traverse((o) => (o.frustumCulled = false));

  let hovered: string | null = null;
  let theme: Theme = 'daylight';
  const red = new Color(MARKER_COLORS.alarm);
  const light = new Color(MARKER_COLORS.alarmLight);
  const blink = new Color();
  const layer: SensorsLayer = {
    group,
    beacons,
    applyState(states) {
      states.forEach((st, i) => {
        const p = parts[i];
        if (!p) return;
        p.tone = markerTone(st);
        if (p.tone !== 'alarm') {
          p.padMat.color.set(MARKER_COLORS[p.tone]);
          p.pinMat.uniforms.uColor.value.set(MARKER_COLORS[p.tone]);
        }
        p.tether.color.set(p.tone === 'alarm' ? MARKER_COLORS.alarm : theme === 'daylight' ? '#334155' : '#94A3B8');
        for (const r of p.ripples) r.visible = p.tone === 'alarm';
      });
    },
    setTheme(t) {
      theme = t;
      for (const p of parts) {
        p.padMat.blending = t === 'daylight' ? NormalBlending : AdditiveBlending;
        p.padMat.needsUpdate = true;
      }
    },
    setGaugesVisible(on) {
      for (const p of parts) p.marker.visible = on;
    },
    setTime(t) {
      blink.copy(red).lerp(light, alarmBlink(t));
      parts.forEach((p, i) => {
        const hot = beacons[i].id === hovered;
        p.pinMat.uniforms.uHot.value = hot ? 1 : 0;
        p.marker.scale.setScalar(MARKER_SCALE * (hot ? 1.2 : 1));
        p.pin.position.z = 0.35 * Math.sin(t * 2.2 + i);
        p.pin.rotation.z = t * 0.8;
        if (p.tone !== 'alarm') return;
        p.padMat.color.copy(blink);
        p.pinMat.uniforms.uColor.value.copy(blink);
        p.ripples.forEach((r, k) => {
          const f = (t / RIPPLE_PERIOD_S + k / RIPPLES) % 1;
          const radius = 2.2 + f * (RIPPLE_MAX_M - 2.2);
          r.scale.set(radius, radius, 1);
          p.rippleMat[k].opacity = 0.85 * (1 - f) * (1 - f);
        });
      });
    },
    setHover(id) {
      hovered = id;
    },
  };
  return layer;
}
