import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { loadTwin, type TwinData } from './data/loadTwin';
import type { PickHit, TwinEngine } from './three/TwinEngine';
import { MapView, type PointerHit } from './components/MapView';
import type { SearchPick } from './components/SearchBox';
import { QrShareModal } from './components/QrShareModal';
import { Tooltip } from './components/Tooltip';
import { SensorBadges } from './components/SensorBadges';
import { CrossSectionSimulator } from './components/CrossSectionSimulator';
import { HeaderBar } from './components/shell/HeaderBar';
import { LeftSidebar } from './components/shell/LeftSidebar';
import { RightDock } from './components/shell/RightDock';
import { MobileSheet } from './components/shell/MobileSheet';
import { initialShell, shaderOf, shellReducer, surfaceOf, type SurfaceMode } from './ui/shell';
import type { CatchmentScope } from './three/TwinEngine';
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
import { TelemetryRecorder, type EdgeSample } from './utils/telemetryRecorder';
import { buildReportData, type ReportData } from './utils/pdfReportGenerator';
import { AnalyticsReportModal } from './components/AnalyticsReportModal';
import { AnalyticsCommandCenter } from './components/AnalyticsCommandCenter';
import { frameRecord, openTelemetryStore, seedIfEmpty, TelemetryDatabase } from './utils/telemetryDatabase';

// The Ultra-HD Pitch Studio has its own renderer and textures; load it only when opened.
const UltraHdPitchStudio = lazy(() => import('./components/UltraHdPitchStudio'));
// Phase 9B Command Center CCTV monitor (its own WebGL replay renderer).
const CommandCenterCctvPlayer = lazy(() => import('./components/CommandCenterCctvPlayer'));

