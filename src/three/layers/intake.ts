// Map layer for the Phase 9B City Camp Lagoon intake compound and the surface inflow chutes.
//
// The compound (src/intake/compound.ts) is placed with its screen toe on the trash-rack orifice
// and z = 0 at the 1428.0 m sill. The rack sits on the lagoon rim, so the channel runs along the
// rim (tangent): its right bank (+x, court / station / shed) faces away from the bowl and its
// left bank faces the lagoon. intakeAxes() is shared with the CCTV camera registry generator.
// The four arterial RCBCs that discharge into the bowl get an open concrete chute from their
// outlet headwall down the bowl wall, with a water ribbon whose depth follows the conduit.
import { BoxGeometry, Group, Mesh, PlaneGeometry, Vector3 } from 'three';
import type { Conduit, NetworkFile } from '../../types/twin';
import type { TwinState } from '../../utils/lutInterpolator';
import { Z_REF_M, type LocalFrame } from '../frame';
import { StudioMaterial } from '../materials/studioMaterial';
import { buildIntakeCompound, INTAKE_DATUM_ASL, regimeOf, type IntakeCompound, type IntakeState } from '../../intake/compound';

export interface IntakeLayer {
  group: Group;
  compound: IntakeCompound;
  /** Compound origin (rack toe at the sill) in scene metres. */
  origin: Vector3;
  /** Unit vector of the flow (compound local +y) in scene x/y. */
  fwd: Vector3;
  applyState(st: TwinState): void;
  setTime(t: number): void;
  setStructureVisible(on: boolean): void;
  setLandmarksVisible(on: boolean): void;
  /** Surface inflow chutes (the "Surface Waterways" layer). */
  setChutesVisible(on: boolean): void;
}

const CHUTE_COLOR = '#C9C4B8';

function buildChute(c: Conduit, frame: LocalFrame, lagoonInvert: number, floorRadius: (angle: number) => number) {
  const end = c.coordinates[c.coordinates.length - 1];
  const p0 = frame.toLocal(end[0], end[1], end[2]);
  const r0 = Math.hypot(p0.x, p0.y);
  const ang = Math.atan2(p0.y, p0.x);
  const rEnd = Math.min(floorRadius(ang), r0 - 4);
  const len = Math.max(r0 - rEnd, 4);
  const drop = Math.max(end[2] - (lagoonInvert + 0.15), 0.2);
  const pitch = Math.atan2(drop, len);
  const run = Math.hypot(len, drop);
  const span = c.geometry.span_m ?? c.geometry.diameter_m ?? 3;

  const outer = new Group();
  outer.position.copy(p0);
  // local +y = downhill towards the lagoon centre: R_z(θ)·(0,1) = (-sinθ, cosθ) = -p0 / |p0|
  outer.rotation.z = Math.atan2(p0.x, -p0.y);
  const inner = new Group();
  inner.rotation.x = -pitch;
  outer.add(inner);
  const concrete = new StudioMaterial({ color: CHUTE_COLOR, xray: '#1E293B' });
  const floor = new Mesh(new BoxGeometry(span + 0.5, run, 0.25).translate(0, run / 2, -0.125), concrete);
  const wallL = new Mesh(new BoxGeometry(0.25, run, 0.9).translate(-span / 2 - 0.125, run / 2, 0.45), concrete);
  const wallR = new Mesh(new BoxGeometry(0.25, run, 0.9).translate(span / 2 + 0.125, run / 2, 0.45), concrete);
  const waterMat = new StudioMaterial({ color: '#4A86A0', xray: '#0E7490', opacity: 0.85, emissive: 0.35 });
  const water = new Mesh(new PlaneGeometry(span, run).translate(0, run / 2, 0), waterMat);
  water.renderOrder = 22;
  inner.add(floor, wallL, wallR, water);
  return { group: outer, water, waterMat, conduitId: c.id, rise: c.geometry.rise_m ?? span };
}

/**
 * Compound axes from the rack position (scene metres, lagoon centroid at the origin):
 * right (+x) = outward from the bowl, fwd (+y) = outward rotated +90° (along the rim).
 */
