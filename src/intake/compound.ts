// Procedural 3D model of the City Camp Lagoon tunnel-intake compound (Phase 9B), shared by the
// map (StudioMaterial, mirrored mercator projection) and the Command Center CCTV replay
// renderer (MeshStandardMaterial). The caller supplies the materials, so this module is pure
// geometry: no canvas textures, no DOM, and it builds under vitest.
//
// Local frame: x across the channel (+x = right bank looking downstream), y along the flow
// (+y = downstream, towards the tunnel portal), z up. Origin = rack toe on the channel floor;
// z = 0 is the rack sill (1428.0 m ASL), so the walkway rim (1433.0 m, the lagoon rim) is z = 5.
//
// Built from a written description of field photos and CCTV stills, NOT from survey drawings:
// every dimension is a plausible stand-in (CLAUDE.md §1). The sloped bar screen is drawn at the
// ~50° seen in the photos; the hydraulic model (generator, Kirschmer loss) still uses the 75°
// in network.orifices[0].bar_angle_deg until a survey settles it.
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Elevation of local z = 0 (the rack sill). */
export const INTAKE_DATUM_ASL = 1428.0;
/** Lagoon invert: zero of the staff gauge (same datum as EN-07 and the LUT depth). */
export const GAUGE_ZERO_ASL = 1426.5;
export const RACK_VISUAL_ANGLE_DEG = 50;

export const INTAKE = {
  width: 5.0, // channel interior
  wall: 0.45,
  walkway: 1.6,
  rimZ: 5.0, // walkway / lagoon rim, 1433.0 m ASL
  rackRise: 4.4, // sill -> top of the sloped screen
  barsWidth: 3.0, // bar screen (the hydraulic 3.0 m opening); the rest is the apron wing
  poolFloorZ: -0.4, // silt trap below the sill, downstream of the weir
  poolLength: 3.5,
  weirCrestZ: 0.9,
  weirThickness: 0.6,
  upperFloorZ: 0.6,
  upperLength: 9.5,
  rampLength: 22.0,
  gaugeY: -5.0, // staff gauge on the right (outer) wall of the silt-trap pool
  debrisCount: 260,
} as const;

const RAD = (RACK_VISUAL_ANGLE_DEG * Math.PI) / 180;
const SIN = Math.sin(RAD);
const COS = Math.cos(RAD);
/** Horizontal run of the sloped screen: toe at y = -RACK_RUN, top against the headwall at y = 0. */
export const RACK_RUN = INTAKE.rackRise / Math.tan(RAD);
export const RACK_SLOPE_LEN = INTAKE.rackRise / SIN;
const Y_WEIR = -RACK_RUN - INTAKE.poolLength;
const Y_RAMP_FOOT = Y_WEIR - INTAKE.weirThickness - INTAKE.upperLength;
/** Upstream end of the channel (top of the vehicular ramp). */
export const CHANNEL_START_Y = Y_RAMP_FOOT - INTAKE.rampLength;

export type IntakeRole =
  | 'concrete'
  | 'channel'
  | 'masonry'
  | 'coping'
  | 'walkway'
  | 'asphalt'
  | 'railing'
  | 'bars'
  | 'rust'
  | 'portal'
  | 'cage'
  | 'cageMesh'
  | 'gaugePost'
  | 'gaugeGreen'
  | 'gaugeAmber'
  | 'gaugeRed'
  | 'gaugeTick'
  | 'courtRoof'
  | 'courtSteel'
  | 'courtFloor'
  | 'courtLine'
  | 'stationWall'
  | 'stationRoof'
  | 'stationTrim'
  | 'shed'
  | 'pipe'
  | 'water'
  | 'foam'
  | 'jet'
  | 'debris'
  | 'silt';

export interface RoleLook {
  color: string;
  opacity?: number;
  /** 0 = lit, 1 = flat (water jets, painted bands read better unlit at a distance) */
  emissive?: number;
  metal?: number;
  rough?: number;
}

