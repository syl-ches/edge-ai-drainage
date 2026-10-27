import { useEffect, useMemo, useRef, useState } from 'react';
import { Droplets, Maximize2, Minimize2, Mountain, ScanLine, X } from 'lucide-react';
import type { TwinData } from '../data/loadTwin';
import { ANOMALY_COLORS, capacityColor } from '../three/palette';
import type { Theme } from '../three/theme';
import type { LutInterpolator, TwinState } from '../utils/lutInterpolator';
import { nodeDepthM, nodeFullnessPct, sensorConduitIndex, sensorGeometry, ultrasonicDistanceMm, visualBlockagePct } from '../utils/fullness';
import type { SimView } from '../utils/urlState';
import { drawCatchmentProfile, drawNodeCutaway, PALETTES, type NodeModel, type ProfileModel } from './crossSection/draw';

interface Props {
  data: TwinData;
  interp: LutInterpolator;
  state: TwinState;
  rev: number;
  theme: Theme;
  view: SimView;
  onView(v: SimView): void;
  node: string;
  onNode(id: string): void;
  rain: number;
  clog: number;
  onRain(v: number): void;
  onClog(v: number): void;
  live: boolean;
  onRequestSim(): void;
  expanded: boolean;
  onExpanded(v: boolean): void;
  onClose(): void;
  rightInset: number;
}

const DRAIN_MS = 2400;
/** Docked panel height: the App offsets the shader bar by the same amount. */
export const SIM_DOCK_VH = 52;
export const SIM_DOCK_MIN_PX = 440;