export function intakeAxes(rackX: number, rackY: number): { fwd: Vector3; right: Vector3 } {
  const out = new Vector3(rackX, rackY, 0).normalize();
  return { fwd: new Vector3(-out.y, out.x, 0), right: out };
}

export function buildIntake(net: NetworkFile, frame: LocalFrame, sampleElevation: (x: number, y: number) => number): IntakeLayer {
  const rack = net.orifices[0];
  const anchor = frame.toLocal(rack.coordinates[0], rack.coordinates[1], INTAKE_DATUM_ASL);
  const { fwd, right } = intakeAxes(anchor.x, anchor.y);
  const world = (x: number, y: number) => ({ x: anchor.x + right.x * x + fwd.x * y, y: anchor.y + right.y * x + fwd.y * y });
  const groundLocal = (x: number, y: number) => {
    const w = world(x, y);
    return sampleElevation(w.x, w.y) - INTAKE_DATUM_ASL;
  };
  const compound = buildIntakeCompound((_role, look) => new StudioMaterial({ color: look.color, opacity: look.opacity, emissive: look.emissive, xray: '#273449' }), {
    groundZ: (x, y) => Math.max(groundLocal(x, y), 4.6),
    landmarkSide: 1,
  });
  const placed = compound.group;
  placed.position.set(anchor.x, anchor.y, INTAKE_DATUM_ASL - Z_REF_M);
  placed.rotation.z = Math.atan2(-fwd.x, fwd.y); // local +y -> fwd, local +x -> right

  // ---------------------------------------------------------------- inflow chutes
  const lag = net.lagoon;
  const rim = lag.polygon[0].slice(0, -1).map(([lng, lat]) => frame.toLocal(lng, lat));
  const floorK = Math.sqrt(lag.bottom_area_m2 / lag.area_m2);
  const floorRadius = (a: number) => {
    let best = rim[0];
    let bestD = Infinity;
    for (const p of rim) {
      const d = Math.abs(Math.atan2(Math.sin(a - Math.atan2(p.y, p.x)), Math.cos(a - Math.atan2(p.y, p.x))));
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return Math.hypot(best.x, best.y) * floorK;
  };
  const chutes = net.conduits
    .filter((c) => c.is_active && c.to_node === lag.node_id)
    .map((c) => buildChute(c, frame, lag.invert_elev_m, floorRadius));
  const chuteIndex = chutes.map((ch) => net.conduits.findIndex((c) => c.id === ch.conduitId));

  const group = new Group();
  group.name = 'intake';
  group.add(placed, ...chutes.map((c) => c.group));
  group.traverse((o) => (o.frustumCulled = false));

  let state: IntakeState = { waterElevM: lag.invert_elev_m + lag.permanent_pool_depth_m, occlusionPct: 0, rainMmHr: 0, regime: 'CALM' };
  return {
    group,
    compound,
    origin: placed.position.clone(),
    fwd,
    applyState(st) {
      const en08 = st.sensors.find((s) => s.id === 'EN-08');
      state = { waterElevM: st.lagoon.surfaceElevM, occlusionPct: st.blockagePct, rainMmHr: st.rain, regime: regimeOf(en08?.anomaly) };
      chutes.forEach((ch, i) => {
        const k = chuteIndex[i];
        const depth = k >= 0 ? st.conduits.depth[k] : 0;
        const ratio = Math.min(Math.max(depth / ch.rise, 0), 1);
        ch.water.visible = ratio > 0.01;
        ch.water.position.z = 0.04 + ratio * 0.7;
        ch.waterMat.color.set(ratio > 0.75 ? '#7B6A4E' : '#4A86A0');
      });
    },
    setTime(t) {
      compound.update(t, state);
    },
    setStructureVisible(on) {
      compound.structure.visible = on;
    },
    setChutesVisible(on) {
      for (const c of chutes) c.group.visible = on;
    },
    setLandmarksVisible(on) {
      compound.landmarks.visible = on;
    },
  };
}
