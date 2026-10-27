import {
  BufferGeometry,
  CircleGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  ShaderMaterial,
  Shape,
  Vector2,
  type Vector3,
} from 'three';
import type { Lagoon } from '../../types/twin';
import type { LagoonState } from '../../utils/lutInterpolator';
import { Z_REF_M, type LocalFrame } from '../frame';
import { waterFragment, waterVertex } from '../shaders/water';
import { LIGHT_UNIFORMS, THEME_UNIFORMS, type Theme } from '../theme';

export interface LagoonLayer {
  group: Group;
  applyState(L: LagoonState): void;
  setTheme(theme: Theme): void;
  setRain(mmHr: number): void;
  setTime(t: number): void;
}

/** Plan-scale of the frustum bowl at depth h: sqrt(A(h) / A_rim) from the stage-storage table. */
function planScale(lag: Lagoon, depth: number): number {
  const t = lag.stage_storage;
  if (depth >= lag.max_depth_m) return 1;
  for (let i = 1; i < t.length; i++) {
    if (depth <= t[i].depth_m) {
      const f = (depth - t[i - 1].depth_m) / (t[i].depth_m - t[i - 1].depth_m);
      const area = t[i - 1].surface_area_m2 + f * (t[i].surface_area_m2 - t[i - 1].surface_area_m2);
      return Math.sqrt(area / lag.area_m2);
    }
  }
  return 1;
}

export function buildLagoon(lag: Lagoon, frame: LocalFrame, cameraPos: Vector3): LagoonLayer {
  const rim: Vector3[] = lag.polygon[0].slice(0, -1).map(([lng, lat]) => frame.toLocal(lng, lat));
  const invertZ = lag.invert_elev_m - Z_REF_M;
  const rimZ = lag.rim_elev_m - Z_REF_M;
  const group = new Group();
  group.name = 'lagoon';

  // Bowl walls (frustum from rim to floor) + 1 m stage rings as a depth gauge.
  const floorK = planScale(lag, 0);
  const wall: number[] = [];
  for (let i = 0; i < rim.length; i++) {
    const p = rim[i];
    const q = rim[(i + 1) % rim.length];
    wall.push(p.x, p.y, rimZ, q.x, q.y, rimZ, q.x * floorK, q.y * floorK, invertZ);
    wall.push(p.x, p.y, rimZ, q.x * floorK, q.y * floorK, invertZ, p.x * floorK, p.y * floorK, invertZ);
  }
  const wallGeom = new BufferGeometry();
  wallGeom.setAttribute('position', new Float32BufferAttribute(wall, 3));
  const walls = new Mesh(
    wallGeom,
    new MeshBasicMaterial({ color: '#1E293B', transparent: true, opacity: 0.35, depthWrite: false, side: DoubleSide }),
  );
  walls.renderOrder = 3;
  group.add(walls);
  const stageLoops: { mat: LineBasicMaterial; isRim: boolean }[] = [];
  for (let d = 0; d <= lag.max_depth_m + 1e-6; d += 1) {
    const k = planScale(lag, d);
    const z = invertZ + d;
    const g = new BufferGeometry().setFromPoints(rim.map((p) => p.clone().set(p.x * k, p.y * k, z)));
    const isRim = Math.abs(d - lag.max_depth_m) < 0.6;
    const mat = new LineBasicMaterial({ color: isRim ? '#38BDF8' : '#334155', transparent: true, opacity: isRim ? 0.8 : 0.5 });
    stageLoops.push({ mat, isRim });
    const loop = new LineLoop(g, mat);
    loop.renderOrder = 4;
    group.add(loop);
  }

  // Water volume: rim-shaped prism of unit height, rescaled per scenario.
  const shape = new Shape(rim.map((p) => new Vector2(p.x, p.y)));
  const waterMat = new ShaderMaterial({
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    uniforms: { uTime: { value: 0 }, uOverflow: { value: 0 }, uRain: { value: 0 }, uDay: THEME_UNIFORMS.uDay, uCameraPos: { value: cameraPos }, ...LIGHT_UNIFORMS },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  const water = new Mesh(new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false }), waterMat);
  water.position.z = invertZ;
  water.renderOrder = 15;
  group.add(water);

  // Overflow inundation: expanding crimson ring + faint disc at the equivalent radius.
  const flood = new Group();
  flood.position.z = rimZ + 0.4;
  const ringMat = new MeshBasicMaterial({ color: '#DC2626', transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide });
  const pulseMat = ringMat.clone();
  const discMat = new MeshBasicMaterial({ color: '#DC2626', transparent: true, opacity: 0.07, depthWrite: false, side: DoubleSide });
  const ring = new Mesh(new RingGeometry(0.985, 1, 160), ringMat);
  const pulse = new Mesh(new RingGeometry(0.97, 1, 160), pulseMat);
  const disc = new Mesh(new CircleGeometry(1, 160), discMat);
  ring.renderOrder = pulse.renderOrder = disc.renderOrder = 16;
  flood.add(disc, ring, pulse);
  flood.visible = false;
  group.add(flood);
  group.traverse((o) => (o.frustumCulled = false));

  let radius = 0;
  const wallMat = walls.material as MeshBasicMaterial;
  return {
    group,
    setTheme(theme) {
      const day = theme === 'daylight';
      // Daylight: pale limestone bowl with sage stage rings; X-ray: the original slate.
      wallMat.color.set(day ? '#DCE7DF' : '#1E293B');
      wallMat.opacity = day ? 0.75 : 0.35;
      for (const l of stageLoops) {
        l.mat.color.set(l.isRim ? (day ? '#0E7490' : '#38BDF8') : day ? '#9FB8AE' : '#334155');
        l.mat.opacity = l.isRim ? 0.9 : day ? 0.6 : 0.5;
      }
      ringMat.color.set(day ? '#EF4444' : '#DC2626');
      pulseMat.color.set(day ? '#EF4444' : '#DC2626');
      discMat.opacity = day ? 0.1 : 0.07;
    },
    setRain(mmHr) {
      waterMat.uniforms.uRain.value = mmHr <= 0.05 ? 0 : Math.min(0.1 + mmHr / 220, 1);
    },
    applyState(L) {
      const depth = Math.max(L.depthM, 0.02);
      const k = planScale(lag, depth);
      water.scale.set(k, k, depth);
      // Calm teal -> crimson over the first 15 cm above the 6.5 m rim (1433.0 m ASL).
      const over = Math.min(Math.max((depth - lag.max_depth_m) / 0.15, 0), 1);
      waterMat.uniforms.uOverflow.value = over;
      flood.visible = L.isOverflowing;
      radius = L.inundationRadiusM;
      flood.scale.set(radius, radius, 1);
    },
    setTime(t) {
      waterMat.uniforms.uTime.value = t;
      if (flood.visible) {
        const phase = (t * 0.35) % 1;
        pulse.scale.setScalar(0.55 + 0.45 * phase);
        pulseMat.opacity = 0.7 * (1 - phase);
        ringMat.opacity = 0.55 + 0.35 * Math.sin(t * 4);
      }
    },
  };
}
