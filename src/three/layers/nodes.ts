import {
  CylinderGeometry,
  RingGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Conduit, Orifice, TwinNode } from '../../types/twin';
import type { TwinState } from '../../utils/lutInterpolator';
import { Z_REF_M, type LocalFrame } from '../frame';
import { ringFragment, ringVertex, shaftFragment, shaftVertex } from '../shaders/shaft';
import { THEME_UNIFORMS } from '../theme';

export const ShaftKind = { Manhole: 0, TunnelStation: 1, DropShaft: 2, Outfall: 3 } as const;
export type ShaftKind = (typeof ShaftKind)[keyof typeof ShaftKind];

const RADIUS: Record<ShaftKind, number> = { 0: 0.6, 1: 0.2, 2: 1.5, 3: 1.4 };

export interface NodeShaft {
  index: number;
  id: string;
  kind: ShaftKind;
  bottom: Vector3;
  top: Vector3;
}

export interface NodesLayer {
  group: Group;
  setVisible(on: boolean): void;
  shafts: NodeShaft[];
  indexOf: Map<string, number>;
  applyState(st: TwinState): void;
  setPipeScale(k: number): void;
  setTime(t: number): void;
  setHover(i: number): void;
  setSelected(i: number): void;
}

/**
 * Drop structures: tunnel nodes fed from the surface, i.e. the trash-rack intake shaft and
 * tunnel junctions receiving a non-tunnel conduit with a > 1 m outlet offset (the Lower Rock
 * Quarry lateral plunging into TUN-J08). Surface feeder-to-box offsets stay ordinary manholes.
 */
export function classifyShaft(node: TwinNode, conduits: Conduit[], orifices: Orifice[]): ShaftKind {
  if (node.type === 'OUTFALL') return ShaftKind.Outfall;
  const isDrop =
    node.network === 'TUNNEL' &&
    (orifices.some((o) => o.to_node === node.id) ||
      conduits.some((c) => c.to_node === node.id && c.network !== 'TUNNEL' && c.outlet_offset_m > 1.0));
  if (isDrop) return ShaftKind.DropShaft;
  return node.network === 'TUNNEL' ? ShaftKind.TunnelStation : ShaftKind.Manhole;
}

export function buildNodes(
  nodes: TwinNode[],
  conduits: Conduit[],
  orifices: Orifice[],
  frame: LocalFrame,
): NodesLayer {
  const list = nodes.filter((n) => n.type !== 'STORAGE'); // the lagoon is drawn as a water body
  const stateData = new Float32Array(list.length * 4);
  const stateTex = new DataTexture(stateData, list.length, 1, RGBAFormat, FloatType);
  stateTex.minFilter = NearestFilter;
  stateTex.magFilter = NearestFilter;
  stateTex.needsUpdate = true;

  const uniforms = {
    uNodeState: { value: stateTex },
    uPipeScale: { value: 1 },
    uTime: { value: 0 },
    uHover: { value: -1 },
    uSelected: { value: -1 },
    uDay: THEME_UNIFORMS.uDay,
  };
  const geom = new CylinderGeometry(0.5, 0.5, 1, 20, 1, false).translate(0, 0.5, 0);
  const mesh = new InstancedMesh(
    geom,
    new ShaderMaterial({
      vertexShader: shaftVertex,
      fragmentShader: shaftFragment,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
    list.length,
  );
  const aNode = new Float32Array(list.length);
  const aKind = new Float32Array(list.length);
  const shafts: NodeShaft[] = [];
  const indexOf = new Map<string, number>();
  const m = new Matrix4();
  list.forEach((n, i) => {
    const kind = classifyShaft(n, conduits, orifices);
    const bottom = frame.toLocal(n.coordinates[0], n.coordinates[1], n.invert_elev_m);
    const top = bottom.clone().setZ(n.rim_elev_m - Z_REF_M);
    const d = RADIUS[kind] * 2;
    // Cylinder Y axis -> scene up (z); diameter on x/y.
    m.makeBasis(new Vector3(d, 0, 0), new Vector3(0, 0, top.z - bottom.z), new Vector3(0, d, 0)).setPosition(bottom);
    mesh.setMatrixAt(i, m);
    aNode[i] = i;
    aKind[i] = kind;
    shafts.push({ index: i, id: n.id, kind, bottom, top });
    indexOf.set(n.id, i);
    stateData[i * 4] = bottom.z; // dry until a scenario arrives
  });
  geom.setAttribute('aNode', new InstancedBufferAttribute(aNode, 1));
  geom.setAttribute('aKind', new InstancedBufferAttribute(aKind, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = 12;
  mesh.frustumCulled = false;

  // Surcharge rings at the street rim of every manhole whose connected conduit runs > 100 %.
  const networkIndex = list.map((n) => nodes.indexOf(n));
  const connected = list.map((n) =>
    conduits.flatMap((c, ci) => (c.from_node === n.id || c.to_node === n.id ? [ci] : [])),
  );
  const ringGeom = new RingGeometry(0.72, 1.0, 40);
  const ringActive = new Float32Array(list.length);
  const ringPhase = new Float32Array(list.length);
  const ringUniforms = { uTime: uniforms.uTime, uPipeScale: uniforms.uPipeScale, uDay: THEME_UNIFORMS.uDay };
  const rings = new InstancedMesh(
    ringGeom,
    new ShaderMaterial({
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
      uniforms: ringUniforms,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
    list.length,
  );
  list.forEach((_, i) => {
    const top = shafts[i].top;
    m.makeScale(4, 4, 1).setPosition(top.x, top.y, top.z + 0.25);
    rings.setMatrixAt(i, m);
    ringPhase[i] = (i * 0.61803) % 1;
  });
  const activeAttr = new InstancedBufferAttribute(ringActive, 1);
  ringGeom.setAttribute('aActive', activeAttr);
  ringGeom.setAttribute('aPhase', new InstancedBufferAttribute(ringPhase, 1));
  rings.instanceMatrix.needsUpdate = true;
  rings.renderOrder = 25;
  rings.frustumCulled = false;

  const group = new Group();
  group.name = 'nodes';
  group.add(mesh, rings);
  return {
    group,
    setVisible(on) {
      mesh.visible = on;   // surcharge rings stay: they mark flooding at street level
    },
    shafts,
    indexOf,
    applyState(st) {
      const cap = st.conduits.capacity;
      for (let i = 0; i < list.length; i++) {
        const k = networkIndex[i];
        stateData[i * 4] = st.nodes.hgl[k] - Z_REF_M;
        stateData[i * 4 + 1] = st.nodes.flooding[k];
        let maxCap = 0;
        for (const ci of connected[i]) maxCap = Math.max(maxCap, cap[ci]);
        // Ramp in from 100 % to 110 % so scrubbing fades rings instead of popping them.
        ringActive[i] = shafts[i].kind === ShaftKind.TunnelStation ? 0 : Math.min(Math.max((maxCap - 1.0) / 0.1, 0), 1);
      }
      activeAttr.needsUpdate = true;
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
