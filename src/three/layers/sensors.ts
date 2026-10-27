// Edge-AI sensor nodes as per-node 3D water-level gauges: a translucent Fresnel glass
// manhole column with a rising, capacity-coloured water column inside, an anomaly-coloured
// crown ring, and a dashed tether down to the exact underground point the sensor measures.
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Conduit, Lagoon, Orifice, Sensor } from '../../types/twin';
import { nodeFullnessPct } from '../../utils/fullness';
import type { SensorState } from '../../utils/lutInterpolator';
import { ANOMALY_COLORS, capacityColor } from '../palette';
import type { LocalFrame } from '../frame';
import { LIGHT_UNIFORMS, STUDIO_LIGHT_GLSL, THEME_UNIFORMS, type Theme } from '../theme';

export const GAUGE_HEIGHT_M = 14;
const GAUGE_RADIUS_M = 2.0;

export interface SensorBeacon {
  index: number;
  id: string;
  sensor: Sensor;
  measure: Vector3; // underground measurement point (scene m)
  base: Vector3; // surface mount
  top: Vector3; // gauge crown (badge anchor)
}

export interface SensorsLayer {
  group: Group;
  beacons: SensorBeacon[];
  applyState(states: SensorState[]): void;
  setTheme(theme: Theme): void;
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

const glassVertex = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const glassFragment = /* glsl */ `
uniform float uDay;
uniform vec3 uCameraPos;
uniform float uHot;
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vec3 V = normalize(uCameraPos - vPos);
  float fresnel = pow(1.0 - clamp(abs(dot(V, normalize(vNormal))), 0.0, 1.0), 2.6);
  vec3 core = mix(vec3(0.06, 0.10, 0.17), vec3(0.96, 0.99, 0.97), uDay);
  vec3 rim = mix(vec3(0.22, 0.74, 0.97), vec3(0.06, 0.72, 0.50), uDay);
  vec3 col = mix(core, rim, fresnel * 0.85);
  float alpha = clamp(0.14 + fresnel * 0.42 + uHot * 0.12, 0.10, 0.62);
  gl_FragColor = vec4(mix(col, vec3(1.0), uHot * 0.3), alpha);
}`;

const waterFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uPulse;
uniform float uTime;
uniform float uDay;
varying vec3 vPos;
varying vec3 vNormal;
${STUDIO_LIGHT_GLSL}
void main() {
  float beat = 1.0 - uPulse * (0.35 + 0.35 * sin(uTime * 6.0));
  vec3 lit = studioLight(uColor, vNormal) * 1.12;
  vec3 glow = uColor * 1.05;
  gl_FragColor = vec4(mix(glow, lit, uDay) * beat, 0.92);
}`;

export function buildSensors(
  sensors: Sensor[],
  conduits: Conduit[],
  lagoon: Lagoon,
  rack: Orifice,
  frame: LocalFrame,
  cameraPos: Vector3,
): SensorsLayer {
  const byId = new Map(conduits.map((c) => [c.id, c]));
  const group = new Group();
  group.name = 'sensors';
  const shellGeom = new CylinderGeometry(GAUGE_RADIUS_M, GAUGE_RADIUS_M, GAUGE_HEIGHT_M, 32, 1, false)
    .rotateX(Math.PI / 2)
    .translate(0, 0, GAUGE_HEIGHT_M / 2);
  // Unit-height water column (scaled in z by fullness).
  const waterGeom = new CylinderGeometry(GAUGE_RADIUS_M * 0.8, GAUGE_RADIUS_M * 0.8, 1, 28, 1, false).rotateX(Math.PI / 2).translate(0, 0, 0.5);
  const crownGeom = new RingGeometry(GAUGE_RADIUS_M * 1.05, GAUGE_RADIUS_M * 1.45, 40);
  const markerGeom = new SphereGeometry(1.1, 18, 12);
  const beacons: SensorBeacon[] = [];
  const parts: {
    root: Group;
    gauge: Group;
    water: Mesh;
    waterMat: ShaderMaterial;
    shellMat: ShaderMaterial;
    crownMat: MeshBasicMaterial;
    markerMat: MeshBasicMaterial;
    tether: LineDashedMaterial;
    fill: number;
  }[] = [];

  sensors.forEach((s, index) => {
    const isVision = s.hardware === 'JETSON_YOLO_TRASHRACK';
    const base = frame.toLocal(s.coordinates[0], s.coordinates[1], s.coordinates[2]);
    if (s.attached_kind === 'ORIFICE') {
      // Both rack nodes share the rack's coordinates: stand the gauges 6 m either side so the
      // 3 m grate itself stays visible between them.
      const lateral = new Vector3(-base.y, base.x, 0).normalize();
      base.addScaledVector(lateral, isVision ? -6 : 6);
    }
    const top = base.clone().setZ(base.z + GAUGE_HEIGHT_M);
    const measure = measurePoint(s, byId, lagoon, rack, frame);
    beacons.push({ index, id: s.sensor_id, sensor: s, measure, base, top });

    const root = new Group();
    root.position.copy(base);
    const gauge = new Group();
    const shellMat = new ShaderMaterial({
      vertexShader: glassVertex,
      fragmentShader: glassFragment,
      uniforms: { uDay: THEME_UNIFORMS.uDay, uCameraPos: { value: cameraPos }, uHot: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    const waterMat = new ShaderMaterial({
      vertexShader: glassVertex,
      fragmentShader: waterFragment,
      uniforms: { ...LIGHT_UNIFORMS, uDay: THEME_UNIFORMS.uDay, uColor: { value: new Color('#10B981') }, uPulse: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      side: DoubleSide,
    });
    const water = new Mesh(waterGeom, waterMat);
    water.scale.set(1, 1, 0.001);
    water.renderOrder = 28;
    const shell = new Mesh(shellGeom, shellMat);
    shell.renderOrder = 29;
    const crownMat = new MeshBasicMaterial({ color: '#16A34A', transparent: true, opacity: 0.95, side: DoubleSide, depthWrite: false });
    const crown = new Mesh(crownGeom, crownMat);
    crown.position.z = GAUGE_HEIGHT_M + 0.05;
    crown.renderOrder = 30;
    gauge.add(water, shell, crown);

    const markerMat = new MeshBasicMaterial({ color: '#16A34A', transparent: true, opacity: 0.95, depthWrite: false });
    const marker = new Mesh(isVision ? new SphereGeometry(1.1, 4, 2) : markerGeom, markerMat); // octahedral head for the camera node
    marker.position.z = 0.6;
    marker.renderOrder = 30;
    root.add(gauge, marker);

    const tetherMat = new LineDashedMaterial({ color: '#334155', dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.8, depthWrite: false });
    const tether = new Line(new BufferGeometry().setFromPoints([measure, base]), tetherMat);
    tether.computeLineDistances();
    tether.renderOrder = 30;
    group.add(root, tether);
    parts.push({ root, gauge, water, waterMat, shellMat, crownMat, markerMat, tether: tetherMat, fill: 0 });
  });
  group.traverse((o) => (o.frustumCulled = false));

  let hovered: string | null = null;
  let theme: Theme = 'daylight';
  let last: SensorState[] = [];
  const white = new Color('#FFFFFF');
  const layer: SensorsLayer = {
    group,
    beacons,
    applyState(states) {
      last = states;
      states.forEach((st, i) => {
        const p = parts[i];
        if (!p) return;
        const pct = nodeFullnessPct(st);
        p.fill = Math.min(pct / 100, 1);
        p.water.scale.set(1, 1, Math.max(p.fill * GAUGE_HEIGHT_M, 0.02));
        p.waterMat.uniforms.uColor.value.set(capacityColor(pct / 100, theme));
        p.waterMat.uniforms.uPulse.value = pct > 94 ? 1 : 0;
        const anomaly = new Color(ANOMALY_COLORS[st.anomaly]);
        p.crownMat.color.copy(anomaly);
        p.markerMat.color.copy(anomaly);
        p.tether.color.copy(anomaly).lerp(theme === 'daylight' ? new Color('#334155') : white, 0.45);
      });
    },
    setTheme(t) {
      theme = t;
      for (const p of parts) {
        p.crownMat.blending = t === 'daylight' ? NormalBlending : AdditiveBlending;
        p.markerMat.blending = p.crownMat.blending;
        p.crownMat.needsUpdate = true;
        p.markerMat.needsUpdate = true;
      }
      if (last.length) layer.applyState(last);
    },
    setGaugesVisible(on) {
      for (const p of parts) p.gauge.visible = on;
    },
    setTime(t) {
      parts.forEach((p, i) => {
        p.waterMat.uniforms.uTime.value = t;
        const hot = beacons[i].id === hovered;
        p.shellMat.uniforms.uHot.value = hot ? 1 : 0;
        p.root.scale.setScalar(hot ? 1.18 : 1);
        p.root.children[1].scale.setScalar(1 + 0.18 * Math.sin(t * 3 + i));
      });
    },
    setHover(id) {
      hovered = id;
    },
  };
  return layer;
}
