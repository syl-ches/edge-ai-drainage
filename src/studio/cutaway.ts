// Ultra-HD Pitch Studio, Mode A: square architectural + geological cutaway diorama on a plinth.
// Scene metres, y up, surface at y = 0, block x in [-10, 10], z in [-7, 7]; the front face z = 7
// is the cut plane through the drainage centreline (shafts, box culvert and outflow pipe are
// sliced open). Clipping at z = 7 keeps water and acoustic rings inside the section.
import {
  BoxGeometry,
  BufferAttribute,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Plane,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  TorusGeometry,
  Vector3,
  AdditiveBlending,
  type Material,
  type Texture,
} from 'three';
import { AcousticBouncer } from './acoustic';
import { STUDIO_WATER, studioWaterTone } from './tankSim';
import { asphaltTexture, grateTextures, labelTexture, pavingTexture, strataTextures, streamTexture, turfTexture, BLOCK_DEPTH_M } from './textures';

export const CUT = {
  xMin: -10,
  xMax: 10,
  zBack: -7,
  zFront: 7,
  base: -BLOCK_DEPTH_M,
  culvert: { xL: -8.3, xR: 6.0, invert: -6.0, rise: 2.7, span: 2.5, wall: 0.3 },
  leftShaft: { x: -7, r: 0.6, wall: 0.2 },
  rightShaft: { x: 6.5, r: 0.6, wall: 0.2, sump: -6.9 },
  pipe: { y: -5.55, r: 0.45, wall: 0.1, x0: 7.1, x1: 10.8 },
  sensorY: -0.75,
} as const;
const CROWN = CUT.culvert.invert + CUT.culvert.rise; // -3.3

export interface CutawayState {
  /** fill %, 0..120 (100 % = culvert full, above that the water climbs the shafts) */
  fill: number;
  rainMmHr: number;
  chopMm: number;
}

export interface CutawayReadout {
  waterY: number;
  airGapMm: number;
  waterDepthM: number;
}

export interface Cutaway {
  group: Group;
  sensorAnchor: Vector3;
  update(t: number, dt: number, s: CutawayState): CutawayReadout;
}

/** Water surface height in the left (sensor) shaft for a fill %. */
export function cutawayWaterY(fillPct: number): number {
  const f = Math.max(fillPct, 0) / 100;
  if (f <= 1) return CUT.culvert.invert + f * CUT.culvert.rise;
  return Math.min(CROWN + ((f - 1) / 0.2) * (CUT.sensorY - 0.1 - CROWN), CUT.sensorY - 0.1);
}

const concrete = () => new MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.82, metalness: 0.02 });

