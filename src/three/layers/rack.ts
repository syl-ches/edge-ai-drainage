import {
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import type { Orifice, TwinNode } from '../../types/twin';
import { rackColor } from '../palette';
import { Z_REF_M, type LocalFrame } from '../frame';

const VISUAL_BARS = 16; // the real 48 bars @ 12 mm alias into mush; count and thickness are symbolic

export interface RackLayer {
  group: Group;
  anchor: Vector3; // sill centre (scene m)
  applyBlockage(pct: number): void;
  setPipeScale(k: number): void;
  setTime(t: number): void;
  setHighlight(on: boolean): void;
  /** Show or hide the symbolic bars / frame / debris (the Phase 9B intake compound draws the real screen). */
  setModelVisible(on: boolean): void;
}

/**
 * Inclined steel trash rack at the lagoon rim + intake throat into the drop shaft.
 * Group frame: x across the rack, y = flow direction (lagoon -> shaft), z up.
 */
export function buildRack(rack: Orifice, shaft: TwinNode, frame: LocalFrame): RackLayer {
  const anchor = frame.toLocal(rack.coordinates[0], rack.coordinates[1], rack.sill_elev_m);
  const shaftPos = frame.toLocal(shaft.coordinates[0], shaft.coordinates[1], rack.sill_elev_m);
  const flow = shaftPos.clone().sub(anchor);
  const throatLen = Math.max(flow.length(), 1);
  const group = new Group();
  group.name = 'trash-rack';
  group.position.copy(anchor);
  group.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), flow.normalize().setZ(0).normalize());

  const tilt = ((90 - rack.bar_angle_deg) * Math.PI) / 180; // lean back from vertical
  const barLen = rack.height_m / Math.cos(tilt);
  const w = rack.width_m;
  const steel = new MeshBasicMaterial({ color: '#CBD5E1', transparent: true, opacity: 0.9 });
  const barMat = new MeshBasicMaterial({ color: '#94A3B8' });
  const tiltQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -tilt);

  const rackGroup = new Group();
  rackGroup.quaternion.copy(tiltQ);
  const frameBar = (sx: number, sy: number, sz: number, x: number, z: number) => {
    const m = new Mesh(new BoxGeometry(sx, sy, sz), steel);
    m.position.set(x, 0, z);
    rackGroup.add(m);
  };
  frameBar(w + 0.44, 0.22, 0.22, 0, 0);
  frameBar(w + 0.44, 0.22, 0.22, 0, barLen);
  frameBar(0.22, 0.22, barLen, -w / 2 - 0.11, barLen / 2);
  frameBar(0.22, 0.22, barLen, w / 2 + 0.11, barLen / 2);

  const bars = new InstancedMesh(new BoxGeometry(0.09, 0.16, barLen), barMat, VISUAL_BARS);
  const m = new Matrix4();
  for (let i = 0; i < VISUAL_BARS; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / VISUAL_BARS;
    bars.setMatrixAt(i, m.makeTranslation(x, 0, barLen / 2));
  }
  rackGroup.add(bars);

  // Debris mat (plastic + silt) creeping up from the sill with blockage.
  const debrisMat = new MeshBasicMaterial({ color: '#7C5A2E', transparent: true, opacity: 0.8, side: DoubleSide });
  const debris = new Mesh(new PlaneGeometry(w, 1).translate(0, 0.5, 0), debrisMat);
  debris.rotation.x = Math.PI / 2;
  debris.position.y = -0.06;
  rackGroup.add(debris);

  // Intake throat: rack -> drop shaft at sill level.
  const throatMat = new MeshBasicMaterial({ color: '#64748B', transparent: true, opacity: 0.2, depthWrite: false, side: DoubleSide });
  const throat = new Mesh(new BoxGeometry(w, throatLen, rack.height_m), throatMat);
  throat.position.set(0, throatLen / 2, rack.height_m / 2);

  // Beacon-style highlight halo for picking feedback.
  const haloMat = new MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0, depthWrite: false, side: DoubleSide });
  const halo = new Mesh(new PlaneGeometry(w + 1.2, barLen + 1.2).translate(0, (barLen + 1.2) / 2 - 0.6, 0), haloMat);
  halo.rotation.x = Math.PI / 2;
  halo.position.y = -0.2;
  rackGroup.add(halo);

  group.add(rackGroup, throat);
  group.traverse((o) => (o.frustumCulled = false));
  group.position.z = rack.sill_elev_m - Z_REF_M;

  const tmp = new Color();
  let blockage = 0;
  return {
    group,
    anchor,
    applyBlockage(pct) {
      blockage = pct;
      barMat.color.copy(rackColor(pct, tmp));
      debris.scale.set(1, Math.max((pct / 100) * barLen, 0.001), 1);
      debris.visible = pct > 0;
    },
    setPipeScale(k) {
      group.scale.setScalar(k);
    },
    setTime(t) {
      if (blockage >= 75) barMat.color.copy(rackColor(blockage, tmp)).multiplyScalar(0.75 + 0.25 * Math.sin(t * 5));
    },
    setHighlight(on) {
      haloMat.opacity = on ? 0.18 : 0;
    },
    setModelVisible(on) {
      for (const o of rackGroup.children) if (o !== halo) o.visible = on;
      throat.visible = on;
    },
  };
}
