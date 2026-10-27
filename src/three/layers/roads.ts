import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial } from 'three';
import type { Conduit } from '../../types/twin';
import { Z_REF_M, type LocalFrame } from '../frame';
import { DAY, XRAY, type Theme } from '../theme';

const STEP_M = 8;

export interface RoadsLayer {
  group: Group;
  setTheme(theme: Theme): void;
}

/**
 * Street corridors draped on the DEM along the (synthetic) road alignments the surface
 * culverts follow: a #D9DDD2 carriageway on a wider #FFFFFF casing. Arterials 9 m, feeders 6 m.
 */
export function buildRoads(conduits: Conduit[], frame: LocalFrame, sampleElevation: (x: number, y: number) => number): RoadsLayer {
  const carriage: number[] = [];
  const casing: number[] = [];
  const strip = (out: number[], ax: number, ay: number, bx: number, by: number, half: number, lift: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1) return;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const px = -uy * half;
    const py = ux * half;
    const steps = Math.max(1, Math.ceil(len / STEP_M));
    // Extend 40 % of the half-width past each end so joints between segments stay closed.
    const ext = half * 0.4;
    for (let s = 0; s < steps; s++) {
      const t0 = -ext / len + (s / steps) * (1 + (2 * ext) / len);
      const t1 = -ext / len + ((s + 1) / steps) * (1 + (2 * ext) / len);
      const x0 = ax + (bx - ax) * t0;
      const y0 = ay + (by - ay) * t0;
      const x1 = ax + (bx - ax) * t1;
      const y1 = ay + (by - ay) * t1;
      const z0 = sampleElevation(x0, y0) - Z_REF_M + lift;
      const z1 = sampleElevation(x1, y1) - Z_REF_M + lift;
      out.push(
        x0 - px, y0 - py, z0, x1 - px, y1 - py, z1, x1 + px, y1 + py, z1,
        x0 - px, y0 - py, z0, x1 + px, y1 + py, z1, x0 + px, y0 + py, z0,
      );
    }
  };
  for (const c of conduits) {
    if (c.network === 'TUNNEL') continue;
    const a = frame.toLocal(c.coordinates[0][0], c.coordinates[0][1]);
    const b = frame.toLocal(c.coordinates[1][0], c.coordinates[1][1]);
    const half = c.network === 'ARTERIAL' ? 4.5 : 3.0;
    strip(casing, a.x, a.y, b.x, b.y, half + 1.4, 0.3);
    strip(carriage, a.x, a.y, b.x, b.y, half, 0.45);
  }
  const mesh = (data: number[], order: number) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(data, 3));
    const m = new Mesh(g, new MeshBasicMaterial({ transparent: true, depthWrite: false }));
    m.renderOrder = order;
    m.frustumCulled = false;
    return m;
  };
  const casingMesh = mesh(casing, 3);
  const roadMesh = mesh(carriage, 4);
  const group = new Group();
  group.name = 'roads';
  group.add(casingMesh, roadMesh);
  const layer: RoadsLayer = {
    group,
    setTheme(theme) {
      const day = theme === 'daylight';
      const cm = casingMesh.material as MeshBasicMaterial;
      const rm = roadMesh.material as MeshBasicMaterial;
      cm.color.set(day ? DAY.roadCasing : XRAY.roadCasing);
      rm.color.set(day ? DAY.road : XRAY.road);
      cm.opacity = day ? 1 : 0.35;
      rm.opacity = day ? 0.96 : 0.45;
    },
  };
  layer.setTheme('daylight');
  return layer;
}
