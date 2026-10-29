// Ultra-HD "Initial Pitch" Studio (/?view=pitch-studio, or the top-bar button on the map).
// A dedicated Three.js renderer where definition beats frame budget: supersampled pixel ratio,
// 2048 px PCF-soft shadows, ACES filmic tone mapping and a PMREM RoomEnvironment for crisp glass,
// water, metal and rock reflections. Modes: the sliced subsurface terrain cutaway (Mode A), the
// aquarium + Arduino / ESP32 bench (Mode B) and a split dual view. The tank physics drives a
// virtual ultrasonic sensor through the firmware edge pipeline; packets sync to the 3D map tab
// (BroadcastChannel) and the FastAPI backend exactly like the hardware simulator.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, Cpu, Droplets, ExternalLink, Hand, MonitorUp, Radio, Unplug, Usb, Waves, X } from 'lucide-react';
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SpotLight,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { NetworkFile } from '../types/twin';
import { buildCutaway } from '../studio/cutaway';
import { BENCH_ORIGIN, buildBench, type BoardKind } from '../studio/bench';
import { STUDIO_PRESETS, TankSim, MAX_FILL_PCT } from '../studio/tankSim';
import { timeOfFlightUs } from '../studio/acoustic';
import { HardwareRig } from '../live/serialRig';
import { useUsbRig } from '../live/useUsbRig';
import { backendBase } from '../live/telemetry';
import { openSyncBus, postToBackend, type HardwarePacket, type SyncBus, type SyncScope } from '../live/hardwareSync';
import { ALARM_PCT, ELEVATED_PCT, sensorGeometry } from '../utils/fullness';
import { PAYLOAD_FIELDS, unpackTelemetryPayload } from '../utils/payloadCodec';

export type StudioMode = 'cutaway' | 'bench' | 'split';
export type CameraPresetId = 'iso' | 'sensor' | 'street' | 'culvert' | 'bench';

export const STUDIO_CAMERAS: { id: CameraPresetId; label: string; pos: [number, number, number]; target: [number, number, number] }[] = [
  { id: 'iso', label: 'Isometric Overview', pos: [13, 10, 24], target: [-3.5, -3.4, 0] },
  { id: 'sensor', label: 'Manhole Sensor & Bouncing Waves Close-Up', pos: [-4.6, -1.2, 11.2], target: [-7, -2.3, 6.8] },
  { id: 'street', label: 'Street Surface & Pavement', pos: [3.5, 4.2, 13.5], target: [-1, 0, 2.5] },
  { id: 'culvert', label: 'Box Culvert Interior', pos: [-1.5, -4.4, 10.5], target: [-1.5, -4.7, 6] },
  { id: 'bench', label: 'Aquarium & Arduino Rig', pos: [BENCH_ORIGIN.x + 0.45, 1.5, 1.45], target: [BENCH_ORIGIN.x + 0.2, 1.05, 0] },
];

/** Studio pixel ratio: devicePixelRatio x 1.5 (x 2 with Ultra-HD supersampling), capped at 3. */
export function studioPixelRatio(dpr: number, ultra2x: boolean): number {
  return Math.min(dpr * (ultra2x ? 2 : 1.5), 3);
}

export interface StudioEmbed {
  network: NetworkFile;
  initialSensor?: string;
  onPacket(p: HardwarePacket): void;
  onClose(): void;
  onRain?(mmHr: number): void;
  popOutUrl?: string;
}

const TICK_MS = 200;
const POST_MS = 500;

interface Readout {
  fill: number;
  airGapMm: number;
  tofUs: number;
  depthM: number;
  benchGapMm: number;
  benchTofUs: number;
  benchDepthM: number;
}

