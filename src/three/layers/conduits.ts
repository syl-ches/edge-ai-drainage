import {
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Matrix3,
  Matrix4,
  Mesh,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  Shape,
  Vector3,
} from 'three';
import type { Conduit } from '../../types/twin';
import type { TwinState } from '../../utils/lutInterpolator';
import type { LocalFrame } from '../frame';
import { conduitCoreFragment, conduitEdgeFragment, conduitShellFragment, conduitVertex } from '../shaders/conduit';
import { THEME_UNIFORMS } from '../theme';

const WORLD_UP = new Vector3(0, 0, 1);

export interface ConduitAxis {
  index: number;
  id: string;
  a: Vector3; // centroid of inlet cross-section (scene m)
  b: Vector3; // centroid of outlet cross-section
}

export interface ConduitsLayer {
  group: Group;
  axes: ConduitAxis[];
  indexOf: Map<string, number>;
  applyState(st: TwinState): void;
  setPipeScale(k: number): void;
  setTime(t: number): void;
  setHover(index: number): void;
  setSelected(index: number): void;
}

/** Orthonormal conduit frame: X lateral (horizontal), Y up (normal to axis), Z downstream axis. */
function conduitBasis(a: Vector3, b: Vector3) {
  const dir = b.clone().sub(a).normalize();
  const lateral = new Vector3().crossVectors(dir, WORLD_UP).normalize();
  const up = new Vector3().crossVectors(lateral, dir).normalize();
  return { dir, lateral, up, length: a.distanceTo(b) };
}

/** True as-built cross-section in (x lateral, y above invert). */
function crossSection(c: Conduit): Shape {
  const w = c.geometry.span_m;
  const h = c.geometry.rise_m;
  const s = new Shape();
  if (c.shape === 'ARCH') {
    const r = w / 2;
    s.moveTo(-r, 0);
    s.lineTo(r, 0);
    s.lineTo(r, h - r);
    s.absarc(0, h - r, r, 0, Math.PI, false);
    s.lineTo(-r, 0);
    return s;
  }
  const k = c.geometry.haunch_m ?? 0; // RECT_CLOSED with chamfered corner haunches
  s.moveTo(-w / 2 + k, 0);
  s.lineTo(w / 2 - k, 0);
  s.lineTo(w / 2, k);
  s.lineTo(w / 2, h - k);
  s.lineTo(w / 2 - k, h);
  s.lineTo(-w / 2 + k, h);
  s.lineTo(-w / 2, h - k);
  s.lineTo(-w / 2, k);
  s.lineTo(-w / 2 + k, 0);
  return s;
}

interface SweptBuffers {
  position: number[];
  normal: number[];
  center: number[];
  u: number[];
  t: number[];
  s: number[];
  conduit: number[];
}

function emptyBuffers(): SweptBuffers {
  return { position: [], normal: [], center: [], u: [], t: [], s: [], conduit: [] };
}

/** Bake extrude-space (x, y, z) vertices into scene space plus flow-shader attributes. */
function appendSwept(out: SweptBuffers, local: ArrayLike<number>, normals: ArrayLike<number> | null, c: Conduit, index: number, m: Matrix4) {
  const v = new Vector3();
  const ctr = new Vector3();
  const nrm = new Vector3();
  const rot = new Matrix3().setFromMatrix4(m); // orthonormal basis: rotates normals
  const w = c.geometry.span_m;
  const h = c.geometry.rise_m;
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i];
    const y = local[i + 1];
    const z = local[i + 2];
    v.set(x, y, z).applyMatrix4(m);
    ctr.set(0, h / 2, z).applyMatrix4(m);
    if (normals) nrm.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix3(rot).normalize();
    else nrm.set(0, 0, 1);
    out.position.push(v.x, v.y, v.z);
    out.normal.push(nrm.x, nrm.y, nrm.z);
    out.center.push(ctr.x, ctr.y, ctr.z);
    out.u.push(z);
    out.t.push(y / h);
    out.s.push(x / w);
    out.conduit.push(index);
  }
}

function sweptGeometry(b: SweptBuffers): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(b.position, 3));
  g.setAttribute('normal', new Float32BufferAttribute(b.normal, 3));
  g.setAttribute('aCenter', new Float32BufferAttribute(b.center, 3));
  g.setAttribute('aU', new Float32BufferAttribute(b.u, 1));
  g.setAttribute('aT', new Float32BufferAttribute(b.t, 1));
  g.setAttribute('aS', new Float32BufferAttribute(b.s, 1));
  g.setAttribute('aConduit', new Float32BufferAttribute(b.conduit, 1));
  return g;
}

