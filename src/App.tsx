import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { loadTwin, type TwinData } from './data/loadTwin';
import type { PickHit, TwinEngine } from './three/TwinEngine';
import { MapView, type PointerHit } from './components/MapView';
import { TwinControlHUD } from './components/TwinControlHUD';
import { AssetInspectorDrawer } from './components/AssetInspectorDrawer';
import { QrShareModal } from './components/QrShareModal';
import { Tooltip } from './components/Tooltip';
import { SensorBadges } from './components/SensorBadges';
import { Legend } from './components/Legend';
import { TopBar } from './components/TopBar';
import { ShaderModeBar } from './components/ShaderModeBar';
import { CrossSectionSimulator, SIM_DOCK_MIN_PX, SIM_DOCK_VH } from './components/CrossSectionSimulator';
import { SubsurfaceInspector } from './components/SubsurfaceInspector';
import type { ShadingMode } from './three/materials/buildingMaterials';
import type { Theme } from './three/theme';
import type { DspSample } from './components/RawVsKalmanChart';
import { describePick, parseSel, selKey } from './components/describe';
import { LutInterpolator, type TwinState } from './utils/lutInterpolator';
import { arbitrate } from './utils/fusion';
import { parseUrlState, writeUrlStateDebounced, type CameraState, type HudMode, type LayerFlags, type SimView, type UrlState } from './utils/urlState';
import { startLive, type LiveSnapshot } from './live/telemetry';
import { ANOMALY_CODES } from './utils/payloadCodec';
import type { TwinFrame } from './types/live';

const DSP_HISTORY = 120;

/** Backend edge-DSP results win over LUT-derived sensor values (the edge is the source of truth). */
function applyLiveOverrides(st: TwinState, frame: TwinFrame | null) {
  if (!frame) return;
  for (const S of st.sensors) {
    const L = frame.sensors[S.id];
    if (!L) continue;
    S.anomaly = L.anomaly_class;
    S.anomalyCode = ANOMALY_CODES[L.anomaly_class];
    S.depthMm = L.kalman_filtered_depth_mm;
    S.dhDtMmMin = L.dh_dt_mm_min;
    S.turbulence = L.turbulence_index;
    S.capacityPct = L.capacity_pct;
    S.payload = L.payload_uint32 >>> 0;
    S.payloadHex = L.payload_hex;
    S.saturated = L.saturated_fields;
  }
}