export default function UltraHdPitchStudio({ embed }: { embed?: StudioEmbed }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [network, setNetwork] = useState<NetworkFile | null>(embed?.network ?? null);
  const [mode, setMode] = useState<StudioMode>(() => (params.get('view') === 'hardware-sim' || params.get('mode') === 'bench' ? 'bench' : 'cutaway'));
  const [ultra2x, setUltra2x] = useState(false);
  const [sensorId, setSensorId] = useState(() => embed?.initialSensor ?? (/^EN-\d{2}$/.test(params.get('sensor') ?? '') ? params.get('sensor')! : 'EN-08'));
  const [scope, setScope] = useState<SyncScope>('single_node');
  const [board, setBoard] = useState<BoardKind>(() => (params.get('board') === 'uno' ? 'UNO' : 'ESP32_S3'));
  const [ultrasonic, setUltrasonic] = useState<'HC-SR04' | 'A02YYUW'>('HC-SR04');
  const [rain, setRain] = useState(25);
  const [syncOn, setSyncOn] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [packet, setPacket] = useState<HardwarePacket | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [backend, setBackend] = useState<'unknown' | 'ok' | 'offline'>('unknown');
  const [readout, setReadout] = useState<Readout>({ fill: 0, airGapMm: 0, tofUs: 0, depthM: 0, benchGapMm: 0, benchTofUs: 0, benchDepthM: 0 });
  const api = params.get('api');

  const wrapRef = useRef<HTMLDivElement>(null);
  const calloutA = useRef<HTMLDivElement>(null);
  const calloutB = useRef<HTMLDivElement>(null);
  const monitorRef = useRef<HTMLDivElement>(null);
  const sim = useRef(new TankSim());
  const bus = useRef<SyncBus | null>(null);
  const lastPost = useRef(0);
  const camTween = useRef<{ from: Vector3; to: Vector3; tFrom: Vector3; tTo: Vector3; k: number } | null>(null);
  const api3d = useRef<{ goto(id: CameraPresetId, instant?: boolean): void; setPixelRatio(r: number): void } | null>(null);
  const live = useRef({ mode, rain, board, ultrasonic, syncOn, usbLive: false });

  useEffect(() => {
    if (network) return;
    fetch(`${import.meta.env.BASE_URL}data/city_camp_network.json`)
      .then((r) => r.json())
      .then((n: NetworkFile) => setNetwork({ ...n, sensors: n.sensors.filter((s) => s.is_active), conduits: n.conduits.filter((c) => c.is_active) }))
      .catch(() => setNotice('Could not load the network; sensor geometry falls back to 1 m full scale.'));
  }, [network]);

  useEffect(() => {
    if (embed) return;
    document.title = 'Ultra-HD Pitch Studio · City Camp Twin';
    document.documentElement.dataset.theme = 'daylight';
  }, [embed]);

  const sensor = network?.sensors.find((s) => s.sensor_id === sensorId);
  const rigCfg = useMemo(
    () => ({
      sensorId,
      deviceEui: sensor?.device_eui ?? sensorId,
      fullScaleM: sensor && network ? sensorGeometry(sensor, network).fullScaleM : 1,
      tankHeightMm: 300,
      scope,
      origin: 'AQUARIUM_SIM' as const,
    }),
    [sensorId, sensor, network, scope],
  );
  const rig = useRef<HardwareRig | null>(null);
  rig.current ??= new HardwareRig(rigCfg);
  useEffect(() => rig.current!.configure(rigCfg), [rigCfg]);

  // ---------------------------------------------------------------- packet fan-out
  const emit = useCallback(
    (p: HardwarePacket) => {
      setPacket(p);
      const line = `[EDGE_TX] {"device_eui":"${p.sensorId}","dist_mm":${(p.distanceMm ?? 0).toFixed(1)},"fill_pct":${p.fillPct.toFixed(1)},"payload_hex":"${p.payloadHex}","anomaly":"${p.anomaly}"}`;
      setLog((l) => (l.length >= 120 ? [...l.slice(l.length - 119), line] : [...l, line]));
      if (!live.current.syncOn) return;
      if (embed) {
        embed.onPacket(p);
        return;
      }
      bus.current?.publish(p);
      const now = Date.now();
      if (now - lastPost.current >= POST_MS) {
        lastPost.current = now;
        void postToBackend(backendBase(api), p).then((ok) => setBackend(ok ? 'ok' : 'offline'));
      }
    },
    [embed, api],
  );
  useEffect(() => {
    if (embed) return;
    const b = openSyncBus();
    bus.current = b;
    const off = b.subscribe((m) => {
      if (m.type === 'disconnect' && m.from === 'MAP') {
        setSyncOn(false);
        setNotice('The 3D map disconnected this studio. Map sync is paused; switch it back on to resume.');
      }
    });
    return () => {
      off();
      b.close();
    };
  }, [embed]);

  const usb = useUsbRig({ ...rigCfg, origin: 'WEB_SERIAL' }, 'auto', (p) => {
    sim.current.follow(p.fillPct);
    emit(p);
  });
  live.current = { mode, rain, board, ultrasonic, syncOn, usbLive: usb.status === 'connected' };
  const emitRef = useRef(emit);
  emitRef.current = emit;

  // ---------------------------------------------------------------- Three.js studio
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    renderer.setPixelRatio(studioPixelRatio(window.devicePixelRatio || 1, false));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    renderer.domElement.style.display = 'block';
    wrap.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.background = new Color('#0b1220');
    scene.fog = new Fog('#0b1220', 70, 160);
    const pmrem = new PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.add(new HemisphereLight('#e0f2fe', '#1e293b', 0.45));
    const key = new DirectionalLight('#fff7ed', 2.4);
    key.position.set(14, 22, 16);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -16;
    key.shadow.camera.right = 16;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -16;
    key.shadow.camera.far = 70;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const rim = new DirectionalLight('#7dd3fc', 0.7);
    rim.position.set(-18, 6, -10);
    scene.add(rim);
    const benchSpot = new SpotLight('#ffffff', 40, 6, 0.6, 0.5, 1.6);
    benchSpot.position.copy(BENCH_ORIGIN).add(new Vector3(0.4, 3.2, 1.4));
    benchSpot.target.position.copy(BENCH_ORIGIN).add(new Vector3(0.2, 1, 0));
    benchSpot.castShadow = true;
    benchSpot.shadow.mapSize.set(2048, 2048);
    benchSpot.shadow.bias = -0.0002;
    scene.add(benchSpot, benchSpot.target);

    const cut = buildCutaway();
    const bench = buildBench();
    scene.add(cut.group, bench.group);

    const cam = new PerspectiveCamera(38, 1, 0.01, 400);
    const camB = new PerspectiveCamera(38, 1, 0.01, 50);
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.zoomToCursor = true;
    controls.maxPolarAngle = Math.PI * 0.62;
    const startPreset = live.current.mode === 'bench' ? 'bench' : 'iso';
    const p0 = STUDIO_CAMERAS.find((c) => c.id === startPreset)!;
    cam.position.set(...p0.pos);
    controls.target.set(...p0.target);

    api3d.current = {
      goto(id, instant = false) {
        const p = STUDIO_CAMERAS.find((c) => c.id === id)!;
        const to = new Vector3(...p.pos);
        const tTo = new Vector3(...p.target);
        if (instant) {
          cam.position.copy(to);
          controls.target.copy(tTo);
          camTween.current = null;
        } else camTween.current = { from: cam.position.clone(), to, tFrom: controls.target.clone(), tTo, k: 0 };
      },
      setPixelRatio(r) {
        renderer.setPixelRatio(r);
        resize();
      },
    };

    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const project = (v: Vector3, camera: PerspectiveCamera, x0: number, w: number, h: number) => {
      const p = v.clone().project(camera);
      return { x: x0 + ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, visible: p.z < 1 };
    };
    const place = (el: HTMLDivElement | null, pt: { x: number; y: number; visible: boolean }, show: boolean) => {
      if (!el) return;
      el.style.display = show && pt.visible ? 'block' : 'none';
      el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -110%)`;
    };

    let raf = 0;
    let last = performance.now();
    let lastTick = 0;
    let lastUi = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const wall = (now - last) / 1000;
      const dt = Math.min(wall, 0.1);
      last = now;
      const t = now / 1000;
      const L = live.current;
      const s = sim.current;
      if (!L.usbLive) {
        s.step(dt);
        if (now - lastTick >= TICK_MS && rig.current) {
          lastTick = now;
          emitRef.current(rig.current.ingestBurst(s.burst(rig.current), now));
        }
      }
      const ra = cut.update(t, dt, { fill: s.level, rainMmHr: L.rain, chopMm: s.chop });
      const rb = bench.update(t, dt, { fill: s.level, pouring: s.pouring, draining: s.draining, chopMm: s.chop, board: L.board, sensor: L.ultrasonic });
      const tw = camTween.current;
      if (tw) {
        tw.k = Math.min(tw.k + wall / 1.1, 1); // wall clock: never stalls mid-flight on slow GPUs
        const e = 1 - Math.pow(1 - tw.k, 3);
        cam.position.lerpVectors(tw.from, tw.to, e);
        controls.target.lerpVectors(tw.tFrom, tw.tTo, e);
        if (tw.k >= 1) camTween.current = null;
      }
      controls.update();
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const split = L.mode === 'split';
      if (split) {
        const half = Math.floor(W / 2);
        cam.aspect = half / H;
        cam.updateProjectionMatrix();
        const a = t * 0.18;
        camB.position.set(BENCH_ORIGIN.x + 0.2 + Math.sin(a) * 2.1, 1.75, Math.cos(a) * 2.1);
        camB.lookAt(BENCH_ORIGIN.x + 0.2, 1.05, 0);
        camB.aspect = (W - half) / H;
        camB.updateProjectionMatrix();
        renderer.setScissorTest(true);
        renderer.setViewport(0, 0, half, H);
        renderer.setScissor(0, 0, half, H);
        renderer.render(scene, cam);
        renderer.setViewport(half, 0, W - half, H);
        renderer.setScissor(half, 0, W - half, H);
        renderer.render(scene, camB);
        renderer.setScissorTest(false);
        place(calloutA.current, project(cut.sensorAnchor, cam, 0, half, H), true);
        place(calloutB.current, project(bench.sensorAnchor, camB, half, W - half, H), true);
      } else {
        cam.aspect = W / Math.max(H, 1);
        cam.updateProjectionMatrix();
        renderer.setViewport(0, 0, W, H);
        renderer.render(scene, cam);
        place(calloutA.current, project(cut.sensorAnchor, cam, 0, W, H), L.mode === 'cutaway');
        place(calloutB.current, project(bench.sensorAnchor, cam, 0, W, H), L.mode === 'bench');
      }
      if (now - lastUi > 100) {
        lastUi = now;
        setReadout({
          fill: s.level,
          airGapMm: ra.airGapMm,
          tofUs: timeOfFlightUs(ra.airGapMm),
          depthM: ra.waterDepthM,
          benchGapMm: rb.airGapMm,
          benchTofUs: timeOfFlightUs(rb.airGapMm),
          benchDepthM: rb.waterDepthM,
        });
      }
    };
    raf = requestAnimationFrame(loop);
    (window as unknown as { __pitchStudio?: unknown }).__pitchStudio = { sim: sim.current, renderer, scene, camera: cam, controls, goto: (id: CameraPresetId) => api3d.current?.goto(id) };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      pmrem.dispose();
      envTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      api3d.current = null;
    };
  }, []);

  useEffect(() => api3d.current?.setPixelRatio(studioPixelRatio(window.devicePixelRatio || 1, ultra2x)), [ultra2x]);
  useEffect(() => {
    if (mode === 'bench') api3d.current?.goto('bench');
    else api3d.current?.goto('iso');
  }, [mode]);
  useEffect(() => {
    const el = monitorRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, usb.lines]);

  const changeRain = (v: number) => {
    setRain(v);
    embed?.onRain?.(v);
  };
  const goCamera = (id: CameraPresetId) => {
    if (id === 'bench' && mode === 'cutaway') setMode('bench');
    else if (id !== 'bench' && mode === 'bench') setMode('cutaway');
    api3d.current?.goto(id);
  };

  const usbLive = usb.status === 'connected';
  const pct = packet ? Math.min(packet.capacityPct, 127) : readout.fill;
  const alarm = pct >= ALARM_PCT;
  const decoded = packet ? unpackTelemetryPayload(parseInt(packet.payloadHex, 16) >>> 0) : null;
  const codes = decoded ? [decoded.depthCode, decoded.dhDtCode, decoded.capCode, decoded.anomCode, decoded.vbatCode] : [];
  const values = decoded ? [`${decoded.depthMm} mm`, `${decoded.dhDtMmMin} mm/min`, `${decoded.capPct} %`, String(decoded.anomaly), `${decoded.vbatV.toFixed(2)} V`] : [];
  const mapUrl = `${import.meta.env.BASE_URL}${api ? `?api=${encodeURIComponent(api)}` : ''}`;
  const callout = (gap: number, tof: number, depth: number) => (
    <>
      <div className="font-bold text-[#22d3ee]">{sensorId} · Edge-AI ultrasonic</div>
      <div>Air Gap Distance {gap.toFixed(0)} mm</div>
      <div>Time-of-Flight {tof.toFixed(0)} µs</div>
      <div>Water Depth {depth.toFixed(depth < 1 ? 3 : 2)} m</div>
      <div style={{ color: alarm ? '#fca5a5' : pct >= ELEVATED_PCT ? '#fde68a' : '#6ee7b7' }}>Fullness {pct.toFixed(0)} %</div>
    </>
  );

  return (
    <div className={`${embed ? 'fixed inset-0 z-[70]' : 'h-full'} flex flex-col bg-[#0b1220] text-[#e2e8f0]`} role={embed ? 'dialog' : undefined} aria-label="Ultra-HD Pitch Studio">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#1e293b] bg-[#020617] px-3 py-2">
        {embed ? (
          <button onClick={embed.onClose} className="btn-idle flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px]" aria-label="Close studio">
            <X size={13} /> Close
          </button>
        ) : (
          <a href={mapUrl} className="btn-idle flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px]">
            <ArrowLeft size={13} /> 3D map
          </a>
        )}
        <div className="mr-auto min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#34d399]">Initial Pitch · R&amp;D concept</div>
          <h1 className="truncate text-[16px] font-extrabold text-[#ffffff]">Ultra-HD Pitch Studio</h1>
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label="Studio mode">
          {(
            [
              ['cutaway', '3D Subsurface Terrain Cutaway'],
              ['bench', '3D Aquarium & Arduino Bench'],
              ['split', 'Split Dual-View'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`rounded-full px-3 py-1.5 text-[11px] ${mode === m ? 'btn-accent' : 'btn-idle'}`}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={() => setUltra2x((v) => !v)} aria-pressed={ultra2x} className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] ${ultra2x ? 'btn-sky' : 'btn-idle'}`}>
          <MonitorUp size={13} /> Ultra-HD 2x Supersampling {ultra2x ? 'ON' : 'OFF'}
        </button>
        {embed?.popOutUrl && (
          <a href={embed.popOutUrl} target="_blank" rel="noreferrer" className="btn-idle flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px]">
            <ExternalLink size={13} /> Pop out
          </a>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={wrapRef} className="absolute inset-0" aria-label="Ultra-HD 3D studio view" />
        <div ref={calloutA} className="pointer-events-none absolute left-0 top-0 rounded-lg border border-[#22d3ee]/60 bg-[#020617]/85 px-2.5 py-1.5 font-mono text-[11px] leading-snug text-[#e2e8f0] shadow-xl" style={{ display: 'none' }}>
          {callout(readout.airGapMm, readout.tofUs, readout.depthM)}
        </div>
        <div ref={calloutB} className="pointer-events-none absolute left-0 top-0 rounded-lg border border-[#facc15]/60 bg-[#020617]/85 px-2.5 py-1.5 font-mono text-[11px] leading-snug text-[#e2e8f0] shadow-xl" style={{ display: 'none' }}>
          {callout(readout.benchGapMm, readout.benchTofUs, readout.benchDepthM)}
        </div>

        {/* controls */}
        <aside className="hud-card absolute left-3 top-3 max-h-[calc(100%-24px)] w-[300px] space-y-2.5 overflow-y-auto overflow-x-hidden rounded-2xl p-3 text-[11px] text-slate-200">
          {notice && <div className="rounded-lg bg-[#fef3c7] px-2 py-1.5 font-semibold text-[#78350f]">{notice}</div>}
          <label className="flex items-center justify-between gap-2 font-bold">
            <span className="whitespace-nowrap">Target sensor</span>
            <select aria-label="Target map sensor" value={sensorId} onChange={(e) => setSensorId(e.target.value)} className="btn-idle min-w-0 max-w-[190px] flex-1 truncate rounded-lg px-2 py-1">
              {(network?.sensors ?? []).map((s) => (
                <option key={s.sensor_id} value={s.sensor_id}>
                  {s.sensor_id} · {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-1" role="radiogroup" aria-label="Map sync scope">
            {(
              [
                ['single_node', 'Targeted sensor'],
                ['full_catchment', 'Full catchment'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="radio" aria-checked={scope === k} onClick={() => setScope(k)} className={`flex-1 rounded-full px-2 py-1 ${scope === k ? 'btn-active' : 'btn-idle'}`}>
                {label}
              </button>
            ))}
          </div>
          <label className="block font-bold">
            <span className="flex justify-between">
              Water level / fullness <span className="font-mono">{readout.fill.toFixed(0)} %</span>
            </span>
            <input
              type="range"
              min={0}
              max={MAX_FILL_PCT}
              step={1}
              value={Math.round(readout.fill)}
              disabled={usbLive}
              aria-label="Water level percent"
              onChange={(e) => sim.current.setTarget(Number(e.target.value))}
              className="hud-range mt-1 h-2 w-full cursor-pointer appearance-none rounded-full"
              style={{ background: 'linear-gradient(90deg, #06b6d4, #f59e0b 37.5%, #ef4444 66.7%, #7f1d1d)' }}
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button
              disabled={usbLive}
              onClick={() => sim.current.pour()}
              onPointerDown={(e) => {
                if (e.button === 0) sim.current.hold(true);
              }}
              onPointerUp={() => sim.current.hold(false)}
              onPointerLeave={() => sim.current.hold(false)}
              onPointerCancel={() => sim.current.hold(false)}
              className="btn-sky flex select-none items-center gap-1 rounded-full px-3 py-1.5 disabled:opacity-50"
            >
              <Droplets size={13} /> Hold / Click to Pour Water (+15% Surge)
            </button>
            <button disabled={usbLive} onClick={() => sim.current.drain()} className="btn-danger flex items-center gap-1 rounded-full px-3 py-1.5 disabled:opacity-50">
              <Waves size={13} /> Drain Tank / Pipe (Reset to 0%)
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5" aria-label="Presets">
            {STUDIO_PRESETS.map((p) => (
              <button key={p.id} disabled={usbLive} onClick={() => sim.current.setTarget(p.fill, p.flat)} className={`rounded-full px-2.5 py-1 disabled:opacity-50 ${p.fill >= ALARM_PCT ? 'btn-amber' : 'btn-idle'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <label className="block font-bold">
            <span className="flex justify-between">
              Rainfall intensity <span className="font-mono">{rain} mm/hr</span>
            </span>
            <input type="range" min={0} max={250} step={5} value={rain} aria-label="Rainfall intensity" onChange={(e) => changeRain(Number(e.target.value))} className="hud-range mt-1 h-2 w-full cursor-pointer appearance-none rounded-full" style={{ background: 'linear-gradient(90deg, #06b6d4, #0284c7)' }} />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['ESP32_S3', 'ESP32-S3 Wireless Node'],
                ['UNO', 'Arduino Uno USB Node'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} onClick={() => setBoard(k)} aria-pressed={board === k} className={`rounded-full px-2.5 py-1 ${board === k ? 'btn-accent' : 'btn-idle'}`}>
                <Cpu size={11} className="mr-1 inline" />
                {label}
              </button>
            ))}
            <select aria-label="Ultrasonic sensor" value={ultrasonic} onChange={(e) => setUltrasonic(e.target.value as 'HC-SR04' | 'A02YYUW')} className="btn-idle rounded-lg px-2 py-1">
              <option value="HC-SR04">HC-SR04</option>
              <option value="A02YYUW">A02YYUW</option>
            </select>
          </div>
          <button onClick={() => setSyncOn((v) => !v)} aria-pressed={syncOn} className={`flex w-full items-center justify-center gap-1 rounded-full px-3 py-1.5 ${syncOn ? 'btn-accent' : 'btn-danger'}`}>
            {syncOn ? <Radio size={13} /> : <Unplug size={13} />} {syncOn ? `Live map sync ON (${embed ? 'shared state' : 'BroadcastChannel + backend'})` : 'Map sync paused'}
          </button>
          {!embed && (
            <div className="text-[10px] font-semibold text-slate-400">
              Backend {backendBase(api)} {backend === 'ok' ? 'ingesting' : backend === 'offline' ? 'offline (the map tab still syncs)' : '…'}
            </div>
          )}
        </aside>

        {/* cameras, readout, serial */}
        <aside className="hud-card absolute right-3 top-3 max-h-[calc(100%-24px)] w-[360px] space-y-2.5 overflow-y-auto rounded-2xl p-3 text-[11px] text-slate-200">
          <div className="flex flex-wrap gap-1" aria-label="Camera presets">
            {STUDIO_CAMERAS.map((c) => (
              <button key={c.id} onClick={() => goCamera(c.id)} className="btn-idle flex items-center gap-1 rounded-full px-2.5 py-1">
                <Camera size={11} /> {c.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5 font-mono">
            <div className={`rounded-lg px-2 py-1.5 font-bold ${alarm ? 'btn-danger' : pct >= ELEVATED_PCT ? 'btn-amber' : 'btn-accent'}`}>
              {sensorId} {pct.toFixed(0)} % full
            </div>
            <div className="btn-idle rounded-lg px-2 py-1.5">{packet?.anomaly ?? 'NORMAL'}</div>
            <div className="btn-idle rounded-lg px-2 py-1.5">gap {(mode === 'bench' ? readout.benchGapMm : readout.airGapMm).toFixed(0)} mm</div>
            <div className="btn-idle rounded-lg px-2 py-1.5">ToF {(mode === 'bench' ? readout.benchTofUs : readout.tofUs).toFixed(0)} µs</div>
          </div>
          <div className="rounded-lg bg-[#020617] p-2 font-mono text-[#e2e8f0]">
            <div className="text-[10px] text-[#a7f3d0]">32-bit payload inspector</div>
            <div className="text-[20px] font-extrabold tracking-wider text-[#ffffff]">{packet?.payloadHex ?? '0x00000000'}</div>
            <table className="mt-1 w-full text-[10px]">
              <tbody>
                {PAYLOAD_FIELDS.map((f, i) => (
                  <tr key={f.key}>
                    <td style={{ color: f.color }}>
                      [{f.bits[0]}:{f.bits[1]}]
                    </td>
                    <td>{f.label}</td>
                    <td className="text-right">{codes[i] ?? 0}</td>
                    <td className="pl-2 text-right text-[#d1fae5]">{values[i] ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between font-bold">
              Serial Monitor · 115200 baud <span className="font-mono text-[10px] text-slate-400">{usbLive ? `USB ${usb.label}` : 'virtual node'}</span>
            </div>
            <div ref={monitorRef} className="h-40 overflow-y-auto rounded-lg bg-[#020617] px-2 py-1 font-mono text-[10px] leading-snug text-[#86efac]">
              {(usbLive ? usb.lines : log).map((l, i) => (
                <div key={i} className="break-all">
                  {l}
                </div>
              ))}
            </div>
          </div>
          {usbLive ? (
            <button onClick={() => void usb.disconnect()} className="btn-danger flex w-full items-center justify-center gap-1 rounded-full px-3 py-1.5">
              <Unplug size={13} /> Disconnect USB board
            </button>
          ) : (
            <button
              onClick={() => void usb.connect()}
              disabled={usb.status === 'unsupported' || usb.status === 'connecting'}
              title={usb.status === 'unsupported' ? 'Web Serial needs desktop Chrome or Edge' : 'Pick the board in the browser port dialog (115200 baud)'}
              className="btn-active flex w-full items-center justify-center gap-1 rounded-full px-3 py-1.5 disabled:opacity-50"
            >
              <Usb size={13} /> {usb.status === 'connecting' ? 'Connecting…' : 'Connect Physical USB Arduino / ESP32'}
            </button>
          )}
          {usb.error && <div className="font-semibold text-rose-300">{usb.error}</div>}
          <div className="flex items-center gap-1 text-[10px] text-slate-400">
            <Hand size={11} /> Drag to orbit · scroll zooms to the cursor · right-drag pans
          </div>
        </aside>
      </div>
    </div>
  );
}
