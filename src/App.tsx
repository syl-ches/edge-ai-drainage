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
import { backendBase, replayAt, startLive, STORM_MIN_PER_WALL_S, type LiveLink, type LiveSnapshot } from './live/telemetry';
import { BASELINE_WEATHER, readCachedWeather, startWeather, type WeatherNow } from './live/weather';
import { backendCommand, frameMatchesDriver, resolveLiveTarget, type LiveDriver } from './live/liveDriver';
import { ANOMALY_CODES } from './utils/payloadCodec';
import type { TwinFrame } from './types/live';
import { STGNNForecaster, STEPS, hyetographTrajectory, type Forecast, type ForecastSource } from './forecast/stgnn';
import {
  HW_HOLD_MS,
  applyHardwarePacket,
  invertRainForSensor,
  openSyncBus,
  postToBackend,
  type HardwarePacket,
  type SyncBus,
} from './live/hardwareSync';
import { HardwareAlertBanner } from './components/HardwareAlertBanner';
import { useUsbRig } from './live/useUsbRig';
import { sensorGeometry } from './utils/fullness';

/** Recompute the in-browser ST-GNN at most this often (ms) unless its inputs change. */
const LOCAL_FORECAST_MS = 2000;
/** Rig packets are forwarded to the backend at most this often (ms). */
const BACKEND_POST_MS = 500;

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
    S.liveSurge = L.origin === 'HARDWARE' && (L.anomaly_class === 'FLASH_SURGE' || L.anomaly_class === 'SURCHARGED');
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
  const [weather, setWeather] = useState<WeatherNow>(() => readCachedWeather() ?? BASELINE_WEATHER);
  const [driver, setDriver] = useState<LiveDriver>({ kind: 'WEATHER' });
  const driverRef = useRef(driver);
  driverRef.current = driver;
  const link = useRef<LiveLink | null>(null);
  const [dspHistory, setDspHistory] = useState<DspSample[]>([]);
  const camera = useRef<CameraState | null>(initial.camera);
  // Phase 7B: Arduino / aquarium rig override (cross-tab bus, USB, backend) + local forecast
  const [hw, setHw] = useState<{ packet: HardwarePacket; at: number } | null>(null);
  const bus = useRef<SyncBus | null>(null);
  const lastPost = useRef(0);
  /** After "Disconnect Sim", ignore in-flight rig packets for a moment so the banner stays down. */
  const mutedUntil = useRef(0);
  const [localForecast, setLocalForecast] = useState<Forecast | null>(null);
  const referencePct = useRef<Record<string, number>>({});

  useEffect(() => {
    loadTwin().then(setData, (e: Error) => setError(e.message));
  }, []);

  const interp = useMemo(() => (data ? new LutInterpolator(data) : null), [data]);
  const forecaster = useMemo(() => (data ? new STGNNForecaster(data.network, data.library, data.lut.meta.tunnel_conveyance_limit_cms) : null), [data]);
  // Backend frames drive the sensor overrides only once they describe the chosen driver.
  const frame = mode === 'LIVE' && live?.frame && frameMatchesDriver(driver, live.frame) ? live.frame : null;
  const liveTarget = useMemo(() => resolveLiveTarget(driver, weather, live), [driver, weather, live]);
  // A full-catchment rig packet re-drives the whole twin: the rainfall that reproduces its fullness.
  const hwPacket = hw?.packet ?? null;
  const hwCapKey = hwPacket ? Math.round(hwPacket.capacityPct) : -1;
  const hwRain = useMemo(
    () => (interp && hwPacket && hwPacket.scope === 'full_catchment' ? invertRainForSensor(interp, hwPacket.sensorId, hwCapKey, clog) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interp, hwPacket?.scope, hwPacket?.sensorId, hwCapKey, clog],
  );
  const effectiveRain = hwRain ?? rain;
  const state = useMemo(() => {
    if (!interp) return null;
    const st = interp.evaluate(effectiveRain, clog);
    referencePct.current = Object.fromEntries(st.sensors.map((S) => [S.id, S.capacityPct]));
    applyLiveOverrides(st, frame);
    if (hwPacket) applyHardwarePacket(st, interp, hwPacket);
    return st;
  }, [interp, effectiveRain, clog, frame, hwPacket]);
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

  // Live Baguio weather (Open-Meteo, cached / baseline fallback), fetched in every mode so the
  // top-bar pill always shows current conditions.
  useEffect(() => startWeather(setWeather), []);

  // LIVE WEATHER & TELEMETRY: backend WS (+ scenario commands), local typhoon replay on demand.
  const dspSensor = sel?.kind === 'sensor' ? sel.id : (frame?.hardware_override?.sensor_id ?? 'EN-08');
  const dspSensorRef = useRef(dspSensor);
  dspSensorRef.current = dspSensor;
  useEffect(() => {
    if (mode !== 'LIVE') {
      setLive(null);
      return;
    }
    setDspHistory([]);
    const l = startLive(
      initial.api,
      (snap) => {
        setLive(snap);
        const s = snap.frame?.sensors[dspSensorRef.current];
        if (s) {
          setDspHistory((h) => {
            const next = h.length >= DSP_HISTORY ? h.slice(h.length - DSP_HISTORY + 1) : h.slice();
            next.push({ raw: s.raw_unfiltered_depth_mm, kalman: s.kalman_filtered_depth_mm, truth: s.true_depth_mm });
            return next;
          });
        }
      },
      () => {
        const d = driverRef.current;
        return d.kind === 'REPLAY' ? (data?.library.storms.find((s) => s.id === d.stormId) ?? null) : null;
      },
    );
    link.current = l;
    return () => {
      l.stop();
      link.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initial.api, data]);

  // The live driver sets the twin's rainfall / blockage (sliders are read-only in LIVE).
  useEffect(() => {
    if (mode !== 'LIVE') return;
    setRain(Math.round(liveTarget.rain * 10) / 10);
    setClog(Math.round(liveTarget.clog * 10) / 10);
  }, [mode, liveTarget]);

  // Keep the backend virtual fleet on the same driver (resent on every (re)connect).
  const command = mode === 'LIVE' ? backendCommand(driver) : null;
  const commandKey = command ? JSON.stringify(command) : '';
  const connected = live?.source === 'BACKEND_WS';
  const sentKey = useRef('');
  useEffect(() => {
    if (!connected) {
      sentKey.current = '';
      return;
    }
    if (!commandKey || commandKey === sentKey.current) return;
    if (link.current?.send(JSON.parse(commandKey) as object)) sentKey.current = commandKey;
  }, [connected, commandKey]);
  useEffect(() => setDspHistory([]), [dspSensor]);

  // ---------------------------------------------------------------- Phase 7B: hardware rig
  const ingestPacket = useCallback(
    (p: HardwarePacket, forward: boolean) => {
      setHw({ packet: p, at: Date.now() });
      if (!forward) return;
      bus.current?.publish(p);
      const now = Date.now();
      if (now - lastPost.current >= BACKEND_POST_MS) {
        lastPost.current = now;
        void postToBackend(backendBase(initial.api), p);
      }
    },
    [initial.api],
  );
  useEffect(() => {
    const b = openSyncBus();
    bus.current = b;
    const off = b.subscribe((m) => {
      if (m.type === 'telemetry') {
        if (Date.now() >= mutedUntil.current) setHw({ packet: m, at: Date.now() });
      } else if (m.from === 'SIM') setHw(null);
    });
    return () => {
      off();
      b.close();
      bus.current = null;
    };
  }, []);
  useEffect(() => {
    if (!hw) return;
    const id = window.setTimeout(() => setHw(null), HW_HOLD_MS - (Date.now() - hw.at));
    return () => window.clearTimeout(id);
  }, [hw]);
  const disconnectRig = useCallback(() => {
    bus.current?.publish({ v: 1, type: 'disconnect', ts: Date.now(), from: 'MAP', sensorId: hw?.packet.sensorId });
    mutedUntil.current = Date.now() + 2000;
    setHw(null);
  }, [hw]);
  const usbSensorId = sel?.kind === 'sensor' ? sel.id : 'EN-08';
  const usbCfg = useMemo(() => {
    const s = data?.network.sensors.find((x) => x.sensor_id === usbSensorId);
    return {
      sensorId: usbSensorId,
      deviceEui: s?.device_eui ?? usbSensorId,
      fullScaleM: s && data ? sensorGeometry(s, data.network).fullScaleM : 1,
      tankHeightMm: 400,
      scope: 'single_node' as const,
      origin: 'WEB_SERIAL' as const,
    };
  }, [data, usbSensorId]);
  const usb = useUsbRig(usbCfg, 'auto', (p) => ingestPacket(p, true));

  // ---------------------------------------------------------------- Phase 7B: in-browser ST-GNN
  // Used whenever no backend frame carries a forecast (Simulation mode, offline, static hosting).
  const needLocal = !frame?.forecast;
  const fcKey = `${mode}|${driver.kind}|${driver.kind === 'REPLAY' ? driver.stormId : ''}|${Math.round(effectiveRain)}|${Math.round(clog)}|${hwPacket ? `${hwPacket.sensorId}:${hwCapKey}` : ''}`;
  const fcInputs = useRef({ state, live, weather, driver, effectiveRain, clog, mode });
  fcInputs.current = { state, live, weather, driver, effectiveRain, clog, mode };
  useEffect(() => {
    if (!needLocal || !forecaster || !data) return;
    const run = () => {
      const { state: st, live: lv, weather: w, driver: d, effectiveRain: r, clog: c, mode: md } = fcInputs.current;
      if (!st) return;
      let traj = Array<number>(STEPS + 1).fill(r);
      let source: ForecastSource = { kind: 'TWIN', label: md === 'SIM' ? 'Simulation scenario (persisted)' : 'Twin scenario (persisted)' };
      if (hwPacket?.scope === 'full_catchment') source = { kind: 'HARDWARE', label: `Hardware-driven (${hwPacket.sensorId})` };
      else if (md === 'LIVE' && d.kind === 'WEATHER' && w.trajectoryMmHr?.length === STEPS + 1) {
        traj = [r, ...w.trajectoryMmHr.slice(1)];
        source = { kind: 'LIVE_FEED', label: 'Open-Meteo nowcast (browser)' };
      } else if (md === 'LIVE' && d.kind === 'REPLAY') {
        const storm = data.library.storms.find((s) => s.id === d.stormId);
        if (storm && lv && lv.source === 'LOCAL_PLAYBACK') {
          traj =
            storm.id === 'DESIGN_TYPHOON_12H'
              ? Array.from({ length: STEPS + 1 }, (_, t) => replayAt(storm, lv.clockS + t / STORM_MIN_PER_WALL_S).rain)
              : hyetographTrajectory(storm, lv.clockS * STORM_MIN_PER_WALL_S);
          source = { kind: 'HISTORICAL', label: storm.label, storm_id: storm.id };
        }
      }
      const C = st.conduits;
      const fc = forecaster.forecast({
        rain_mm_hr: traj,
        persist_rain_mm_hr: traj[STEPS],
        blockage_pct: c,
        lagoon_depth_m: st.lagoon.depthM,
        conduit_flow_cms: Array.from(C.flow),
        conduit_velocity_ms: Array.from(C.velocity),
        conduit_capacity: Array.from(C.capacity),
        sensor_capacity_pct: Object.fromEntries(st.sensors.map((S) => [S.id, S.capacityPct])),
        sensor_reference_pct: referencePct.current,
        source,
      });
      fc.generated_at = new Date().toISOString();
      setLocalForecast(fc);
    };
    run();
    const id = window.setInterval(run, LOCAL_FORECAST_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needLocal, forecaster, data, fcKey]);
  const forecast = frame?.forecast ?? (needLocal ? localForecast : null);
  const forecastOrigin: 'BACKEND' | 'BROWSER' = frame?.forecast ? 'BACKEND' : 'BROWSER';
  const openHardwareSim = useCallback(() => {
    const target = sel?.kind === 'sensor' ? sel.id : 'EN-08';
    const api = initial.api ? `&api=${encodeURIComponent(initial.api)}` : '';
    window.open(`${import.meta.env.BASE_URL}?view=hardware-sim&sensor=${target}${api}`, '_blank', 'noopener');
  }, [sel, initial.api]);
  const focusSensor = useCallback(
    (id: string) => {
      const s = data?.network.sensors.find((x) => x.sensor_id === id);
      if (s) engine?.flyToLngLat(s.coordinates[0], s.coordinates[1]);
    },
    [data, engine],
  );

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
  const onDriver = useCallback((d: LiveDriver) => {
    setDriver(d);
    setMode('LIVE');
  }, []);
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
          mode={mode}
          onMode={setMode}
          weather={weather}
          liveTarget={liveTarget}
          theme={theme}
          onTheme={setTheme}
          layers={layers}
          onToggleLayer={toggleLayer}
          simOpen={simView !== null}
          onSimulator={toggleSimulator}
          inspectorOpen={inspectorOpen}
          onInspector={toggleInspector}
          onHardwareSim={openHardwareSim}
        />
      )}
      {engine && hw && (
        <HardwareAlertBanner
          packet={hw.packet}
          onFocus={() => {
            focusSensor(hw.packet.sensorId);
            openSensor(hw.packet.sensorId);
          }}
          onDisconnect={disconnectRig}
          rightInset={sel ? 416 : 12}
        />
      )}
      {engine && <ShaderModeBar mode={shader} onMode={setShader} bottomOffset={simDocked ? Math.max((viewport.h * SIM_DOCK_VH) / 100, SIM_DOCK_MIN_PX) + 24 : 18} />}
      {engine && (
        <TwinControlHUD
          state={state}
          rev={rev}
          mode={mode}
          onMode={setMode}
          rain={effectiveRain}
          clog={clog}
          onRain={onRain}
          onClog={onClog}
          scale={scale}
          onScale={setScale}
          cameras={engine.presets}
          onCamera={onCameraPreset}
          fps={fps}
          live={live}
          driver={driver}
          onDriver={onDriver}
          liveTarget={liveTarget}
          weather={weather}
          storms={data.library.storms}
          forecast={forecast}
          forecastOrigin={forecastOrigin}
          usb={usb}
          usbSensorId={usbSensorId}
          onHardwareSim={openHardwareSim}
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
