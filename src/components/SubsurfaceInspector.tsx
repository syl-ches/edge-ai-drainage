import { useEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { X } from 'lucide-react';
import type { TwinData } from '../data/loadTwin';
import { buildingGeometries, createBuildingMaterials, type Footprint, type ShadingMode } from '../three/materials/buildingMaterials';
import { capacityColor } from '../three/palette';
import { THEME_UNIFORMS, type Theme } from '../three/theme';
import type { LutInterpolator, TwinState } from '../utils/lutInterpolator';
import { fullnessStatus, nodeDepthM, nodeFullnessPct } from '../utils/fullness';
import { ShaderSegments } from './ShaderModeBar';

interface Props {
  data: TwinData;
  interp: LutInterpolator;
  state: TwinState;
  rev: number;
  theme: Theme;
  shader: ShadingMode;
  onShader(m: ShadingMode): void;
  focusSensor: string | null;
  onClose(): void;
}

const SLAB = 84;
const BOX = { rise: 1.8, span: 3.0, invert: -4.6 };
const PIPE = { d: 0.9, invert: -3.0 };

const glassVertex = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
}`;
const glassFragment = /* glsl */ `
uniform float uDay;
uniform vec3 uCameraPos;
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vec3 V = normalize(uCameraPos - vPos);
  float fresnel = pow(1.0 - clamp(abs(dot(V, normalize(vNormal))), 0.0, 1.0), 2.6);
  vec3 core = mix(vec3(0.07, 0.11, 0.18), vec3(0.886, 0.973, 0.941), uDay);
  vec3 rim = mix(vec3(0.22, 0.74, 0.97), vec3(0.06, 0.72, 0.50), uDay);
  gl_FragColor = vec4(mix(core, rim, fresnel * 0.85), clamp(0.14 + fresnel * 0.42, 0.1, 0.6));
}`;
const waterFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uWaterZ;
uniform float uTime;
uniform float uPulse;
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  float surf = uWaterZ + 0.04 * sin(vPos.x * 1.3 - uTime * 3.0) * sin(vPos.y * 1.1 + uTime * 2.0);
  if (vPos.z > surf) discard;
  float stripe = smoothstep(0.85, 1.0, fract(vPos.x * 0.25 + vPos.y * 0.25 - uTime * 0.8)) * 0.18;
  float beat = 1.0 - uPulse * (0.3 + 0.3 * sin(uTime * 6.0));
  float shade = 0.75 + 0.25 * clamp(normalize(vNormal).z * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4((uColor * shade + stripe) * beat, 0.95);
}`;

function representative(state: TwinState, focus: string | null, shape: 'box' | 'pipe'): number {
  const want = (k: string) => (shape === 'box' ? k !== 'CIRCULAR' : k === 'CIRCULAR');
  const idx = state.sensors.findIndex((s) => s.id === focus);
  if (idx >= 0) {
    const kind = String(state.sensors[idx].sensor.pipe_geometry.shape ?? '');
    if (state.sensors[idx].sensor.attached_kind === 'CONDUIT' && want(kind)) return idx;
  }
  const fallback = shape === 'box' ? 'EN-03' : 'EN-01';
  return Math.max(state.sensors.findIndex((s) => s.id === fallback), 0);
}