function box(w: number, h: number, d: number, m: Material, x: number, y: number, z: number, shadow = true): Mesh {
  const mesh = new Mesh(new BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  return mesh;
}

function polyShape(pts: [number, number][]): Shape {
  const s = new Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}

export function buildCutaway(): Cutaway {
  const g = new Group();
  g.name = 'cutaway';
  const clip = [new Plane(new Vector3(0, 0, -1), CUT.zFront)];
  const { map: strataMap, bump: strataBump } = strataTextures();
  const W = CUT.xMax - CUT.xMin;
  const D = CUT.zFront - CUT.zBack;
  const H = -CUT.base;

  // ---------------------------------------------------------------- plinth
  const plinth = box(W + 1.6, 0.9, D + 1.6, new MeshPhysicalMaterial({ color: '#0b1220', roughness: 0.35, metalness: 0.4, clearcoat: 0.6 }), 0, CUT.base - 0.45, 0);
  const lip = box(W + 1.7, 0.06, D + 1.7, new MeshStandardMaterial({ color: '#10b981', emissive: '#10b981', emissiveIntensity: 0.6 }), 0, CUT.base - 0.02, 0, false);
  g.add(plinth, lip);

  // ---------------------------------------------------------------- geological faces
  const faceMat = (repeatU: number, offU: number) => {
    const m = strataMap.clone();
    const b = strataBump.clone();
    for (const t of [m, b] as Texture[]) {
      t.repeat.set(repeatU, 1 / H);
      t.offset.set(offU, 1);
      t.needsUpdate = true;
    }
    return new MeshStandardMaterial({ map: m, bumpMap: b, bumpScale: 2.2, roughness: 0.95, side: DoubleSide });
  };
  const frontMat = faceMat(1 / W, 0.5);
  const cv = CUT.culvert;
  const ls = CUT.leftShaft;
  const rs = CUT.rightShaft;
  const pp = CUT.pipe;
  const lo = ls.r + ls.wall;
  const ro = rs.r + rs.wall;
  const pOut = pp.r + pp.wall;
  const frontShapes = [
    // main body: everything around and below the drainage opening
    polyShape([
      [CUT.xMin, 0],
      [ls.x - lo, 0],
      [ls.x - lo, cv.invert + cv.rise + cv.wall],
      [cv.xL, cv.invert + cv.rise + cv.wall],
      [cv.xL, cv.invert - cv.wall],
      [rs.x - ro, cv.invert - cv.wall],
      [rs.x - ro, rs.sump - 0.2],
      [rs.x + ro, rs.sump - 0.2],
      [rs.x + ro, pp.y - pOut],
      [CUT.xMax, pp.y - pOut],
      [CUT.xMax, CUT.base],
      [CUT.xMin, CUT.base],
    ]),
    // island between the two shafts, above the culvert
    polyShape([
      [ls.x + lo, 0],
      [rs.x - ro, 0],
      [rs.x - ro, cv.invert + cv.rise + cv.wall],
      [ls.x + lo, cv.invert + cv.rise + cv.wall],
    ]),
    // island right of the right shaft, above the pipe
    polyShape([
      [rs.x + ro, 0],
      [CUT.xMax, 0],
      [CUT.xMax, pp.y + pOut],
      [rs.x + ro, pp.y + pOut],
    ]),
  ];
  for (const sh of frontShapes) {
    const m = new Mesh(new ShapeGeometry(sh), frontMat);
    m.position.z = CUT.zFront;
    m.receiveShadow = true;
    g.add(m);
  }
  const sideMat = faceMat(1 / D, 0.5);
  const left = new Mesh(new ShapeGeometry(polyShape([[-D / 2, CUT.base], [D / 2, CUT.base], [D / 2, 0], [-D / 2, 0]])), sideMat);
  left.rotation.y = -Math.PI / 2;
  left.position.x = CUT.xMin;
  // right face, with the half-pipe notch at its front edge (shape x = -z)
  const right = new Mesh(
    new ShapeGeometry(
      polyShape([
        [-CUT.zFront, 0],
        [-CUT.zBack, 0],
        [-CUT.zBack, CUT.base],
        [-CUT.zFront, CUT.base],
        [-CUT.zFront, pp.y - pOut],
        [-(CUT.zFront - pOut), pp.y - pOut],
        [-(CUT.zFront - pOut), pp.y + pOut],
        [-CUT.zFront, pp.y + pOut],
      ]),
    ),
    sideMat,
  );
  right.rotation.y = Math.PI / 2;
  right.position.x = CUT.xMax;
  const back = new Mesh(new ShapeGeometry(polyShape([[CUT.xMin, CUT.base], [CUT.xMax, CUT.base], [CUT.xMax, 0], [CUT.xMin, 0]])), frontMat);
  back.position.z = CUT.zBack;
  back.rotation.y = Math.PI;
  // dark soil interior so nothing behind the section reads as empty space
  const interior = box(W - 0.02, H - 0.02, D - 0.02, new MeshStandardMaterial({ color: '#2a2018', roughness: 1, side: 1 }), 0, CUT.base / 2, 0, false);
  g.add(left, right, back, interior);

  // ---------------------------------------------------------------- sliced concrete drainage
  const conc = concrete();
  const zIn = CUT.zFront - cv.span / 2; // inner back wall plane of the half culvert
  const len = cv.xR - cv.xL;
  const cx = (cv.xL + cv.xR) / 2;
  g.add(
    box(len, cv.rise + 2 * cv.wall, cv.wall, conc, cx, cv.invert + cv.rise / 2, zIn - cv.wall / 2), // back wall
    box(len, cv.wall, cv.span / 2 + cv.wall, conc, cx, cv.invert - cv.wall / 2, CUT.zFront - (cv.span / 2 + cv.wall) / 2), // floor
    box(cv.wall, cv.rise, cv.span / 2, conc, cv.xL + cv.wall / 2, cv.invert + cv.rise / 2, CUT.zFront - cv.span / 4), // left end
  );
  // roof slab, open where the left shaft drops in
  const roofY = CROWN + cv.wall / 2;
  const roofD = cv.span / 2 + cv.wall;
  const roofZ = CUT.zFront - roofD / 2;
  g.add(box(ls.x - ls.r - cv.xL, cv.wall, roofD, conc, (cv.xL + ls.x - ls.r) / 2, roofY, roofZ));
  g.add(box(cv.xR - (ls.x + ls.r), cv.wall, roofD, conc, (cv.xR + ls.x + ls.r) / 2, roofY, roofZ));
  // corner haunches (DPWH 229 mm chamfers) along the back wall
  const haunch = (yCorner: number, up: boolean) => {
    const t = 0.23;
    const sh = polyShape(up ? [[zIn, yCorner], [zIn + t, yCorner], [zIn, yCorner + t]] : [[zIn, yCorner], [zIn + t, yCorner], [zIn, yCorner - t]]);
    const geo = new ExtrudeGeometry(sh, { depth: len - cv.wall, bevelEnabled: false });
    const m = new Mesh(geo, conc);
    m.rotation.y = -Math.PI / 2;
    m.position.x = cv.xR;
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  g.add(haunch(cv.invert, true), haunch(CROWN, false));
  // crystal-clear cutaway window on the open culvert face
  const glass = new Mesh(
    new PlaneGeometry(len - cv.wall, cv.rise),
    new MeshPhysicalMaterial({ color: '#e0f2fe', transmission: 1, roughness: 0, thickness: 0.02, transparent: true, opacity: 0.18, ior: 1.5 }),
  );
  glass.position.set(cx + cv.wall / 2, cv.invert + cv.rise / 2, CUT.zFront + 0.01);
  g.add(glass);

  const halfShaft = (x: number, r: number, wall: number, yTop: number, yBot: number) => {
    const h = yTop - yBot;
    const outer = new Mesh(new CylinderGeometry(r + wall, r + wall, h, 64, 1, true, Math.PI / 2, Math.PI), conc);
    const inner = new Mesh(new CylinderGeometry(r, r, h, 64, 1, true, Math.PI / 2, Math.PI), new MeshStandardMaterial({ color: '#a7abaf', roughness: 0.9, side: 1 }));
    for (const m of [outer, inner]) {
      m.position.set(x, (yTop + yBot) / 2, CUT.zFront);
      m.receiveShadow = true;
    }
    // sliced wall section (the cut face of the concrete ring)
    const ringCut = (side: number) => box(wall, h, 0.02, conc, x + side * (r + wall / 2), (yTop + yBot) / 2, CUT.zFront - 0.01, false);
    g.add(outer, inner, ringCut(-1), ringCut(1));
  };
  halfShaft(ls.x, ls.r, ls.wall, 0, CROWN + cv.wall);
  halfShaft(rs.x, rs.r, rs.wall, 0, rs.sump);
  g.add(box(2 * ro, 0.2, ro, conc, rs.x, rs.sump - 0.1, CUT.zFront - ro / 2)); // sump base
  // circular outflow pipe (back half), protruding past the right face
  const pipe = new Mesh(new CylinderGeometry(pOut, pOut, pp.x1 - pp.x0, 64, 1, true, Math.PI / 2, Math.PI), conc);
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set((pp.x0 + pp.x1) / 2, pp.y, CUT.zFront);
  const pipeIn = new Mesh(new CylinderGeometry(pp.r, pp.r, pp.x1 - pp.x0, 64, 1, true, Math.PI / 2, Math.PI), new MeshStandardMaterial({ color: '#9ca3af', roughness: 0.85, side: 1 }));
  pipeIn.rotation.z = Math.PI / 2;
  pipeIn.position.copy(pipe.position);
  pipe.castShadow = true;
  g.add(pipe, pipeIn);

  // ---------------------------------------------------------------- top surface
  const asphalt = asphaltTexture();
  asphalt.repeat.set(0.25, 0.25);
  const notch = (x: number, r: number) => {
    const pts: [number, number][] = [];
    for (let k = 0; k <= 24; k++) {
      const a = Math.PI - (k / 24) * Math.PI;
      pts.push([x + r * Math.cos(a), CUT.zFront - r * Math.sin(a)]);
    }
    return pts;
  };
  const roadShape = polyShape([
    [CUT.xMin, CUT.zFront],
    ...notch(ls.x, lo),
    ...notch(rs.x, ro),
    [CUT.xMax, CUT.zFront],
    [CUT.xMax, CUT.zBack],
    [CUT.xMin, CUT.zBack],
  ]);
  const road = new Mesh(new ExtrudeGeometry(roadShape, { depth: 0.2, bevelEnabled: false }), new MeshStandardMaterial({ map: asphalt, roughness: 0.92 }));
  road.rotation.x = Math.PI / 2;
  road.receiveShadow = true;
  g.add(road);
  const paveTex = pavingTexture();
  const paving = new MeshStandardMaterial({ map: paveTex, roughness: 0.8 });
  const curb = new MeshStandardMaterial({ color: '#e5e7eb', roughness: 0.6 });
  const turf = new MeshStandardMaterial({ map: turfTexture(), roughness: 1 });
  const roadEdgeZ = 3.4;
  const crossX = 2.2;
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? CUT.xMin : crossX;
    const x1 = side < 0 ? -crossX : CUT.xMax;
    const w = x1 - x0;
    const dz = roadEdgeZ - CUT.zBack;
    g.add(box(w, 0.15, dz, paving, (x0 + x1) / 2, 0.075, (CUT.zBack + roadEdgeZ) / 2));
    g.add(box(w, 0.22, 0.22, curb, (x0 + x1) / 2, 0.11, roadEdgeZ - 0.11)); // curb along the front road
    g.add(box(0.22, 0.22, dz, curb, side < 0 ? x1 - 0.11 : x0 + 0.11, 0.11, (CUT.zBack + roadEdgeZ) / 2)); // curb along the cross road
    const turfBox = box(w - 2.6, 0.04, dz - 2.4, turf, (x0 + x1) / 2 + side * 0.2, 0.17, (CUT.zBack + roadEdgeZ) / 2 - 0.4);
    g.add(turfBox);
  }
  const paint = new MeshStandardMaterial({ color: '#f8fafc', roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0.05 });
  for (let z = 3.65; z < 6.9; z += 0.55) g.add(box(2.2, 0.012, 0.3, paint, -4.1, 0.006, z, false)); // zebra across the front road
  for (let x = -1.85; x < 1.9; x += 0.55) g.add(box(0.3, 0.012, 2.0, paint, x, 0.006, 2.2, false)); // zebra across the cross road
  for (let x = -9.5; x < 9.5; x += 1.8) if (x < -5.6 || x > -2.6) g.add(box(1.0, 0.012, 0.12, paint, x + 0.5, 0.006, 5.2, false)); // lane dashes
  for (let z = -6.5; z < 0.8; z += 1.8) g.add(box(0.12, 0.012, 1.0, paint, 0, 0.006, z + 0.5, false));

  // slotted cast-iron grates (half discs on the cut edge)
  const grate = grateTextures();
  const grateMat = new MeshStandardMaterial({ map: grate.map, alphaMap: grate.alpha, alphaTest: 0.5, metalness: 0.75, roughness: 0.45, side: DoubleSide });
  for (const [x, r] of [
    [ls.x, ls.r],
    [rs.x, rs.r],
  ] as const) {
    const disc = new Mesh(new CircleGeometry(r, 96, 0, Math.PI), grateMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.004, CUT.zFront);
    disc.castShadow = true;
    g.add(disc);
  }

  // frosted architectural buildings with floor slabs and window framing
  const frosted = new MeshPhysicalMaterial({ color: '#f8fafc', transmission: 0.62, roughness: 0.32, thickness: 0.6, ior: 1.35, clearcoat: 0.4 });
  const slabMat = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.7 });
  const frameMat = new LineBasicMaterial({ color: '#64748b', transparent: true, opacity: 0.85 });
  const buildingSpecs: [number, number, number, number, number][] = [
    [-7.2, -3.6, 3.4, 3.6, 7.2],
    [-4.4, -0.4, 2.4, 2.4, 4.4],
    [6.6, -4.0, 3.8, 3.6, 8.6],
    [4.1, 0.1, 2.3, 2.6, 3.6],
  ];
  for (const [x, z, w, d, h] of buildingSpecs) {
    const y0 = 0.15;
    const shell = box(w, h, d, frosted, x, y0 + h / 2, z);
    g.add(shell);
    for (let fy = 1.0; fy < h - 0.2; fy += 1.0) g.add(box(w - 0.12, 0.06, d - 0.12, slabMat, x, y0 + fy, z, false));
    const pos: number[] = [];
    const seg = (a: [number, number, number], b: [number, number, number]) => pos.push(...a, ...b);
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    for (let fy = 0; fy <= h + 1e-6; fy += 1.0) {
      const y = y0 + Math.min(fy, h);
      seg([x0, y, z1], [x1, y, z1]);
      seg([x0, y, z0], [x1, y, z0]);
      seg([x0, y, z0], [x0, y, z1]);
      seg([x1, y, z0], [x1, y, z1]);
    }
    for (let xx = x0; xx <= x1 + 1e-6; xx += w / Math.max(Math.round(w / 0.8), 1)) {
      seg([xx, y0, z1], [xx, y0 + h, z1]);
      seg([xx, y0, z0], [xx, y0 + h, z0]);
    }
    for (let zz = z0; zz <= z1 + 1e-6; zz += d / Math.max(Math.round(d / 0.8), 1)) {
      seg([x0, y0, zz], [x0, y0 + h, zz]);
      seg([x1, y0, zz], [x1, y0 + h, zz]);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.add(new LineSegments(geo, frameMat));
  }
  // lush multi-cluster trees
  const trunkMat = new MeshStandardMaterial({ color: '#7c5a3a', roughness: 0.9 });
  const leafMats = ['#15803d', '#16a34a', '#22c55e', '#4ade80'].map((c) => new MeshStandardMaterial({ color: c, roughness: 0.75, flatShading: true }));
  const crown = new IcosahedronGeometry(1, 1);
  const treeSpots: [number, number][] = [
    [-9.0, 1.6], [-5.6, 2.2], [-9.2, -6.0], [-3.2, -5.6], [-2.9, 1.8],
    [9.1, 1.6], [3.0, -6.2], [9.2, -6.3], [3.1, 2.4], [5.6, 2.3],
  ];
  treeSpots.forEach(([x, z], i) => {
    const s = 0.7 + ((i * 37) % 10) / 25;
    const trunk = new Mesh(new CylinderGeometry(0.08 * s, 0.12 * s, 1.4 * s, 10), trunkMat);
    trunk.position.set(x, 0.19 + 0.7 * s, z);
    trunk.castShadow = true;
    g.add(trunk);
    for (let k = 0; k < 4; k++) {
      const c = new Mesh(crown, leafMats[(i + k) % 4]);
      const a = (k / 4) * Math.PI * 2 + i;
      c.position.set(x + Math.cos(a) * 0.35 * s, 0.19 + (1.55 + (k % 2) * 0.35) * s, z + Math.sin(a) * 0.35 * s);
      c.scale.setScalar((0.55 + (k === 0 ? 0.15 : 0)) * s);
      c.castShadow = true;
      g.add(c);
    }
  });

  // ---------------------------------------------------------------- water volumes
  const waterMat = new MeshPhysicalMaterial({
    color: '#06B6D4',
    emissive: '#06B6D4',
    emissiveIntensity: 0.25,
    transmission: 0.35,
    roughness: 0.06,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.86,
    side: DoubleSide,
    clippingPlanes: clip,
  });
  const culvertWater = new Mesh(new BoxGeometry(1, 1, 1), waterMat);
  const wlen = len - cv.wall;
  const wcx = cx + cv.wall / 2;
  const SEG = 128;
  const surfGeo = new PlaneGeometry(wlen, cv.span / 2, SEG, SEG);
  surfGeo.rotateX(-Math.PI / 2);
  const surf = new Mesh(surfGeo, waterMat);
  surf.position.set(wcx, 0, zIn + cv.span / 4);
  const surfBase = Float32Array.from((surfGeo.getAttribute('position') as BufferAttribute).array);
  const shaftWater = (x: number, r: number) => {
    const body = new Mesh(new CylinderGeometry(r - 0.01, r - 0.01, 1, 64, 1, false, Math.PI / 2, Math.PI), waterMat);
    body.position.set(x, 0, CUT.zFront);
    const topGeo = new CircleGeometry(r - 0.01, 64, 0, Math.PI);
    topGeo.rotateX(-Math.PI / 2);
    const top = new Mesh(topGeo, waterMat);
    top.position.set(x, 0, CUT.zFront);
    g.add(body, top);
    return { body, top };
  };
  const leftW = shaftWater(ls.x, ls.r);
  const rightW = shaftWater(rs.x, rs.r);
  const pipeWater = new Mesh(new BoxGeometry(1, 1, 1), waterMat);
  // waterfall sheet out of the pipe mouth
  const stream = streamTexture();
  const fallMat = new MeshPhysicalMaterial({ map: stream, color: '#22D3EE', transparent: true, opacity: 0.75, roughness: 0.1, transmission: 0.2, side: DoubleSide, depthWrite: false });
  const fallGeo = new PlaneGeometry(0.62, 1, 1, 24);
  const fallBase = Float32Array.from((fallGeo.getAttribute('position') as BufferAttribute).array);
  const fall = new Mesh(fallGeo, fallMat);
  fall.rotation.y = Math.PI / 2;
  g.add(culvertWater, surf, pipeWater, fall);

  // ---------------------------------------------------------------- Edge-AI sensor unit
  const sensorX = ls.x;
  const sensorZ = CUT.zFront - 0.18;
  const enclosure = box(0.62, 0.3, 0.26, new MeshPhysicalMaterial({ color: '#0f172a', roughness: 0.3, metalness: 0.2, clearcoat: 0.8 }), sensorX, CUT.sensorY + 0.32, CUT.zFront - ls.r + 0.14);
  const label = new Mesh(new PlaneGeometry(0.58, 0.26), new MeshBasicMaterial({ map: labelTexture(['ESP32-S3', 'EDGE-AI NODE'], { w: 512, h: 224, bg: '#0f172a', fg: '#34d399' }) }));
  label.position.set(sensorX, CUT.sensorY + 0.32, CUT.zFront - ls.r + 0.275);
  const bracket = box(0.08, 0.08, 0.5, new MeshStandardMaterial({ color: '#94a3b8', metalness: 0.8, roughness: 0.35 }), sensorX, CUT.sensorY + 0.12, sensorZ - 0.1);
  const cone = new Mesh(new ConeGeometry(0.16, 0.24, 48, 1, true), new MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.9, roughness: 0.25, side: DoubleSide }));
  cone.position.set(sensorX, CUT.sensorY + 0.06, sensorZ);
  const face = new Mesh(new CircleGeometry(0.16, 48), new MeshStandardMaterial({ color: '#1e293b', metalness: 0.4, roughness: 0.5 }));
  face.rotation.x = Math.PI / 2;
  face.position.set(sensorX, CUT.sensorY - 0.06, sensorZ);
  const antenna = new Mesh(new CylinderGeometry(0.012, 0.012, 0.35, 8), new MeshStandardMaterial({ color: '#334155' }));
  antenna.position.set(sensorX + 0.24, CUT.sensorY + 0.6, CUT.zFront - ls.r + 0.14);
  g.add(enclosure, label, bracket, cone, face, antenna);

  // ---------------------------------------------------------------- acoustic rings
  const ringGeo = new TorusGeometry(1, 0.022, 10, 96);
  ringGeo.rotateX(Math.PI / 2);
  const mkRingMat = (c: string) =>
    new MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, clippingPlanes: clip });
  const ringPool = Array.from({ length: 16 }, () => {
    const m = new Mesh(ringGeo, mkRingMat('#22D3EE'));
    m.visible = false;
    g.add(m);
    return m;
  });
  const impactPool = Array.from({ length: 8 }, () => {
    const m = new Mesh(ringGeo, mkRingMat('#FACC15'));
    m.visible = false;
    g.add(m);
    return m;
  });
  const bouncer = new AcousticBouncer(3.2);
  const faceY = CUT.sensorY - 0.06;

  // ---------------------------------------------------------------- rain curtain + splashes
  const RAIN = 1800;
  const rainPos = new Float32Array(RAIN * 6);
  const rainSeed = Array.from({ length: RAIN }, (_, i) => [((i * 7919) % 2000) / 100 - 10, ((i * 104729) % 1400) / 100 - 7, ((i * 1301) % 1000) / 1000, (i % 97) / 97]);
  const rainGeo = new BufferGeometry();
  rainGeo.setAttribute('position', new BufferAttribute(rainPos, 3));
  const rain = new LineSegments(rainGeo, new LineBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.7 }));
  rain.frustumCulled = false;
  const splashGeo = new TorusGeometry(1, 0.012, 6, 48);
  splashGeo.rotateX(Math.PI / 2);
  const splashes = Array.from({ length: 36 }, (_, i) => {
    const m = new Mesh(splashGeo, new MeshBasicMaterial({ color: '#e0f2fe', transparent: true, opacity: 0.8, depthWrite: false }));
    m.position.set(((i * 6151) % 1900) / 100 - 9.5, 0.01, 3.6 + ((i * 3571) % 330) / 100);
    m.userData.phase = (i * 0.37) % 1;
    g.add(m);
    return m;
  });
  const trickles = [ls.x, rs.x].map((x) => {
    const m = new Mesh(new CylinderGeometry(0.03, 0.05, 1, 12, 1, true), new MeshPhysicalMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.7, roughness: 0.1, clippingPlanes: clip }));
    m.position.set(x, 0, CUT.zFront - 0.25);
    g.add(m);
    return m;
  });
  g.add(rain);

  const tmpColor = new Color();
  const tone = (fill: number, t: number) => {
    const [a, b] = STUDIO_WATER[studioWaterTone(fill)];
    const k = studioWaterTone(fill) === 'alarm' ? 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 3) : 0.3;
    return tmpColor.set(a).lerp(new Color(b), k);
  };

  return {
    group: g,
    sensorAnchor: new Vector3(sensorX, CUT.sensorY + 0.6, CUT.zFront),
    update(t, dt, s) {
      const fill = Math.max(s.fill, 0);
      const f = fill / 100;
      const hC = Math.min(f, 1) * cv.rise;
      const surfY = cv.invert + hC;
      const shaftY = cutawayWaterY(fill);
      const c = tone(fill, t);
      waterMat.color.copy(c);
      waterMat.emissive.copy(c);
      waterMat.emissiveIntensity = studioWaterTone(fill) === 'alarm' ? 0.55 : 0.25;
      // culvert body + 128 x 128 wave surface
      culvertWater.visible = surf.visible = hC > 0.01;
      culvertWater.scale.set(wlen, Math.max(hC, 0.001), cv.span / 2);
      culvertWater.position.set(wcx, cv.invert + hC / 2, zIn + cv.span / 4);
      const amp = f >= 1 ? 0.004 : 0.015 + (s.chopMm / 16) * 0.09 + s.rainMmHr * 0.0002;
      const arr = (surfGeo.getAttribute('position') as BufferAttribute).array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = surfBase[i];
        const z = surfBase[i + 2];
        const h =
          amp * Math.sin(x * 1.7 - t * 2.4) +
          amp * 0.6 * Math.sin(x * 3.1 + z * 4.2 + t * 3.3) +
          amp * 0.35 * Math.sin(-x * 5.3 + z * 7.1 - t * 5.1) +
          amp * 0.2 * Math.sin(x * 11 + t * 7);
        arr[i + 1] = Math.min(surfY + h, CROWN - 0.005);
      }
      surfGeo.getAttribute('position').needsUpdate = true;
      surfGeo.computeVertexNormals();
      // shafts: right shaft always holds water to the culvert level; left shaft only when surcharged
      const rTop = f > 1 ? shaftY : surfY;
      const rH = rTop - rs.sump;
      rightW.body.scale.y = Math.max(rH, 0.001);
      rightW.body.position.y = rs.sump + rH / 2;
      rightW.top.position.y = rTop + 0.01 * Math.sin(t * 3);
      const lH = shaftY - CROWN;
      leftW.body.visible = leftW.top.visible = f > 1 && lH > 0.01;
      leftW.body.scale.y = Math.max(lH, 0.001);
      leftW.body.position.y = CROWN + lH / 2;
      leftW.top.position.y = shaftY + 0.015 * Math.sin(t * 4);
      // outflow pipe + waterfall (flow grows with depth)
      const pH = Math.min(hC, 2 * pp.r * 0.95);
      pipeWater.visible = pH > 0.01;
      pipeWater.scale.set(pp.x1 - pp.x0, Math.max(pH, 0.001), Math.min(pp.r * 0.9, Math.sqrt(Math.max(2 * pp.r * pH - pH * pH, 0))));
      pipeWater.position.set((pp.x0 + pp.x1) / 2, cv.invert + pH / 2, CUT.zFront - pipeWater.scale.z / 2);
      const flow = Math.min(pH / (2 * pp.r), 1);
      fall.visible = flow > 0.02;
      const fArr = (fallGeo.getAttribute('position') as BufferAttribute).array as Float32Array;
      const drop = cv.invert + pH - (CUT.base - 0.9);
      for (let i = 0; i < fArr.length; i += 3) {
        const v = 0.5 - fallBase[i + 1]; // 0 at the lip, 1 at the plinth
        fArr[i + 1] = cv.invert + pH - v * drop;
        fArr[i + 2] = 0.15 + 1.4 * flow * Math.sqrt(v); // parabolic throw away from the face (local +z -> world +x)
      }
      fallGeo.getAttribute('position').needsUpdate = true;
      fall.position.set(pp.x1, 0, CUT.zFront - pp.r * 0.6);
      fallMat.opacity = 0.35 + 0.5 * flow;
      fallMat.color.copy(c);
      stream.offset.y = (t * 1.8) % 1;
      // acoustic bounce in the left shaft
      const waterForSonar = f > 1 ? shaftY : surfY;
      bouncer.update(dt, faceY, waterForSonar);
      ringPool.forEach((m, i) => {
        const r = bouncer.rings[i];
        m.visible = !!r;
        if (!r) return;
        const radius = Math.min(0.1 + r.travelled * 0.12, ls.r - 0.04);
        m.position.set(sensorX, r.y, sensorZ);
        m.scale.setScalar(radius);
        const mat = m.material as MeshBasicMaterial;
        mat.color.set(r.dir === 'down' ? '#22D3EE' : r.travelled % 2 < 1 ? '#34D399' : '#FACC15');
        mat.opacity = Math.max(0.95 - r.travelled * 0.07, 0.35);
      });
      impactPool.forEach((m, i) => {
        const im = bouncer.impacts[i];
        m.visible = !!im;
        if (!im) return;
        m.position.set(sensorX, im.y + 0.01, sensorZ);
        m.scale.setScalar(0.1 + im.age * 0.8);
        (m.material as MeshBasicMaterial).opacity = Math.max(1 - im.age / 0.6, 0);
      });
      // rain + splash rings + grate trickles
      const density = Math.min(s.rainMmHr / 150, 1);
      rain.visible = density > 0.001;
      const shown = Math.floor(RAIN * density);
      for (let i = 0; i < RAIN; i++) {
        const [x, z, ph] = rainSeed[i];
        const y = 12 - (((t * 9 + ph * 12) % 12) + 12) % 12;
        const o = i * 6;
        const on = i < shown;
        rainPos[o] = rainPos[o + 3] = x;
        rainPos[o + 2] = rainPos[o + 5] = z;
        rainPos[o + 1] = on ? y : -100;
        rainPos[o + 4] = on ? y + 0.35 : -100;
      }
      rainGeo.getAttribute('position').needsUpdate = true;
      splashes.forEach((m, i) => {
        const p = (t * 1.6 + (m.userData.phase as number)) % 1;
        m.visible = density > 0.001 && i < 36 * density + 4;
        m.scale.setScalar(0.04 + p * 0.28);
        (m.material as MeshBasicMaterial).opacity = (1 - p) * 0.8;
      });
      trickles.forEach((m, i) => {
        const bottom = i === 0 ? Math.max(waterForSonar, CROWN) : rTop;
        m.visible = density > 0.02;
        m.scale.y = Math.max(-bottom, 0.01);
        m.position.y = bottom / 2;
        (m.material as MeshPhysicalMaterial).opacity = 0.3 + 0.5 * density;
      });
      const airGapMm = Math.max(faceY - waterForSonar, 0) * 1000;
      return { waterY: waterForSonar, airGapMm, waterDepthM: Math.max(waterForSonar - cv.invert, 0) };
    },
  };
}