/** Session telemetry snapshot period (ms) for the analytics report. */
const RECORD_MS = 2000;

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
  // Phase 9A workspace shell: header SOLID | X-RAY pill and the dock X-RAY tile share one reducer.
  const [shell, dispatch] = useReducer(shellReducer, undefined, () => initialShell(window.innerWidth, initial.shader));
  const shader = shaderOf(shell.surface);
  const setShader = useCallback((m: ShadingMode) => dispatch({ type: 'surface', mode: surfaceOf(m) }), []);
  const [scope, setScope] = useState<CatchmentScope>('bowl');
  const [layers, setLayers] = useState<LayerFlags>(initial.layers);
  const [simView, setSimView] = useState<SimView | null>(initial.sim);
  const [simNode, setSimNode] = useState(initial.simNode);
  const [simExpanded, setSimExpanded] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
    const onResize = () => dispatch({ type: 'viewport', width: window.innerWidth });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => engine?.setPipeScale(scale), [engine, scale]);
  // X-RAY reveals the subsurface network; back to SOLID shows the surface first (layers stay
  // individually toggleable in the LAYER card).
  const lastSurface = useRef<SurfaceMode>(shell.surface);
  useEffect(() => {
    if (lastSurface.current === shell.surface) return;
    const toXray = shell.surface === 'fresnel';
    const fromXray = lastSurface.current === 'fresnel';
    lastSurface.current = shell.surface;
    if (toXray) setLayers((l) => (l.network ? l : { ...l, network: true }));
    else if (fromXray && shell.surface === 'solid') setLayers((l) => (l.network ? { ...l, network: false } : l));
  }, [shell.surface]);
  const lastDim = useRef(shell.dimension);
  useEffect(() => {
    if (!engine || lastDim.current === shell.dimension) return;
    lastDim.current = shell.dimension;
    engine.setDimension(shell.dimension);
  }, [engine, shell.dimension]);
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
      if (!blackoutRef.current && now - lastPost.current >= BACKEND_POST_MS) {
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

  // ---------------------------------------------------------------- Phase 8: recorder + report
  const recorder = useRef(new TelemetryRecorder());
  const [reportOpen, setReportOpen] = useState(false);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const reportInputs = useRef({ state, frame, hwPacket, dspSensor, forecast, weather, mode, liveTarget });
  reportInputs.current = { state, frame, hwPacket, dspSensor, forecast, weather, mode, liveTarget };
  useEffect(() => {
    if (!data) return;
    const tick = () => {
      const { state: st, frame: fr, hwPacket: hp, dspSensor: ds, forecast: fc, weather: w, mode: md, liveTarget: lt } = reportInputs.current;
      if (!st) return;
      let edge: EdgeSample | null = null;
      if (hp) edge = { sensor: hp.sensorId, source: 'HARDWARE_RIG', rawDepthMm: hp.rawDepthMm, kalmanDepthMm: hp.depthMm };
      else if (fr?.sensors[ds]) edge = { sensor: ds, source: 'BACKEND_EDGE', rawDepthMm: fr.sensors[ds].raw_unfiltered_depth_mm, kalmanDepthMm: fr.sensors[ds].kalman_filtered_depth_mm };
      recorder.current.record(st, data.network, ds, edge);
      if (reportOpenRef.current) {
        setReportData(
          buildReportData({
            state: st,
            network: data.network,
            forecast: fc,
            fusion: fr?.fusion ?? arbitrate(st),
            weather: w,
            modeLabel: md === 'LIVE' ? 'Live Weather and Telemetry' : 'Scenario Simulation',
            driverLabel: md === 'LIVE' ? lt.label : 'manual rainfall and blockage sliders',
            history: recorder.current.snapshots(),
            peaks: recorder.current.peaks(),
            hardware: hp,
          }),
        );
      }
    };
    tick();
    const id = window.setInterval(tick, RECORD_MS);
    return () => window.clearInterval(id);
  }, [data]);
  // ---------------------------------------------------------------- Phase 9C: telemetry database
  const [tdb, setTdb] = useState<TelemetryDatabase | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  /** Typhoon comms-blackout demo: the cloud stream (backend POSTs + DB mirror) is cut. */
  const blackoutRef = useRef(false);
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void openTelemetryStore().then(async (store) => {
      const db = new TelemetryDatabase(store, backendBase(initial.api));
      await seedIfEmpty(db, data);
      if (alive) setTdb(db);
    });
    return () => {
      alive = false;
    };
  }, [data, initial.api]);
  useEffect(() => {
    if (!tdb) return;
    const id = window.setInterval(() => {
      const { state: st, mode: md } = reportInputs.current;
      if (!st || blackoutRef.current) return;
      const ts = new Date().toISOString();
      void tdb.ingest(st.sensors.map((S) => frameRecord(S.id, ts, S.payloadHex, md === 'LIVE' ? 'LIVE' : 'SIMULATION')));
    }, 10_000);
    return () => window.clearInterval(id);
  }, [tdb]);
  const onBlackout = useCallback((active: boolean) => {
    blackoutRef.current = active;
  }, []);
  const openCommand = useCallback(() => setCommandOpen(true), []);
  const reportOpenRef = useRef(reportOpen);
  reportOpenRef.current = reportOpen;
  const openReport = useCallback(() => {
    const { state: st, frame: fr, hwPacket: hp, forecast: fc, weather: w, mode: md, liveTarget: lt } = reportInputs.current;
    if (!data || !st) return;
    setReportData(
      buildReportData({
        state: st,
        network: data.network,
        forecast: fc,
        fusion: fr?.fusion ?? arbitrate(st),
        weather: w,
        modeLabel: md === 'LIVE' ? 'Live Weather and Telemetry' : 'Scenario Simulation',
        driverLabel: md === 'LIVE' ? lt.label : 'manual rainfall and blockage sliders',
        history: recorder.current.snapshots(),
        peaks: recorder.current.peaks(),
        hardware: hp,
      }),
    );
    setReportOpen(true);
  }, [data]);
  const openHardwareSim = useCallback(() => {
    const target = sel?.kind === 'sensor' ? sel.id : 'EN-08';
    const api = initial.api ? `&api=${encodeURIComponent(initial.api)}` : '';
    window.open(`${import.meta.env.BASE_URL}?view=hardware-sim&sensor=${target}${api}`, '_blank', 'noopener');
  }, [sel, initial.api]);
  const [studioOpen, setStudioOpen] = useState(false);
  const [cctvSensor, setCctvSensor] = useState<string | null>(null);
  const openCctv = useCallback((id?: string) => setCctvSensor(id ?? 'EN-08'), []);
  const closeCctv = useCallback(() => setCctvSensor(null), []);
  const openStudio = useCallback(() => setStudioOpen(true), []);
  const closeStudio = useCallback(() => setStudioOpen(false), []);
  const studioPacket = useCallback((p: HardwarePacket) => ingestPacket(p, true), [ingestPacket]);
  // The studio's rainfall slider drives the map only in Simulation Mode (LIVE follows the weather).
  const studioRain = useCallback((v: number) => {
    if (mode === 'SIM') setRain(v);
  }, [mode]);
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
    dispatch({ type: 'tile', tile: 'section' });
    dispatch({ type: 'sectionView', view: 'cutaway' });
  }, []);
  const onClick = useCallback(
    (hit: PointerHit | null) => {
      if (hit?.kind === 'sensor') openSensor(hit.id);
      else setSel(hit ? { kind: hit.kind, id: hit.id } : null);
    },
    [openSensor],
  );
  const onSearchPick = useCallback(
    (p: SearchPick) => {
      if (p.kind === 'sensor') openSensor(p.id);
      else setSel({ kind: p.kind, id: p.id });
      engine?.flyToLngLat(p.lng, p.lat);
    },
    [engine, openSensor],
  );
  const toSimMode = useCallback(() => setMode('SIM'), []);
  const onDriver = useCallback((d: LiveDriver) => {
    setDriver(d);
    setMode('LIVE');
  }, []);
  const toggleLayer = useCallback((k: keyof LayerFlags) => setLayers((l) => ({ ...l, [k]: !l[k] })), []);
  const openSimulator = useCallback(() => {
    setSimView((v) => v ?? 'node');
    setSimExpanded(true);
  }, []);
  const onScope = useCallback(
    (s: CatchmentScope) => {
      setScope(s);
      engine?.fitScope(s);
    },
    [engine],
  );
  const onRecenter = useCallback(() => {
    setScope('bowl');
    engine?.fitScope('bowl');
  }, [engine]);
  const onResetView = useCallback(() => {
    setScope('bowl');
    engine?.flyTo('overview');
  }, [engine]);
  const onUpperBasin = useCallback(() => {
    const pts = (data?.network.sensors ?? []).filter((s) => ['EN-01', 'EN-02', 'EN-05'].includes(s.sensor_id));
    if (!pts.length) return;
    engine?.flyToLngLat(pts.reduce((a, s) => a + s.coordinates[0], 0) / pts.length, pts.reduce((a, s) => a + s.coordinates[1], 0) / pts.length, 16.9);
  }, [data, engine]);
  const toggleInspector = useCallback(() => setInspectorOpen((v) => !v), []);
  const onSurface = useCallback((m: SurfaceMode) => dispatch({ type: 'surface', mode: m }), []);
  const onDimension = useCallback((d: '2d' | '3d') => dispatch({ type: 'dimension', dimension: d }), []);
  const exportJson = useCallback(() => {
    const st = reportInputs.current.state;
    if (!st) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            product: 'Baguio Flood Intelligence · City Camp Lagoon digital twin',
            exported_at: new Date().toISOString(),
            mode: reportInputs.current.mode,
            rainfall_mm_hr: st.rain,
            trash_rack_blockage_pct: st.blockagePct,
            lagoon: { ...st.lagoon, depthSeries: Array.from(st.lagoon.depthSeries) },
            fusion: reportInputs.current.frame?.fusion ?? arbitrate(st),
            sensors: st.sensors.map((S) => ({ id: S.id, capacity_pct: S.capacityPct, depth_mm: S.depthMm, dh_dt_mm_min: S.dhDtMmMin, anomaly: S.anomaly, payload_hex: S.payloadHex })),
            status_counts: st.statusCounts,
            session_snapshots: recorder.current.snapshots(),
            note: 'Synthetic network geometry (SYNTHETIC_OSMNX); see CLAUDE.md §1.',
          },
          null,
          1,
        ),
      ],
      { type: 'application/json' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `BaguioFloodIntelligence_telemetry_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, []);
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
  const hoverCard = hover && selKey(hover) !== selKey(sel) ? describePick(hover, data, interp, state, frame?.sensors ?? null) : null;
  const sectionNode = sel?.kind === 'sensor' ? sel.id : simNode;
  const cctvFor = () => openCctv(sel?.kind === 'sensor' ? sel.id : 'EN-08');

  return (
    <div className="sh-surface flex h-full w-full flex-col overflow-hidden" style={{ ['--topbar-h' as string]: '48px' }}>
      <HeaderBar
        mobile={shell.mobile}
        surface={shell.surface}
        onSurface={onSurface}
        dimension={shell.dimension}
        onDimension={onDimension}
        theme={theme}
        onTheme={setTheme}
        mode={mode}
        onMode={setMode}
        rain={effectiveRain}
        weather={weather}
        live={live}
        cameras={engine?.presets ?? []}
        onCamera={onCameraPreset}
        onUpperBasin={onUpperBasin}
        onSimulator={openSimulator}
        onInspector={toggleInspector}
        onHardwareSim={openHardwareSim}
        onStudio={openStudio}
        usb={usb}
        usbSensorId={usbSensorId}
        onCctv={cctvFor}
        onReport={openReport}
        onExportJson={exportJson}
        onAnalytics={openCommand}
        onShare={onShare}
      />
      <div className="relative flex min-h-0 flex-1">
        {!shell.mobile && shell.leftOpen && (
          <LeftSidebar
            open
            onToggle={() => dispatch({ type: 'left' })}
            network={data.network}
            state={state}
            onSearchPick={onSearchPick}
            scope={scope}
            onScope={onScope}
            onRecenter={onRecenter}
            onReset={onResetView}
            mode={mode}
            onMode={setMode}
            weather={weather}
            liveTarget={liveTarget}
            live={live}
            driver={driver}
            onDriver={onDriver}
            storms={data.library.storms}
            rain={effectiveRain}
            clog={clog}
            onRain={onRain}
            onClog={onClog}
            layers={layers}
            onToggleLayer={toggleLayer}
            surface={shell.surface}
            onSurface={onSurface}
          />
        )}
        <main className="relative min-w-0 flex-1 overflow-hidden" aria-label="3D viewport">
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
          {engine && <SensorBadges engine={engine} state={state} rev={rev} theme={theme} visible={layers.badges} onSelect={openSensor} onCctv={openCctv} />}
          {!shell.mobile && !shell.leftOpen && (
            <button onClick={() => dispatch({ type: 'left', open: true })} className="sh-btn absolute left-0 top-3 z-20 rounded-r-md border-l-0 px-0.5 py-3" aria-label="Expand left sidebar">
              <ChevronRight size={14} strokeWidth={1.5} />
            </button>
          )}
          {!shell.mobile && !shell.rightOpen && (
            <button onClick={() => dispatch({ type: 'right', open: true })} className="sh-btn absolute right-0 top-3 z-20 rounded-l-md border-r-0 px-0.5 py-3" aria-label="Expand right dock">
              <ChevronLeft size={14} strokeWidth={1.5} />
            </button>
          )}
          {engine && hw && (
            <HardwareAlertBanner
              packet={hw.packet}
              onFocus={() => {
                focusSensor(hw.packet.sensorId);
                openSensor(hw.packet.sensorId);
              }}
              onDisconnect={disconnectRig}
            />
          )}
          {hoverCard && hover && <Tooltip card={hoverCard} x={hover.x} y={hover.y} pinned={false} />}
          {offline && !shell.mobile && (
            <div className="sh-card sh-muted pointer-events-none absolute bottom-3 left-3 z-10 rounded-md px-2.5 py-1 text-[11px]">Basemap tiles offline · 3D twin, grid and contours still live</div>
          )}
          {shell.mobile && (
            <MobileSheet
              shell={shell}
              dispatch={dispatch}
              data={data}
              interp={interp}
              state={state}
              theme={theme}
              sectionNode={sectionNode}
              onNode={(id) => {
                focusSensor(id);
                openSensor(id);
              }}
              forecast={forecast}
              forecastOrigin={forecastOrigin}
              onReport={openReport}
            />
          )}
        </main>
        {!shell.mobile && shell.rightOpen && (
          <RightDock
            shell={shell}
            dispatch={dispatch}
            onCctv={cctvFor}
            data={data}
            interp={interp}
            state={state}
            rev={rev}
            theme={theme}
            sel={sel}
            onCloseSel={() => setSel(null)}
            live={frame?.sensors ?? null}
            dspHistory={dspHistory}
            dspSensor={dspSensor}
            sectionNode={sectionNode}
            fusion={fusion}
            forecast={forecast}
            forecastOrigin={forecastOrigin}
            scale={scale}
            onScale={setScale}
            cameras={engine?.presets ?? []}
            onCamera={onCameraPreset}
            onExpandSection={openSimulator}
            onInspector={toggleInspector}
            onReport={openReport}
            onExportJson={exportJson}
            onAnalytics={openCommand}
            onSelectCctv={openCctv}
            fps={fps}
          />
        )}
      </div>
      {simView && simExpanded && (
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
          expanded
          onExpanded={(v) => {
            setSimExpanded(v);
            if (!v) setSimView(null);
          }}
          onClose={() => {
            setSimView(null);
            setSimExpanded(false);
          }}
          rightInset={12}
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
      {commandOpen && (
        <AnalyticsCommandCenter
          data={data}
          state={state}
          forecast={forecast}
          fusion={fusion}
          live={frame?.sensors ?? null}
          snapshots={recorder.current.snapshots()}
          dspHistory={dspHistory}
          db={tdb}
          usb={usb}
          onReport={openReport}
          onBlackout={onBlackout}
          onClose={() => setCommandOpen(false)}
        />
      )}
      {reportOpen && reportData && <AnalyticsReportModal data={reportData} onClose={() => setReportOpen(false)} />}
      {studioOpen && (
        <Suspense fallback={null}>
          <UltraHdPitchStudio
            embed={{
              network: data.network,
              initialSensor: sel?.kind === 'sensor' ? sel.id : 'EN-08',
              onPacket: studioPacket,
              onClose: closeStudio,
              onRain: studioRain,
              popOutUrl: `${import.meta.env.BASE_URL}?view=pitch-studio${initial.api ? `&api=${encodeURIComponent(initial.api)}` : ''}`,
            }}
          />
        </Suspense>
      )}
      {cctvSensor && (
        <Suspense fallback={null}>
          <CommandCenterCctvPlayer data={data} sensorId={cctvSensor} api={backendBase(initial.api)} onClose={closeCctv} />
        </Suspense>
      )}
      <QrShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}