/** Rotatable 3D cutaway of one City Camp intersection block (own WebGL context). */
export function SubsurfaceInspector(p: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const api = useRef<{
    setMode(m: ShadingMode): void;
    setWater(box: { z: number; color: string; pulse: number }, pipe: { z: number; color: string; pulse: number }, mh: number[]): void;
    setTheme(t: Theme): void;
  } | null>(null);

  const boxIdx = representative(p.state, p.focusSensor, 'box');
  const pipeIdx = representative(p.state, p.focusSensor, 'pipe');
  const boxS = p.state.sensors[boxIdx];
  const pipeS = p.state.sensors[pipeIdx];
  const boxPct = nodeFullnessPct(boxS);
  const pipePct = nodeFullnessPct(pipeS);
  const status = fullnessStatus(Math.max(boxPct, pipePct));
  const statusColor = { normal: '#10B981', elevated: '#F59E0B', high: '#F97316', surcharge: '#EF4444' }[status.tone];

  const footprints = useMemo<Footprint[]>(() => {
    const rect = (cx: number, cy: number, w: number, d: number, h: number, green = false): Footprint => ({
      ring: [new Vector2(cx - w / 2, cy - d / 2), new Vector2(cx + w / 2, cy - d / 2), new Vector2(cx + w / 2, cy + d / 2), new Vector2(cx - w / 2, cy + d / 2)],
      baseZ: 0,
      height: h,
      greenRoof: green,
    });
    return [
      rect(-21, 20, 18, 14, 24),
      rect(-28, 34, 10, 10, 12, true),
      rect(21, 21, 16, 16, 30),
      rect(32, 33, 10, 8, 10),
      rect(-20, -21, 16, 12, 16, true),
      rect(-31, -33, 9, 9, 9),
      rect(22, -20, 14, 14, 20),
      rect(33, -32, 9, 11, 13),
    ];
  }, []);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = LinearSRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new Scene();
    const camera = new PerspectiveCamera(42, 1, 0.5, 600);
    camera.up.set(0, 0, 1);
    camera.position.set(62, -74, 52);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, -2);
    controls.enableDamping = true;
    controls.maxDistance = 220;
    controls.minDistance = 18;
    controls.update();

    // ---- street slab (gridded, translucent) + roads + trench cutout
    const slabMat = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    const slab = new Mesh(new PlaneGeometry(SLAB, SLAB), slabMat);
    slab.renderOrder = 1;
    const gridPts: number[] = [];
    for (let v = -SLAB / 2; v <= SLAB / 2 + 1e-6; v += 4) gridPts.push(v, -SLAB / 2, 0.02, v, SLAB / 2, 0.02, -SLAB / 2, v, 0.02, SLAB / 2, v, 0.02);
    const gridGeom = new BufferGeometry();
    gridGeom.setAttribute('position', new Float32BufferAttribute(gridPts, 3));
    const gridMat = new LineBasicMaterial({ transparent: true, depthWrite: false });
    const grid = new LineSegments(gridGeom, gridMat);
    grid.renderOrder = 2;
    const roadMat = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    const roadX = new Mesh(new PlaneGeometry(SLAB, 11), roadMat);
    roadX.position.z = 0.03;
    const roadY = new Mesh(new PlaneGeometry(11, SLAB), roadMat);
    roadY.position.z = 0.03;
    roadX.renderOrder = roadY.renderOrder = 2;
    const trench = new LineSegments(
      new EdgesGeometry(new BoxGeometry(SLAB, BOX.span + 1.2, -BOX.invert + 0.4)),
      new LineBasicMaterial({ color: '#10B981', transparent: true, opacity: 0.55, depthWrite: false }),
    );
    trench.position.set(0, 0, (BOX.invert - 0.4) / 2);
    trench.renderOrder = 3;
    scene.add(slab, grid, roadX, roadY, trench);

    // ---- buildings (shared material factory => same modes as the main map)
    const bGeo = buildingGeometries(footprints);
    const bMats = createBuildingMaterials(camera.position);
    const bSolid = new Mesh(bGeo.solid, bMats.solid);
    const bGlass = new Mesh(bGeo.solid, bMats.glass);
    const bFill = new Mesh(bGeo.solid, bMats.wireFill);
    const bEdges = new LineSegments(bGeo.edges, bMats.edges);
    bSolid.renderOrder = 19;
    bGlass.renderOrder = bFill.renderOrder = 20;
    bEdges.renderOrder = 21;
    scene.add(bSolid, bGlass, bFill, bEdges);

    // ---- drainage: box culvert (x), circular feeder (y), manhole vaults
    const glass = () =>
      new ShaderMaterial({
        vertexShader: glassVertex,
        fragmentShader: glassFragment,
        uniforms: { uDay: THEME_UNIFORMS.uDay, uCameraPos: { value: camera.position } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
    const water = () =>
      new ShaderMaterial({
        vertexShader: glassVertex,
        fragmentShader: waterFragment,
        uniforms: { uColor: { value: new Color('#10B981') }, uWaterZ: { value: -10 }, uTime: { value: 0 }, uPulse: { value: 0 } },
        transparent: true,
        side: DoubleSide,
      });
    const net = new Group();
    const boxGeom = new BoxGeometry(SLAB, BOX.span, BOX.rise);
    const boxWater = new Mesh(new BoxGeometry(SLAB, BOX.span * 0.9, BOX.rise * 0.96), water());
    const boxShell = new Mesh(boxGeom, glass());
    boxWater.position.set(0, 0, BOX.invert + BOX.rise / 2);
    boxShell.position.copy(boxWater.position);
    const boxEdges = new LineSegments(new EdgesGeometry(boxGeom), new LineBasicMaterial({ color: '#64748B', transparent: true, opacity: 0.8 }));
    boxEdges.position.copy(boxShell.position);
    const pipeGeom = new CylinderGeometry(PIPE.d / 2, PIPE.d / 2, SLAB / 2, 32, 1, false);
    const pipeWater = new Mesh(new CylinderGeometry(PIPE.d * 0.45, PIPE.d * 0.45, SLAB / 2, 28, 1, false), water());
    const pipeShell = new Mesh(pipeGeom, glass());
    pipeWater.position.set(0, -SLAB / 4, PIPE.invert + PIPE.d / 2);
    pipeShell.position.copy(pipeWater.position);
    const manholes = [
      { x: 0, y: 0, bottom: BOX.invert + BOX.rise, ref: 'box' as const },
      { x: 26, y: 0, bottom: BOX.invert + BOX.rise, ref: 'box' as const },
      { x: 0, y: -26, bottom: PIPE.invert + PIPE.d, ref: 'pipe' as const },
    ];
    const mhWater: ShaderMaterial[] = [];
    for (const m of manholes) {
      const h = -m.bottom;
      const shell = new Mesh(new CylinderGeometry(0.9, 0.9, h, 28, 1, true).rotateX(Math.PI / 2), glass());
      shell.position.set(m.x, m.y, m.bottom + h / 2);
      const wm = water();
      const col = new Mesh(new CylinderGeometry(0.75, 0.75, h, 24, 1, false).rotateX(Math.PI / 2), wm);
      col.position.copy(shell.position);
      mhWater.push(wm);
      const lid = new Mesh(new CylinderGeometry(0.95, 0.95, 0.12, 24).rotateX(Math.PI / 2), new MeshBasicMaterial({ color: '#475569' }));
      lid.position.set(m.x, m.y, 0.08);
      const node = new Mesh(new CylinderGeometry(0.28, 0.28, 0.3, 16).rotateX(Math.PI / 2), new MeshBasicMaterial({ color: '#10B981' }));
      node.position.set(m.x + 0.5, m.y, -0.35);
      col.renderOrder = 9;
      shell.renderOrder = 12;
      net.add(col, shell, lid, node);
    }
    boxWater.renderOrder = pipeWater.renderOrder = 9;
    boxShell.renderOrder = pipeShell.renderOrder = 12;
    boxEdges.renderOrder = 13;
    net.add(boxWater, boxShell, boxEdges, pipeWater, pipeShell);
    scene.add(net);

    const anchors = [new Vector3(-SLAB / 2 + 10, 0, BOX.invert - 0.8), new Vector3(1.4, -SLAB / 2 + 8, PIPE.invert - 0.6), new Vector3(0, 0, 2.5)];

    api.current = {
      setMode(mode) {
        bSolid.visible = mode === 'solid';
        bGlass.visible = mode === 'glass';
        bFill.visible = mode === 'wire';
        bMats.setMode(mode);
      },
      setWater(box, pipe, mh) {
        const bw = boxWater.material as ShaderMaterial;
        bw.uniforms.uWaterZ.value = box.z;
        bw.uniforms.uColor.value.set(box.color);
        bw.uniforms.uPulse.value = box.pulse;
        const pw = pipeWater.material as ShaderMaterial;
        pw.uniforms.uWaterZ.value = pipe.z;
        pw.uniforms.uColor.value.set(pipe.color);
        pw.uniforms.uPulse.value = pipe.pulse;
        mhWater.forEach((m, i) => {
          m.uniforms.uWaterZ.value = mh[i];
          m.uniforms.uColor.value.set(manholes[i].ref === 'box' ? box.color : pipe.color);
          m.uniforms.uPulse.value = manholes[i].ref === 'box' ? box.pulse : pipe.pulse;
        });
      },
      setTheme(t) {
        const day = t === 'daylight';
        renderer.setClearColor(day ? '#EEF4EF' : '#090D16', 1);
        slabMat.color.set(day ? '#FFFFFF' : '#1E293B');
        slabMat.opacity = day ? 0.55 : 0.35;
        gridMat.color.set(day ? '#CBD5E1' : '#334155');
        gridMat.opacity = day ? 0.9 : 0.6;
        roadMat.color.set(day ? '#D9DDD2' : '#26354D');
        roadMat.opacity = day ? 0.75 : 0.5;
      },
    };

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const v = new Vector3();
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      const t = (performance.now() - t0) / 1000;
      for (const m of [boxWater.material, pipeWater.material, ...mhWater] as ShaderMaterial[]) m.uniforms.uTime.value = t;
      renderer.render(scene, camera);
      anchors.forEach((a, i) => {
        const el = labelRefs.current[i];
        if (!el) return;
        v.copy(a).project(camera);
        const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        el.style.display = visible ? 'block' : 'none';
        el.style.transform = `translate(-50%, -50%) translate(${(((v.x + 1) / 2) * host.clientWidth).toFixed(1)}px, ${(((1 - v.y) / 2) * host.clientHeight).toFixed(1)}px)`;
      });
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose?.();
      });
      host.removeChild(renderer.domElement);
      api.current = null;
    };
  }, [footprints]);

  useEffect(() => api.current?.setMode(p.shader), [p.shader]);
  useEffect(() => api.current?.setTheme(p.theme), [p.theme]);
  useEffect(() => {
    // Scale each node's real water depth onto the diorama's representative sections (same h/D).
    const boxDepth = (nodeDepthM(boxS) / Number(boxS.sensor.pipe_geometry.rise_m)) * BOX.rise;
    const pipeDepth = (nodeDepthM(pipeS) / Number(pipeS.sensor.pipe_geometry.rise_m)) * PIPE.d;
    const boxZ = BOX.invert + Math.min(boxDepth, -BOX.invert);
    const pipeZ = PIPE.invert + Math.min(pipeDepth, -PIPE.invert);
    api.current?.setWater(
      { z: Math.min(boxZ, BOX.invert + BOX.rise * 0.96), color: capacityColor(boxPct / 100, p.theme), pulse: boxPct > 94 ? 1 : 0 },
      { z: Math.min(pipeZ, PIPE.invert + PIPE.d * 0.95), color: capacityColor(pipePct / 100, p.theme), pulse: pipePct > 94 ? 1 : 0 },
      [boxZ, boxZ, pipeZ],
    );
  });

  const visibility = p.shader === 'glass' ? 'High (Fresnel Glass)' : p.shader === 'wire' ? 'High (Holo Wireframe)' : 'Occluded (Solid Concrete)';
  return (
    <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-2 backdrop-blur-sm sm:p-6" onClick={p.onClose}>
      <div
        className="relative flex h-full max-h-[760px] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-950/90 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Subsurface Utility Inspector"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-800/80 px-4 py-2.5">
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-sky-400">Subsurface Utility Inspector</div>
            <div className="text-[14px] font-semibold text-slate-100">3D Block View · City Camp intersection cutaway</div>
          </div>
          <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ color: statusColor, background: `${statusColor}1F`, boxShadow: `inset 0 0 0 1px ${statusColor}66` }}>
            <span className="h-2 w-2 rounded-full" style={{ background: statusColor }} /> {status.label}
          </span>
          <button onClick={p.onClose} className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-white/5" aria-label="Close inspector">
            <X size={16} />
          </button>
        </header>
        <div ref={hostRef} className="relative min-h-0 flex-1">
          <div className="pointer-events-none absolute left-3 top-3 z-10 space-y-1 text-[11px]">
            <div className="rounded-md bg-slate-950/85 px-2 py-1 font-semibold text-slate-200">Orbit: Drag to Rotate | Scroll to Zoom</div>
            <div className="rounded-md bg-slate-950/85 px-2 py-1 text-slate-300">
              Subsurface Visibility: <span className="font-semibold text-sky-300">{visibility}</span>
            </div>
          </div>
          {[
            `Box culvert ${BOX.span} m × ${BOX.rise} m · ${boxS.id} · ${boxPct.toFixed(0)}% · ${nodeDepthM(boxS).toFixed(2)} m`,
            `RCPC Ø ${PIPE.d * 1000} mm · ${pipeS.id} · ${pipePct.toFixed(0)}% · ${nodeDepthM(pipeS).toFixed(2)} m`,
            'Junction manhole · Edge-AI node',
          ].map((text, i) => (
            <div
              key={i}
              ref={(el) => {
                labelRefs.current[i] = el;
              }}
              className="pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded-md border border-slate-800/80 bg-slate-950/85 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-100 shadow"
              style={{ display: 'none' }}
            >
              {text}
            </div>
          ))}
        </div>
        <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-slate-800/80 px-4 py-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Surface Building Shader</span>
          <ShaderSegments mode={p.shader} onMode={p.onShader} />
          <span className="text-[10px] text-slate-500">Water levels scale with the live readings of {boxS.id} / {pipeS.id}</span>
        </footer>
      </div>
    </div>
  );
}