export function buildConduits(conduits: Conduit[], frame: LocalFrame, cameraPos: Vector3): ConduitsLayer {
  const n = conduits.length;
  const stateData = new Float32Array(n * 4);
  const stateTex = new DataTexture(stateData, n, 1, RGBAFormat, FloatType);
  stateTex.minFilter = NearestFilter;
  stateTex.magFilter = NearestFilter;
  stateTex.needsUpdate = true;

  const uniforms = {
    uState: { value: stateTex },
    uPipeScale: { value: 1 },
    uTime: { value: 0 },
    uHover: { value: -1 },
    uSelected: { value: -1 },
    uFlowSpeed: { value: 3.0 },
    uDay: THEME_UNIFORMS.uDay,
    uCameraPos: { value: cameraPos },
  };

  const surfaces = emptyBuffers();
  const edges = emptyBuffers();
  const circular: { c: Conduit; index: number; m: Matrix4 }[] = [];
  const axes: ConduitAxis[] = [];
  const indexOf = new Map<string, number>();

  conduits.forEach((c, index) => {
    indexOf.set(c.id, index);
    const [p0, p1] = c.coordinates;
    const a = frame.toLocal(p0[0], p0[1], p0[2]);
    const b = frame.toLocal(p1[0], p1[1], p1[2]);
    const { dir, lateral, up, length } = conduitBasis(a, b);
    const half = c.geometry.rise_m / 2;
    axes.push({ index, id: c.id, a: a.clone().addScaledVector(up, half), b: b.clone().addScaledVector(up, half) });

    if (c.shape === 'CIRCULAR') {
      // Unit cylinder: X lateral, Y axis (0..1), Z up; centred on the pipe axis.
      const d = c.geometry.diameter_m ?? c.geometry.rise_m;
      const m = new Matrix4()
        .makeBasis(lateral.clone().multiplyScalar(d), dir.clone().multiplyScalar(length), up.clone().multiplyScalar(d))
        .setPosition(a.clone().addScaledVector(up, d / 2));
      circular.push({ c, index, m });
      return;
    }
    const m = new Matrix4().makeBasis(lateral, up, dir).setPosition(a);
    const geom = new ExtrudeGeometry(crossSection(c), { depth: length, bevelEnabled: false, curveSegments: 18 });
    const flat = geom.index ? geom.toNonIndexed() : geom;
    appendSwept(surfaces, flat.getAttribute('position').array, flat.getAttribute('normal').array, c, index, m);
    const e = new EdgesGeometry(geom, 25);
    appendSwept(edges, e.getAttribute('position').array, null, c, index, m);
    geom.dispose();
    e.dispose();
  });

  const material = (fragmentShader: string, defines: Record<string, string>, transparent: boolean, depthWrite: boolean) =>
    new ShaderMaterial({ vertexShader: conduitVertex, fragmentShader, uniforms, defines, transparent, depthWrite, side: DoubleSide });

  const group = new Group();
  group.name = 'conduits';
  const sweptGeom = sweptGeometry(surfaces);
  // Inner water core (opaque, writes depth) then the glass shell over it, then outlines.
  const sweptCore = new Mesh(sweptGeom, material(conduitCoreFragment, { SWEPT: '', CORE: '' }, false, true));
  sweptCore.renderOrder = 10;
  const sweptShell = new Mesh(sweptGeom, material(conduitShellFragment, { SWEPT: '', SHELL: '' }, true, false));
  sweptShell.renderOrder = 13;
  const sweptEdges = new LineSegments(sweptGeometry(edges), material(conduitEdgeFragment, { SWEPT: '' }, true, false));
  sweptEdges.renderOrder = 14;
  group.add(sweptCore, sweptShell, sweptEdges);

  if (circular.length) {
    const cyl = new CylinderGeometry(0.5, 0.5, 1, 28, 1, false).translate(0, 0.5, 0);
    const conduitIdx = new Float32Array(circular.length);
    const lengths = new Float32Array(circular.length);
    const pipeCore = new InstancedMesh(cyl, material(conduitCoreFragment, { CORE: '' }, false, true), circular.length);
    const pipeShell = new InstancedMesh(cyl, material(conduitShellFragment, { SHELL: '' }, true, false), circular.length);
    circular.forEach(({ c, index, m }, i) => {
      pipeCore.setMatrixAt(i, m);
      pipeShell.setMatrixAt(i, m);
      conduitIdx[i] = index;
      lengths[i] = c.length_3d_m;
    });
    cyl.setAttribute('aConduit', new InstancedBufferAttribute(conduitIdx, 1));
    cyl.setAttribute('aLength', new InstancedBufferAttribute(lengths, 1));
    pipeCore.instanceMatrix.needsUpdate = true;
    pipeShell.instanceMatrix.needsUpdate = true;
    pipeCore.renderOrder = 10;
    pipeShell.renderOrder = 13;
    group.add(pipeCore, pipeShell);
  }
  group.traverse((o) => (o.frustumCulled = false));

  return {
    group,
    axes,
    indexOf,
    applyState(st: TwinState) {
      const C = st.conduits;
      for (let i = 0; i < n; i++) {
        stateData[i * 4] = C.capacity[i];
        stateData[i * 4 + 1] = C.velocity[i];
        stateData[i * 4 + 2] = C.depth[i] / conduits[i].geometry.rise_m;
        stateData[i * 4 + 3] = C.status[i];
      }
      stateTex.needsUpdate = true;
    },
    setPipeScale(k) {
      uniforms.uPipeScale.value = k;
    },
    setTime(t) {
      uniforms.uTime.value = t;
    },
    setHover(i) {
      uniforms.uHover.value = i;
    },
    setSelected(i) {
      uniforms.uSelected.value = i;
    },
  };
}