/** Field-photo palette (weathered concrete, galvanised rails, rusty screen, green court roof). */
export const ROLE_LOOK: Record<IntakeRole, RoleLook> = {
  concrete: { color: '#B9B6AE', rough: 0.9 },
  channel: { color: '#8E8A80', rough: 0.95 },
  masonry: { color: '#9D9384', rough: 1 },
  coping: { color: '#D2CEC4', rough: 0.85 },
  walkway: { color: '#C8C4BA', rough: 0.9 },
  asphalt: { color: '#4A4E54', rough: 0.95 },
  railing: { color: '#B9C2C9', metal: 0.8, rough: 0.35 },
  bars: { color: '#5A4535', metal: 0.6, rough: 0.6 },
  rust: { color: '#8B4A28', metal: 0.5, rough: 0.7 },
  portal: { color: '#16191E', rough: 1 },
  cage: { color: '#5F6872', metal: 0.7, rough: 0.45 },
  cageMesh: { color: '#9AA6B2', opacity: 0.22, metal: 0.6, rough: 0.5 },
  gaugePost: { color: '#F8FAFC', rough: 0.6 },
  gaugeGreen: { color: '#16A34A', emissive: 0.25 },
  gaugeAmber: { color: '#F59E0B', emissive: 0.25 },
  gaugeRed: { color: '#DC2626', emissive: 0.25 },
  gaugeTick: { color: '#111827' },
  courtRoof: { color: '#2E7D4F', metal: 0.3, rough: 0.55 },
  courtSteel: { color: '#5E6A75', metal: 0.7, rough: 0.4 },
  courtFloor: { color: '#A7ACA6', rough: 0.9 },
  courtLine: { color: '#F8FAFC', emissive: 0.2 },
  stationWall: { color: '#EDE5D2', rough: 0.9 },
  stationRoof: { color: '#B3261E', rough: 0.7 },
  stationTrim: { color: '#3F3F46', rough: 0.8 },
  shed: { color: '#2D333B', rough: 0.85 },
  pipe: { color: '#6B7280', metal: 0.4, rough: 0.6 },
  water: { color: '#5E7F62', opacity: 0.9, rough: 0.6 }, // silty water: matte, so it keeps its colour under an overcast sky
  foam: { color: '#EEF2F5', opacity: 0, emissive: 0.6 },
  jet: { color: '#E8EEF2', opacity: 0.85, emissive: 0.5 },
  debris: { color: '#FFFFFF', rough: 0.8 },
  silt: { color: '#6E5A3E', rough: 1 },
};

/** Material whose albedo can change at runtime (MeshStandardMaterial, StudioMaterial, ...). */
export type ColorMaterial = Material & { color: Color };
export type MaterialFactory = (role: IntakeRole, look: RoleLook) => ColorMaterial;

export type IntakeRegime = 'CALM' | 'SURGE' | 'BACKWATER';

/** Channel water colour per regime: calm silt-green, muddy storm surge, dark stagnant backwater. */
export const REGIME_WATER: Record<IntakeRegime, { color: string; amp: number; speed: number }> = {
  CALM: { color: '#5E7F62', amp: 0.025, speed: 0.8 },
  SURGE: { color: '#8A6B45', amp: 0.13, speed: 2.6 },
  BACKWATER: { color: '#3F4A30', amp: 0.006, speed: 0.25 },
};

/** Edge-classifier anomaly -> water look. */
export function regimeOf(anomaly: string | undefined): IntakeRegime {
  if (anomaly === 'FLASH_SURGE' || anomaly === 'SUPERCRITICAL') return 'SURGE';
  if (anomaly === 'TRASH_BLOCKAGE' || anomaly === 'SURCHARGED') return 'BACKWATER';
  return 'CALM';
}

export interface IntakeState {
  /** Lagoon / channel water surface, m ASL */
  waterElevM: number;
  /** Visual trash-rack occlusion, 0-95 % */
  occlusionPct: number;
  rainMmHr: number;
  regime: IntakeRegime;
}

/** Staff-gauge reading (m above the 1426.5 m lagoon invert) for a water elevation. */
export function gaugeReadingM(waterElevM: number): number {
  return Math.max(waterElevM - GAUGE_ZERO_ASL, 0);
}

/** Water in the channel tops the transverse drop-weir (5 cm tolerance). */
export function weirSubmerged(waterElevM: number): boolean {
  return waterElevM - INTAKE_DATUM_ASL > INTAKE.weirCrestZ + 0.05;
}

export interface DetectionTarget {
  key: 'rack' | 'debris' | 'weir' | 'gauge';
  box: Box3; // compound-local
}

export interface IntakeCompound {
  /** Whole compound (channel, rack, cage + landmarks); position/rotate it as one. */
  group: Group;
  /** Drainage structure only: channel, weir, rack, cage, gauge, water, debris. */
  structure: Group;
  /** Covered court, station, shed + outfall pipe and access road. */
  landmarks: Group;
  /** Number of debris instances shown at the current occlusion. */
  debrisShown(): number;
  update(t: number, s: IntakeState): void;
  /** Compound-local boxes a vision model would draw (YOLO overlay). */
  detectionTargets(): DetectionTarget[];
}