export default function App() {
  const initial = useMemo<UrlState>(() => parseUrlState(), []);
  const [data, setData] = useState<TwinData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<TwinEngine | null>(null);
  const [mode, setMode] = useState<HudMode>(initial.mode);
  const [rain, setRain] = useState(initial.rain);
  const [clog, setClog] = useState(initial.clog);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [shader, setShader] = useState<ShadingMode>(initial.shader);
  const [layers, setLayers] = useState<LayerFlags>(initial.layers);
  const [simView, setSimView] = useState<SimView | null>(initial.sim);
  const [simNode, setSimNode] = useState(initial.simNode);
  const [simExpanded, setSimExpanded] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [scale, setScale] = useState(initial.scale);
  const [sel, setSel] = useState<PickHit | null>(() => parseSel(initial.sel));
  const [hover, setHover] = useState<PointerHit | null>(null);
  const [fps, setFps] = useState(0);
  const [offline, setOffline] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [dspHistory, setDspHistory] = useState<DspSample[]>([]);
  const camera = useRef<CameraState | null>(initial.camera);

  useEffect(() => {
    loadTwin().then(setData, (e: Error) => setError(e.message));
  }, []);

  const interp = useMemo(() => (data ? new LutInterpolator(data) : null), [data]);
  const frame = mode === 'LIVE' ? (live?.frame ?? null) : null;
  const state = useMemo(() => {
    if (!interp) return null;
    const st = interp.evaluate(rain, clog);
    applyLiveOverrides(st, frame);
    return st;
  }, [interp, rain, clog, frame]);
  const rev = state?.rev ?? 0;

  // GPU state upload (textures / uniforms only; no geometry rebuilds).
  useLayoutEffect(() => {
    if (engine && state) engine.applyState(state);
  }, [engine, state, rev]);
  useEffect(() => engine?.setTheme(theme), [engine, theme]);
  useEffect(() => engine?.setShadingMode(shader), [engine, shader]);
  useEffect(() => engine?.setLayers(layers), [engine, layers]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'daylight' ? '#F3F4EE' : '#090D16');
  }, [theme]);
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => engine?.setPipeScale(scale), [engine, scale]);
  useEffect(() => engine?.setSelected(sel), [engine, sel]);
  useEffect(() => {
    if (!engine) return;
    const id = window.setInterval(() => setFps(engine.fps), 500);
    return () => window.clearInterval(id);
  }, [engine]);

  // LIVE TELEMETRY PREVIEW: backend WS with automatic local storm-playback fallback.
  const dspSensor = sel?.kind === 'sensor' ? sel.id : (frame?.hardware_override?.sensor_id ?? 'EN-08');
  const dspSensorRef = useRef(dspSensor);
  dspSensorRef.current = dspSensor;
  useEffect(() => {
    if (mode !== 'LIVE') {
      setLive(null);
      return;
    }
    setDspHistory([]);
    return startLive(initial.api, (snap) => {
      setLive(snap);
      setRain(snap.rain);
      setClog(snap.clog);
      const s = snap.frame?.sensors[dspSensorRef.current];
      if (s) {
        setDspHistory((h) => {
          const next = h.length >= DSP_HISTORY ? h.slice(h.length - DSP_HISTORY + 1) : h.slice();
          next.push({ raw: s.raw_unfiltered_depth_mm, kalman: s.kalman_filtered_depth_mm, truth: s.true_depth_mm });
          return next;
        });
      }
    });
  }, [mode, initial.api]);
  useEffect(() => setDspHistory([]), [dspSensor]);

  // Deep-link sync (debounced replaceState keeps scrubbing at 60 FPS).
  const urlState = useRef<UrlState>(initial);
  useEffect(() => {
    urlState.current = {
      camera: camera.current,
      rain,
      clog,
      scale,
      theme,
      shader,
      layers,
      sim: simView,
      simNode,
      sel: selKey(sel),
      mode,
      api: initial.api,
    };
    writeUrlStateDebounced(urlState.current);
  }, [rain, clog, scale, theme, shader, layers, simView, simNode, sel, mode, initial.api]);
  const onCamera = useCallback((c: CameraState) => {
    camera.current = c;
    urlState.current = { ...urlState.current, camera: c };
    writeUrlStateDebounced(urlState.current);
  }, []);

  const openSensor = useCallback((id: string) => {
    setSel({ kind: 'sensor', id });
    setSimNode(id);
    setSimView('node');
  }, []);
  const onClick = useCallback(
    (hit: PointerHit | null) => {
      if (hit?.kind === 'sensor') openSensor(hit.id);
      else setSel(hit ? { kind: hit.kind, id: hit.id } : null);
    },
    [openSensor],
  );
  const toSimMode = useCallback(() => setMode('SIM'), []);
  const toggleLayer = useCallback((k: keyof LayerFlags) => setLayers((l) => ({ ...l, [k]: !l[k] })), []);
  const toggleSimulator = useCallback(() => setSimView((v) => (v ? null : 'node')), []);
  const toggleInspector = useCallback(() => setInspectorOpen((v) => !v), []);
  const onOffline = useCallback(() => setOffline(true), []);
  const onRain = useCallback((v: number) => setRain(v), []);
  const onClog = useCallback((v: number) => setClog(v), []);
  const onShare = useCallback(() => setShareOpen(true), []);
  const onCameraPreset = useCallback((id: Parameters<TwinEngine['flyTo']>[0]) => engine?.flyTo(id), [engine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSel(null);
        setShareOpen(false);
        setInspectorOpen(false);
        setSimExpanded(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-rose-300">
        Failed to load twin data ({error}). Run <code className="mx-1 font-mono">npm run generate:data</code> first.
      </div>
    );
  }
  if (!data || !interp || !state) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 className="animate-spin" size={16} /> Loading City Camp digital twin…
      </div>
    );
  }

  const fusion = frame?.fusion ?? arbitrate(state);
  const simDocked = simView !== null && !simExpanded;
  const hoverCard = hover && selKey(hover) !== selKey(sel) ? describePick(hover, data, interp, state, frame?.sensors ?? null) : null;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <MapView
        data={data}
        onReady={setEngine}
        onHover={setHover}
        onClick={onClick}
        onBasemapOffline={onOffline}
        onCamera={onCamera}
        initialCamera={initial.camera}
        initialTheme={initial.theme}
      />
      {engine && <SensorBadges engine={engine} state={state} rev={rev} theme={theme} visible={layers.badges} onSelect={openSensor} />}
      {engine && (
        <TopBar
          theme={theme}
          onTheme={setTheme}
          layers={layers}
          onToggleLayer={toggleLayer}
          simOpen={simView !== null}
          onSimulator={toggleSimulator}
          inspectorOpen={inspectorOpen}
          onInspector={toggleInspector}
        />
      )}
      {engine && <ShaderModeBar mode={shader} onMode={setShader} bottomOffset={simDocked ? Math.max((viewport.h * SIM_DOCK_VH) / 100, SIM_DOCK_MIN_PX) + 24 : 18} />}
      {engine && (
        <TwinControlHUD
          state={state}
          rev={rev}
          mode={mode}
          onMode={setMode}
          rain={rain}
          clog={clog}
          onRain={onRain}
          onClog={onClog}
          scale={scale}
          onScale={setScale}
          cameras={engine.presets}
          onCamera={onCameraPreset}
          fps={fps}
          live={live}
          fusion={fusion}
          dspHistory={dspHistory}
          dspSensor={dspSensor}
          onShare={onShare}
          basemapOffline={offline}
        />
      )}
      {hoverCard && hover && <Tooltip card={hoverCard} x={hover.x} y={hover.y} pinned={false} />}
      {sel && (
        <AssetInspectorDrawer
          hit={sel}
          data={data}
          interp={interp}
          state={state}
          rev={rev}
          live={frame?.sensors ?? null}
          dspHistory={sel.kind === 'sensor' ? dspHistory : []}
          onClose={() => setSel(null)}
        />
      )}
      {simView && (
        <CrossSectionSimulator
          data={data}
          interp={interp}
          state={state}
          rev={rev}
          theme={theme}
          view={simView}
          onView={setSimView}
          node={simNode}
          onNode={openSensor}
          rain={rain}
          clog={clog}
          onRain={onRain}
          onClog={onClog}
          live={mode === 'LIVE'}
          onRequestSim={toSimMode}
          expanded={simExpanded}
          onExpanded={setSimExpanded}
          onClose={() => setSimView(null)}
          rightInset={sel && viewport.w >= 640 ? 416 : 12}
        />
      )}
      {inspectorOpen && (
        <SubsurfaceInspector
          data={data}
          interp={interp}
          state={state}
          rev={rev}
          theme={theme}
          shader={shader}
          onShader={setShader}
          focusSensor={sel?.kind === 'sensor' ? sel.id : simNode}
          onClose={() => setInspectorOpen(false)}
        />
      )}
      {!sel && !simView && <Legend theme={theme} />}
      <QrShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}