function Chip({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="shrink-0 rounded-lg border border-slate-800/80 bg-slate-900/60 px-2.5 py-1">
      <div className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="whitespace-nowrap font-mono text-[14px] font-semibold leading-tight text-slate-100" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

export function CrossSectionSimulator(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [draining, setDraining] = useState(false);
  const drainRef = useRef(false);
  const latest = useRef(p);
  latest.current = p;
  const smooth = useRef({ depth: 0, full: 0, lagoon: 0, hill: 0, tunnel: 0, choke: 0, down: 0, init: false });

  const geometries = useMemo(() => {
    const m = new Map<string, ReturnType<typeof sensorGeometry>>();
    for (const s of p.data.network.sensors) m.set(s.sensor_id, sensorGeometry(s, p.data.network));
    return m;
  }, [p.data]);

  const sensorIdx = p.interp.sensorIndex.get(p.node) ?? 0;
  const S = p.state.sensors[sensorIdx];
  const geo = geometries.get(p.node)!;
  const ci = sensorConduitIndex(S, p.interp.conduitIndex);
  const flowQ = ci >= 0 ? p.state.conduits.flow[ci] : p.state.lagoon.orificeFlowCms;
  const fullPct = nodeFullnessPct(S);
  const depthM = nodeDepthM(S);
  const distMm = ultrasonicDistanceMm(S, geo);
  const visionPct = visualBlockagePct(S);
  const fullTone = capacityColor(fullPct / 100, p.theme);

  // ---------------------------------------------------------------- animation loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const q = latest.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const k = 1 - Math.exp(-dt * 3.2);
      const t = now / 1000;
      const st = q.state;
      const pal = PALETTES[q.theme];
      const sm = smooth.current;

      const idx = q.interp.sensorIndex.get(q.node) ?? 0;
      const sen = st.sensors[idx];
      const g = sensorGeometry(sen.sensor, q.data.network);
      const targetDepth = nodeDepthM(sen);
      const targetFull = nodeFullnessPct(sen);
      const C = st.conduits;
      const at = (id: string) => q.interp.conduitIndex.get(id) ?? -1;
      const fillOf = (id: string) => {
        const i = at(id);
        return i >= 0 ? C.depth[i] / q.data.network.conduits[i].geometry.rise_m : 0;
      };
      const hillTarget = Math.max(nodeFullnessPct(st.sensors[0]), nodeFullnessPct(st.sensors[1])) / 100;
      if (!sm.init) {
        Object.assign(sm, { depth: targetDepth, full: targetFull, lagoon: st.lagoon.depthM, hill: hillTarget, tunnel: fillOf('TUN-C01'), choke: fillOf('TUN-C03'), down: fillOf('TUN-C09'), init: true });
      }
      sm.depth += (targetDepth - sm.depth) * k;
      sm.full += (targetFull - sm.full) * k;
      sm.lagoon += (st.lagoon.depthM - sm.lagoon) * k;
      sm.hill += (hillTarget - sm.hill) * k;
      sm.tunnel += (fillOf('TUN-C01') - sm.tunnel) * k;
      sm.choke += (fillOf('TUN-C03') - sm.choke) * k;
      sm.down += (fillOf('TUN-C09') - sm.down) * k;

      if (q.view === 'node') {
        const conduitI = sen.sensor.attached_kind === 'CONDUIT' ? at(sen.sensor.attached_to) : -1;
        const lidDepth =
          g.shape === 'STORAGE'
            ? q.data.network.lagoon.max_depth_m
            : g.shape === 'ORIFICE'
              ? q.data.network.lagoon.rim_elev_m - q.data.network.orifices[0].sill_elev_m
              : sen.sensor.coordinates[2] - Number(sen.sensor.pipe_geometry.invert_elev_m);
        const model: NodeModel = {
          id: sen.id,
          title: `${g.structureLabel} (${sen.id})`,
          kind: g.shape,
          rise: g.fullScaleM,
          span: g.spanM,
          lidDepth,
          mount: g.mountM,
          crownMounted: g.crownMounted,
          depth: sm.depth,
          fullPct: sm.full,
          velocity: conduitI >= 0 ? C.velocity[conduitI] : 0.3,
          anomaly: sen.anomaly,
          turbulence: Math.min(sen.turbulence, 1),
          rain: st.rain,
          blockagePct: st.blockagePct,
          draining: drainRef.current,
          isVision: sen.sensor.hardware === 'JETSON_YOLO_TRASHRACK',
        };
        drawNodeCutaway(ctx, w, h, model, t, pal, capacityColor(sm.full / 100, q.theme));
      } else {
        const tun = at('TUN-C01');
        const model: ProfileModel = {
          rain: st.rain,
          hillFill: sm.hill,
          arterialFill: fillOf('LGD-C07'),
          lagoonDepth: sm.lagoon,
          lagoonMax: q.data.network.lagoon.max_depth_m,
          blockagePct: st.blockagePct,
          tunnelFill: sm.tunnel,
          chokeFill: sm.choke,
          downstreamFill: sm.down,
          tunnelVelocity: tun >= 0 ? C.velocity[tun] : 0,
          hillAnomaly: st.sensors[0].anomaly,
          draining: drainRef.current,
        };
        drawCatchmentProfile(ctx, w, h, model, t, pal, (r) => capacityColor(r, q.theme));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------------------------------------------------------------- drain-down sequence
  const drain = () => {
    if (drainRef.current) return;
    if (p.live) p.onRequestSim();
    const start = latest.current.rain;
    const t0 = performance.now();
    drainRef.current = true;
    setDraining(true);
    const step = (now: number) => {
      const f = Math.min((now - t0) / DRAIN_MS, 1);
      const eased = 1 - Math.pow(1 - f, 3);
      latest.current.onRain(Math.round(start * (1 - eased) * 10) / 10);
      if (f < 1) requestAnimationFrame(step);
      else {
        latest.current.onRain(0);
        window.setTimeout(() => {
          drainRef.current = false;
          setDraining(false);
        }, 900);
      }
    };
    requestAnimationFrame(step);
  };

  const slider = (value: number, max: number, onChange: (v: number) => void, label: string, unit: string, gradient: string) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
        <span className="font-mono text-[13px] normal-case tracking-normal text-slate-100">
          {value.toFixed(0)} {unit}
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => {
          if (p.live) p.onRequestSim();
          onChange(Number(e.target.value));
        }}
        className="hud-range h-2 w-full cursor-pointer appearance-none rounded-full"
        style={{ background: `linear-gradient(90deg, ${gradient} ${(value / max) * 100}%, rgba(148,163,184,0.35) ${(value / max) * 100}%)` }}
      />
    </label>
  );

  const shell = p.expanded
    ? 'fixed inset-2 z-[55] sm:inset-4'
    : 'absolute inset-x-0 bottom-0 z-[45] h-[72vh] sm:left-[404px] sm:bottom-3 sm:h-[52vh] sm:min-h-[440px]'; // = SIM_DOCK_VH / SIM_DOCK_MIN_PX

  return (
    <section
      className={`pointer-events-auto flex flex-col overflow-hidden rounded-t-2xl border border-slate-800/80 bg-slate-950/90 shadow-2xl shadow-black/40 backdrop-blur-md sm:rounded-2xl ${shell}`}
      style={!p.expanded && typeof window !== 'undefined' && window.innerWidth >= 640 ? { right: p.rightInset } : undefined}
      aria-label="Cross-Section Simulator"
    >
      <header className="flex items-center gap-2 border-b border-slate-800/80 px-3 py-2">
        <div className="mr-1 min-w-0 flex-1">
          <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-sky-400">Cross-Section Simulator</div>
          <div className="truncate text-[13px] font-semibold text-slate-100">
            {p.view === 'node' ? `${S.sensor.sensor_id} · ${S.sensor.name}` : 'Hillside → Lagoon → Crystal Cave catchment profile'}
          </div>
        </div>
        <div className="flex shrink-0 rounded-full bg-slate-900/80 p-0.5 ring-1 ring-white/10">
          {(
            [
              ['node', 'Node', 'Node Cutaway', <ScanLine key="a" size={12} />],
              ['profile', 'Profile', 'Catchment Profile', <Mountain key="b" size={12} />],
            ] as const
          ).map(([v, short, label, icon]) => (
            <button
              key={v}
              onClick={() => p.onView(v)}
              title={label}
              className={`flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold ${p.view === v ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {icon}
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={() => p.onExpanded(!p.expanded)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5" aria-label={p.expanded ? 'Dock simulator' : 'Expand simulator'}>
            {p.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button onClick={p.onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5" aria-label="Close simulator">
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-slate-800/60 px-3 py-1.5 [scrollbar-width:none]" aria-live="polite">
        {p.view === 'node' ? (
          <>
            <Chip label="Node Fullness" value={`${fullPct.toFixed(1)}%`} tone={fullTone} />
            <Chip label="Water Depth" value={`${depthM.toFixed(2)} m / ${geo.fullScaleM.toFixed(2)} m`} />
            <Chip label={ci >= 0 ? 'Flow Rate Q' : 'Lagoon Outflow Q'} value={`${flowQ.toFixed(2)} m³/s`} />
            {visionPct === null ? (
              <Chip label="Ultrasonic Distance" value={`${Math.round(distMm)} mm`} />
            ) : (
              <Chip label="YOLOv8 Rack Blockage" value={`${visionPct.toFixed(0)} %`} />
            )}
            <Chip label="Edge-AI class" value={S.anomaly.replace('_', ' ')} tone={ANOMALY_COLORS[S.anomaly]} />
          </>
        ) : (
          <>
            <Chip label="Lagoon" value={`${p.state.lagoon.depthM.toFixed(2)} m / ${p.data.network.lagoon.max_depth_m} m`} tone={p.state.lagoon.isOverflowing ? '#E11D48' : undefined} />
            <Chip label="Surface elev" value={`${p.state.lagoon.surfaceElevM.toFixed(2)} m`} />
            <Chip label="Outflow Q" value={`${p.state.lagoon.orificeFlowCms.toFixed(2)} m³/s`} />
            <Chip label="Bottleneck" value={p.state.lagoon.control === 'TUNNEL_CHOKE' ? 'Rock choke' : p.state.lagoon.control === 'TRASH_RACK' ? 'Trash rack' : 'None'} />
            <Chip
              label="Overflow in"
              value={p.state.lagoon.isOverflowing ? 'NOW' : p.state.lagoon.timeToOverflowMin === null ? 'none' : `${p.state.lagoon.timeToOverflowMin.toFixed(0)} min`}
              tone={p.state.lagoon.isOverflowing || p.state.lagoon.timeToOverflowMin !== null ? '#E11D48' : '#059669'}
            />
          </>
        )}
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 block" />
        <div className={`pointer-events-none absolute right-2 hidden rounded-md sm:block ${p.view === 'profile' ? 'top-2' : 'bottom-2'} bg-slate-950/80 px-2 py-1 font-mono text-[10px] text-slate-500`}>
          {S.payloadHex} · {p.live ? 'LIVE' : 'SCENARIO'}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-800/80 px-3 py-2">
        <div className="flex flex-wrap items-end gap-3">
          {slider(p.rain, 250, p.onRain, 'Rainfall Intensity', 'mm/hr', '#06B6D4, #0284C7')}
          {slider(p.clog, 95, p.onClog, 'Trash Rack Blockage', '%', '#10B981, #F59E0B, #EF4444')}
          <button
            onClick={drain}
            disabled={draining}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-sky-500 px-4 text-[12px] font-bold text-slate-950 shadow transition hover:brightness-110 disabled:opacity-60"
          >
            <Droplets size={15} className={draining ? 'animate-bounce' : ''} />
            {draining ? 'Draining…' : 'Drain Pipe'}
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]" role="tablist" aria-label="Sensor nodes">
          {p.state.sensors.map((s) => {
            const pct = nodeFullnessPct(s);
            const sel = s.id === p.node;
            return (
              <button
                key={s.id}
                role="tab"
                aria-selected={sel}
                onClick={() => {
                  p.onNode(s.id);
                  p.onView('node');
                }}
                title={`${s.sensor.name}: ${pct.toFixed(1)}% full`}
                className={`flex min-w-[58px] flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition ${
                  sel ? 'bg-sky-500/15 ring-1 ring-sky-400/60' : 'bg-slate-900/70 ring-1 ring-white/5 hover:bg-slate-800/70'
                }`}
              >
                <span className="relative h-8 w-2.5 shrink-0 overflow-hidden rounded-sm bg-slate-800 ring-1 ring-slate-700">
                  <span className="absolute inset-x-0 bottom-0 transition-[height] duration-300" style={{ height: `${Math.min(pct, 100)}%`, background: capacityColor(pct / 100, p.theme) }} />
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-[10px] font-bold text-slate-100">{s.id}</span>
                  <span className="block font-mono text-[10px]" style={{ color: pct > 94 ? '#E11D48' : undefined }}>
                    {pct.toFixed(0)}%
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