export interface IntakeOptions {
  /** Ground height (local z) at a local x/y, for the landmarks; default: the walkway level. */
  groundZ?: (x: number, y: number) => number;
  /** Bank the court, station, shed and road stand on: +1 right bank (default), -1 left bank.
   *  The other bank faces the lagoon. */
  landmarkSide?: 1 | -1;
}

/** Deterministic hash in [0, 1). */
function hash(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** A point on the sloped screen: across-x, s metres up the slope, n metres off its upstream face. */
export function onRack(x: number, s: number, n = 0): Vector3 {
  return new Vector3(x, -RACK_RUN + s * COS - n * SIN, s * SIN + n * COS);
}

/** Prism of a 2D profile (u, v) extruded along one axis between two coordinates. */
function prism(profile: [number, number][], axis: 'x' | 'y', from: number, to: number): BufferGeometry {
  const shape = new Shape(profile.map(([u, v]) => new Vector2(u, v)));
  const g = new ExtrudeGeometry(shape, { depth: to - from, bevelEnabled: false });
  // Rotations only (det +1) so the extrusion keeps its winding and normals:
  //   x: (u, v, e) -> (from + e, u, v);   y: (u, v, e) -> (u, to - e, v).
  const m = new Matrix4();
  if (axis === 'x') m.set(0, 0, 1, from, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  else m.set(1, 0, 0, 0, 0, 0, -1, to, 0, 1, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  return g;
}

/** Hip roof over a w x d rectangle centred on the origin (ridge along the longer axis). */
function hipRoof(w: number, d: number, rise: number): BufferGeometry {
  const a = w / 2;
  const b = d / 2;
  const r = Math.max(a - b, 0.01);
  const p = [
    [-a, -b, 0], [a, -b, 0], [r, 0, rise],
    [-a, -b, 0], [r, 0, rise], [-r, 0, rise],
    [a, b, 0], [-a, b, 0], [-r, 0, rise],
    [a, b, 0], [-r, 0, rise], [r, 0, rise],
    [a, -b, 0], [a, b, 0], [r, 0, rise],
    [-a, b, 0], [-a, -b, 0], [-r, 0, rise],
  ].flat();
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** Opacity for both stock materials and StudioMaterial (which keeps it in a uniform). */
function setOpacity(m: Material, v: number): void {
  m.opacity = v;
  (m as Material & { setOpacity?: (o: number) => void }).setOpacity?.(v);
}

function normalise(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out.getAttribute('uv')) out.deleteAttribute('uv');
  if (out.getAttribute('uv1')) out.deleteAttribute('uv1');
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  return out;
}

export function buildIntakeCompound(mat: MaterialFactory, opts: IntakeOptions = {}): IntakeCompound {
  const W = INTAKE.width;
  const T = INTAKE.wall;
  const RIM = INTAKE.rimZ;
  const side = opts.landmarkSide ?? 1;
  const groundZ = opts.groundZ ?? (() => RIM);
  const materials = new Map<IntakeRole, ColorMaterial>();
  const material = (role: IntakeRole) => {
    let m = materials.get(role);
    if (!m) {
      m = mat(role, ROLE_LOOK[role]);
      materials.set(role, m);
    }
    return m;
  };

  // Static parts are collected per role and merged into one mesh per material.
  const bins = { structure: new Map<IntakeRole, BufferGeometry[]>(), landmarks: new Map<IntakeRole, BufferGeometry[]>() };
  const put = (bin: keyof typeof bins, role: IntakeRole, g: BufferGeometry) => {
    const list = bins[bin].get(role) ?? [];
    list.push(normalise(g));
    bins[bin].set(role, list);
  };
  const tmpM = new Matrix4();
  const box = (bin: keyof typeof bins, role: IntakeRole, sx: number, sy: number, sz: number, cx: number, cy: number, cz: number, rotX = 0, rotZ = 0) => {
    const g = new BoxGeometry(sx, sy, sz);
    if (rotX) g.rotateX(rotX);
    if (rotZ) g.rotateZ(rotZ);
    g.translate(cx, cy, cz);
    put(bin, role, g);
  };
  const rod = (bin: keyof typeof bins, role: IntakeRole, a: Vector3, b: Vector3, r: number, sides = 6) => {
    const d = b.clone().sub(a);
    const g = new CylinderGeometry(r, r, d.length(), sides, 1);
    g.applyMatrix4(tmpM.makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize())));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    put(bin, role, g);
  };
  const beam = (bin: keyof typeof bins, role: IntakeRole, a: Vector3, b: Vector3, t: number) => {
    const d = b.clone().sub(a);
    const g = new BoxGeometry(t, d.length(), t);
    g.applyMatrix4(tmpM.makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize())));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    put(bin, role, g);
  };

  const y0 = CHANNEL_START_Y;
  const L = -y0;
  const xL = -W / 2 - T / 2;
  const xR = W / 2 + T / 2;
  const floorBottom = INTAKE.poolFloorZ - 0.5;

  // ---------------------------------------------------------------- channel floor, weir, ramp
  // Longitudinal floor profile (y, z): ramp top -> ramp foot -> upper floor -> weir -> pool -> toe.
  const floorProfile: [number, number][] = [
    [y0, floorBottom],
    [0.6, floorBottom],
    [0.6, INTAKE.poolFloorZ],
    [Y_WEIR, INTAKE.poolFloorZ],
    [Y_WEIR, INTAKE.weirCrestZ],
    [Y_WEIR - INTAKE.weirThickness, INTAKE.weirCrestZ],
    [Y_WEIR - INTAKE.weirThickness, INTAKE.upperFloorZ],
    [Y_RAMP_FOOT, INTAKE.upperFloorZ],
    [y0, RIM - 0.02],
  ];
  // Extruded across the channel: profile u = y, v = z; prism along x.
  put('structure', 'channel', prism(floorProfile, 'x', -W / 2, W / 2));
  // Ramp grip strips (transverse ribs) on the vehicular ramp.
  for (let k = 1; k < 18; k++) {
    const f = k / 18;
    const y = Y_RAMP_FOOT - f * INTAKE.rampLength;
    const z = INTAKE.upperFloorZ + f * (RIM - INTAKE.upperFloorZ);
    box('structure', 'coping', W - 0.3, 0.12, 0.05, 0, y, z + 0.02, -Math.atan((RIM - INTAKE.upperFloorZ) / INTAKE.rampLength));
  }

  // ---------------------------------------------------------------- walls, headwall, coping, walkways
  for (const x of [xL, xR]) {
    box('structure', 'concrete', T, L + 0.6, RIM - floorBottom, x, y0 / 2 + 0.3, (RIM + floorBottom) / 2);
    // Stone-masonry upper courses (the older parapet), proud of the concrete by 3 cm.
    const inner = x < 0 ? x + T / 2 + 0.015 : x - T / 2 - 0.015;
    box('structure', 'masonry', 0.03, L - 0.2, 1.6, inner, y0 / 2, RIM - 0.85);
    box('structure', 'coping', T + 0.12, L + 0.6, 0.18, x, y0 / 2 + 0.3, RIM + 0.09);
    const wx = x < 0 ? x - T / 2 - INTAKE.walkway / 2 : x + T / 2 + INTAKE.walkway / 2;
    box('structure', 'walkway', INTAKE.walkway, L + 0.6, 0.3, wx, y0 / 2 + 0.3, RIM - 0.15);
  }
  box('structure', 'concrete', W + 2 * T, 0.8, RIM - floorBottom + 0.6, 0, 0.4 + 0.2, (RIM + floorBottom) / 2 + 0.3);
  // Sill step from the silt-trap pool up to the screen toe.
  box('structure', 'concrete', W, 0.5, -INTAKE.poolFloorZ, 0, -RACK_RUN + 0.1, INTAKE.poolFloorZ / 2);
  // Tunnel portal behind the bar screen (dark opening, 3.0 x 2.0 like the hydraulic orifice).
  const barsX0 = -W / 2;
  const barsX1 = -W / 2 + INTAKE.barsWidth;
  box('structure', 'portal', INTAKE.barsWidth, 0.06, 2.0, (barsX0 + barsX1) / 2, 0.17, 1.0);

  // ---------------------------------------------------------------- galvanised pipe railings
  for (const x of [xL - T / 2 + 0.05, xR + T / 2 - 0.05]) {
    for (let y = y0 + 0.4; y <= 0.4; y += 2.0) rod('structure', 'railing', new Vector3(x, y, RIM + 0.18), new Vector3(x, y, RIM + 1.25), 0.03);
    for (const h of [0.6, 1.2]) rod('structure', 'railing', new Vector3(x, y0 + 0.4, RIM + 0.18 + h - 0.1), new Vector3(x, 0.4, RIM + 0.18 + h - 0.1), 0.028);
  }

  // ---------------------------------------------------------------- sloped steel bar screen + apron wing
  // Boxes laid on the screen: local y runs up the slope, local z is the upstream face normal.
  const along = (x: number, s: number, n: number, sx: number, sy: number, sz: number, role: IntakeRole) => {
    const c = onRack(x, s, n);
    const g = new BoxGeometry(sx, sy, sz);
    g.rotateX(RAD);
    g.translate(c.x, c.y, c.z);
    put('structure', role, g);
  };
  const nBars = 25;
  for (let i = 0; i < nBars; i++) {
    const x = barsX0 + ((i + 0.5) / nBars) * INTAKE.barsWidth;
    along(x, RACK_SLOPE_LEN / 2, 0, 0.05, RACK_SLOPE_LEN, 0.1, 'bars');
  }
  for (const s of [0.15, 1.9, 3.65, RACK_SLOPE_LEN - 0.15]) along(0, s, 0.09, W, 0.16, 0.16, 'bars');
  for (const x of [barsX0 + 0.05, barsX1, W / 2 - 0.05]) along(x, RACK_SLOPE_LEN / 2, 0.06, 0.14, RACK_SLOPE_LEN, 0.18, 'bars');
  along((barsX1 + W / 2) / 2, RACK_SLOPE_LEN / 2, -0.02, W / 2 - barsX1 - 0.02, RACK_SLOPE_LEN, 0.04, 'rust');

  // ---------------------------------------------------------------- polygonal steel-truss cage dome
  const cageY0 = -RACK_RUN - 1.2;
  const cageY1 = 0.6;
  const archPts = (k: number) => {
    // half-octagon from wall top to wall top, apex 3.1 m above the rim
    const pts: Vector3[] = [];
    const span = W + 2 * T;
    for (let j = 0; j <= 4; j++) {
      const a = (j / 4) * Math.PI;
      pts.push(new Vector3(-Math.cos(a) * (span / 2), k, RIM + 0.2 + Math.sin(a) * 3.1));
    }
    return pts;
  };
  const ribs = 5;
  const ribYs = Array.from({ length: ribs }, (_, i) => cageY0 + ((cageY1 - cageY0) * i) / (ribs - 1));
  const archs = ribYs.map(archPts);
  for (const a of archs) for (let j = 0; j < a.length - 1; j++) beam('structure', 'cage', a[j], a[j + 1], 0.12);
  for (let j = 0; j < archs[0].length; j++) for (let i = 0; i < ribs - 1; i++) beam('structure', 'cage', archs[i][j], archs[i + 1][j], 0.07);
  for (let i = 0; i < ribs - 1; i++) {
    for (let j = 0; j < archs[0].length - 1; j++) {
      // diagonal bracing + translucent expanded-metal mesh panels
      beam('structure', 'cage', archs[i][j], archs[i + 1][j + 1], 0.04);
      const a = archs[i][j];
      const b = archs[i][j + 1];
      const c = archs[i + 1][j + 1];
      const d = archs[i + 1][j];
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([a, b, c, a, c, d].flatMap((p) => [p.x, p.y, p.z]), 3));
      g.computeVertexNormals();
      put('structure', 'cageMesh', g);
    }
  }

  // ---------------------------------------------------------------- staff gauge (lagoon-stage bands)
  const gaugeX = W / 2 - 0.12;
  const zOf = (depthM: number) => GAUGE_ZERO_ASL + depthM - INTAKE_DATUM_ASL;
  const gz0 = INTAKE.poolFloorZ;
  box('structure', 'gaugePost', 0.16, 0.12, RIM - gz0, gaugeX, INTAKE.gaugeY, (RIM + gz0) / 2);
  const bands: [IntakeRole, number, number][] = [
    ['gaugeGreen', gz0, zOf(6.5 * 0.45)],
    ['gaugeAmber', zOf(6.5 * 0.45), zOf(6.5 * 0.8)],
    ['gaugeRed', zOf(6.5 * 0.8), RIM],
  ];
  for (const [role, a, b] of bands) box('structure', role, 0.17, 0.13, b - a, gaugeX - 0.01, INTAKE.gaugeY, (a + b) / 2);
  for (let d = 1; d <= 6; d++) {
    const z = zOf(d);
    if (z > gz0 && z < RIM) box('structure', 'gaugeTick', 0.19, 0.14, 0.05, gaugeX - 0.015, INTAKE.gaugeY, z);
  }

  // ---------------------------------------------------------------- landmarks
  const outerX = (k: number) => side * (W / 2 + T + INTAKE.walkway + k);
  // Wet access road along the landmark bank (the shed sits between the walkway and the road).
  const roadX = outerX(6.6);
  const roadZ = groundZ(roadX, y0 / 2);
  box('landmarks', 'asphalt', 6.0, L + 10, 0.2, roadX, y0 / 2 + 3, roadZ - 0.08);
  // Green gable-roofed, open-sided steel-truss covered court (basketball court 28 x 15 + aprons).
  const courtX = outerX(10.0 + 9.5);
  const courtY = Y_RAMP_FOOT + 2;
  const cz = groundZ(courtX, courtY);
  const CW = 19;
  const CL = 31;
  box('landmarks', 'courtFloor', CW, CL, 0.25, courtX, courtY, cz + 0.02);
  for (const [sx, sy, cx, cy] of [
    [15, 0.1, 0, -14],
    [15, 0.1, 0, 14],
    [0.1, 28, -7.5, 0],
    [0.1, 28, 7.5, 0],
    [15, 0.1, 0, 0],
  ]) box('landmarks', 'courtLine', sx, sy, 0.02, courtX + cx, courtY + cy, cz + 0.16);
  const eave = cz + 7.0;
  const ridge = cz + 10.2;
  for (let j = 0; j <= 6; j++) {
    const y = courtY - CL / 2 + (CL * j) / 6;
    for (const dx of [-CW / 2, CW / 2]) rod('landmarks', 'courtSteel', new Vector3(courtX + dx, y, cz), new Vector3(courtX + dx, y, eave), 0.13, 8);
    // roof truss: rafters + bottom chord + king post
    beam('landmarks', 'courtSteel', new Vector3(courtX - CW / 2 - 0.6, y, eave - 0.3), new Vector3(courtX, y, ridge), 0.16);
    beam('landmarks', 'courtSteel', new Vector3(courtX + CW / 2 + 0.6, y, eave - 0.3), new Vector3(courtX, y, ridge), 0.16);
    beam('landmarks', 'courtSteel', new Vector3(courtX - CW / 2, y, eave), new Vector3(courtX + CW / 2, y, eave), 0.12);
    beam('landmarks', 'courtSteel', new Vector3(courtX, y, eave), new Vector3(courtX, y, ridge), 0.1);
  }
  put(
    'landmarks',
    'courtRoof',
    prism(
      [
        [courtX - CW / 2 - 0.9, eave - 0.35],
        [courtX + CW / 2 + 0.9, eave - 0.35],
        [courtX + CW / 2 + 0.9, eave - 0.2],
        [courtX, ridge + 0.18],
        [courtX - CW / 2 - 0.9, eave - 0.2],
      ],
      'y',
      courtY - CL / 2 - 0.8,
      courtY + CL / 2 + 0.8,
    ),
  );
  // Red hip-roofed single-storey barangay / monitoring station near the portal.
  const stX = outerX(10.0 + 3.5);
  const stY = 6.0;
  const sz = groundZ(stX, stY);
  box('landmarks', 'stationWall', 7.0, 10.0, 3.2, stX, stY, sz + 1.6);
  const roof = hipRoof(10.0 + 1.2, 7.0 + 1.2, 2.2);
  roof.rotateZ(Math.PI / 2);
  roof.translate(stX, stY, sz + 3.2);
  put('landmarks', 'stationRoof', roof);
  box('landmarks', 'stationTrim', 0.06, 1.0, 2.1, stX - side * 3.53, stY + 2.0, sz + 1.05);
  for (const dy of [-3.0, -1.0]) box('landmarks', 'stationTrim', 0.06, 1.2, 1.0, stX - side * 3.53, stY + dy, sz + 1.9);
  // Dark utility shed with a side-drain outfall through the bank wall into the channel.
  const shedX = outerX(1.8);
  const shedY = -16.0;
  const shz = groundZ(shedX, shedY);
  box('landmarks', 'shed', 3.0, 3.4, 2.6, shedX, shedY, shz + 1.3);
  box('landmarks', 'stationTrim', 3.4, 3.8, 0.12, shedX, shedY, shz + 2.66);
  const pipeOut = new Vector3(side * (W / 2 - 0.05), shedY + 0.4, 3.0);
  rod('landmarks', 'pipe', new Vector3(shedX, shedY + 0.4, 3.0), pipeOut, 0.2, 12);

  // ---------------------------------------------------------------- merge statics
  const structure = new Group();
  structure.name = 'intake-structure';
  const landmarks = new Group();
  landmarks.name = 'intake-landmarks';
  for (const [bin, target] of [
    ['structure', structure],
    ['landmarks', landmarks],
  ] as const) {
    for (const [role, list] of bins[bin]) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      const mesh = new Mesh(merged, material(role));
      mesh.name = `${bin}:${role}`;
      mesh.castShadow = role !== 'cageMesh';
      mesh.receiveShadow = true;
      if (role === 'cageMesh') mesh.renderOrder = 24;
      target.add(mesh);
    }
  }

  // ---------------------------------------------------------------- dynamic: channel water + weir foam
  const waterMat = material('water');
  const waterGeo = new PlaneGeometry(W - 0.02, L + 0.5, 16, 96);
  waterGeo.translate(0, y0 / 2 + 0.25, 0);
  const waterBase = Float32Array.from(waterGeo.getAttribute('position').array);
  const water = new Mesh(waterGeo, waterMat);
  water.name = 'intake-water';
  water.renderOrder = 22;
  structure.add(water);
  const foamMat = material('foam');
  const foam = new Mesh(new BoxGeometry(W - 0.05, 1.4, 0.06), foamMat);
  foam.position.set(0, Y_WEIR - INTAKE.weirThickness / 2 + 0.6, INTAKE.weirCrestZ + 0.05);
  foam.renderOrder = 23;
  structure.add(foam);

  // ---------------------------------------------------------------- dynamic: debris on the screen + silt mound
  const N = INTAKE.debrisCount;
  const debris = new InstancedMesh(new IcosahedronGeometry(0.17, 0), material('debris'), N);
  debris.name = 'intake-debris';
  const palette = ['#E5E7EB', '#F8FAFC', '#2563EB', '#DC2626', '#EAB308', '#7C5A2E', '#1F2937', '#15803D', '#A16207', '#0EA5E9'].map((c) => new Color(c));
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => hash(a, 2.2) - hash(b, 2.2));
  const debrisS: number[] = [];
  const dm = new Matrix4();
  const q = new Quaternion();
  order.forEach((src, i) => {
    // Debris rides up the screen as it fills: instance i sits at fraction (i / N) of the face.
    const f = (i + 0.5) / N;
    const s = Math.min(f * RACK_SLOPE_LEN * 1.02, RACK_SLOPE_LEN - 0.1) + (hash(src, 4.4) - 0.5) * 0.35;
    const onWing = hash(src, 6.1) < 0.18;
    const x = onWing ? INTAKE.barsWidth - W / 2 + hash(src, 1.1) * (W - INTAKE.barsWidth) : barsX0 + hash(src, 1.1) * INTAKE.barsWidth;
    const p = onRack(x, Math.max(s, 0.05), 0.14 + hash(src, 9.9) * 0.12);
    q.setFromAxisAngle(new Vector3(hash(src, 3), hash(src, 5), hash(src, 7)).normalize(), hash(src, 8) * Math.PI * 2);
    const k = 0.6 + hash(src, 11) * 1.4;
    dm.compose(p, q, new Vector3(k * (1 + hash(src, 12)), k, k * 0.6));
    debris.setMatrixAt(i, dm);
    debris.setColorAt(i, palette[Math.floor(hash(src, 13) * palette.length) % palette.length]);
    debrisS.push(s);
  });
  debris.count = 0;
  structure.add(debris);
  const silt = new Mesh(new SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), material('silt'));
  silt.position.copy(onRack(-W / 2 + INTAKE.barsWidth / 2 + 0.6, 0, 0.2));
  silt.position.z = INTAKE.poolFloorZ;
  silt.visible = false;
  structure.add(silt);

  // ---------------------------------------------------------------- dynamic: side-drain outfall jet
  const jetMat = material('jet');
  const jetSegs = 10;
  const jet = new Group();
  jet.name = 'intake-outfall-jet';
  const jetParts: Mesh[] = [];
  for (let i = 0; i < jetSegs; i++) {
    const m = new Mesh(new BoxGeometry(0.34, 0.34, 0.34), jetMat);
    m.renderOrder = 23;
    jetParts.push(m);
    jet.add(m);
  }
  landmarks.add(jet);
  const splash = new Mesh(new CylinderGeometry(0.6, 0.9, 0.08, 16).rotateX(Math.PI / 2), jetMat);
  splash.renderOrder = 23;
  landmarks.add(splash);

  const group = new Group();
  group.name = 'intake-compound';
  group.add(structure, landmarks);

  let shown = 0;
  let lastWaterZ = 0;
  let lastOcc = 0;
  const waterColor = new Color();
  return {
    group,
    structure,
    landmarks,
    debrisShown: () => shown,
    update(t, s) {
      const look = REGIME_WATER[s.regime];
      const wz = Math.max(s.waterElevM - INTAKE_DATUM_ASL, INTAKE.poolFloorZ + 0.02);
      lastWaterZ = wz;
      water.position.z = wz;
      waterColor.set(look.color);
      waterMat.color.lerp(waterColor, 0.08);
      const pos = waterGeo.getAttribute('position');
      const arr = pos.array as Float32Array;
      const rainChop = Math.min(s.rainMmHr / 400, 0.04);
      for (let i = 0; i < arr.length; i += 3) {
        const x = waterBase[i];
        const y = waterBase[i + 1];
        arr[i + 2] =
          (look.amp + rainChop) * (Math.sin(y * 1.7 - t * look.speed * 2.2) * 0.6 + Math.sin(x * 3.1 + y * 0.9 + t * look.speed * 1.4) * 0.4) +
          (s.regime === 'SURGE' ? 0.05 * Math.sin(y * 5.3 + x * 4.1 - t * 6) : 0);
      }
      pos.needsUpdate = true;
      waterGeo.computeVertexNormals();
      // White water over the weir only while the channel flows over it with some depth.
      const over = wz - INTAKE.weirCrestZ;
      const foamK = over > -0.05 && over < 1.2 ? Math.min((over + 0.05) / 0.25, 1) * (s.regime === 'BACKWATER' ? 0.25 : 1) : 0;
      foam.visible = foamK > 0.01;
      foam.position.z = Math.max(wz, INTAKE.weirCrestZ) + 0.04;
      setOpacity(foamMat, 0.75 * foamK);
      // Debris fills the screen from the toe upwards with occlusion (0-95 %).
      lastOcc = Math.min(Math.max(s.occlusionPct, 0), 95);
      shown = Math.round((lastOcc / 95) * N);
      debris.count = shown;
      silt.visible = lastOcc > 5;
      const sk = 0.5 + (lastOcc / 95) * 2.2;
      silt.scale.set(sk * 1.4, sk * 0.9, 0.25 + (lastOcc / 95) * 0.9);
      // Outfall jet: parabola from the pipe mouth to the water, stronger with rain.
      const flow = Math.min(s.rainMmHr / 60, 1);
      jet.visible = splash.visible = flow > 0.02;
      const v0 = 0.8 + 2.4 * flow;
      const drop = Math.max(pipeOut.z - wz, 0.2);
      const tFall = Math.sqrt((2 * drop) / 9.81);
      jetParts.forEach((m, i) => {
        const u = ((i / jetSegs + t * 1.6) % 1) * tFall;
        m.position.set(pipeOut.x - side * v0 * u, pipeOut.y + Math.sin(t * 7 + i) * 0.03, pipeOut.z - 0.5 * 9.81 * u * u);
        const k = 0.6 + flow * 0.9;
        m.scale.set(k, k, k * (1 + u * 2));
      });
      splash.position.set(pipeOut.x - side * v0 * tFall, pipeOut.y, wz + 0.05);
      splash.scale.setScalar(0.5 + flow * (0.9 + 0.2 * Math.sin(t * 9)));
    },
    detectionTargets() {
      const rack = new Box3().setFromPoints([onRack(barsX0, 0, 0), onRack(W / 2, 0, 0), onRack(barsX0, RACK_SLOPE_LEN, 0), onRack(W / 2, RACK_SLOPE_LEN, 0.3)]);
      const reach = Math.max((lastOcc / 95) * RACK_SLOPE_LEN, 0.3);
      const debrisBox = new Box3().setFromPoints([onRack(barsX0, 0, 0), onRack(W / 2, 0, 0.4), onRack(barsX0, reach, 0.4), onRack(W / 2, reach, 0)]);
      const weir = new Box3(
        new Vector3(-W / 2, Y_WEIR - INTAKE.weirThickness - 0.3, INTAKE.weirCrestZ - 0.6),
        new Vector3(W / 2, Y_WEIR + 0.3, Math.max(lastWaterZ, INTAKE.weirCrestZ) + 0.3),
      );
      const gauge = new Box3(new Vector3(gaugeX - 0.3, INTAKE.gaugeY - 0.3, gz0), new Vector3(gaugeX + 0.3, INTAKE.gaugeY + 0.3, RIM));
      return [
        { key: 'rack', box: rack },
        { key: 'debris', box: debrisBox },
        { key: 'weir', box: weir },
        { key: 'gauge', box: gauge },
      ];
    },
  };
}
