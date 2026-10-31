// Hydrological Analytics & Decision Support Command Center (Phase 9C): a full-screen bento grid
// over the live twin + the hybrid telemetry database (IndexedDB mirrored to SQLite).
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownUp, Database, Download, FileJson, FileSpreadsheet, FileText, ListChecks, X } from 'lucide-react';
import type { TwinData } from '../data/loadTwin';
import type { FusionVerdict, LiveSensor } from '../types/live';
import type { TwinState } from '../utils/lutInterpolator';
import type { Forecast } from '../forecast/stgnn';
import type { UsbRig } from '../live/useUsbRig';
import type { TelemetrySnapshot } from '../utils/telemetryRecorder';
import type { FrameRecord, TelemetryDatabase } from '../utils/telemetryDatabase';
import { agencyActions, buildHydrograph, conduitStressRows, LAGOON_NODE, sortStress, type Hydrograph, type StressKey } from '../utils/commandCenter';
import { RawVsKalmanChart, type DspSample } from './RawVsKalmanChart';
import { SdRecoveryManager } from './SdRecoveryManager';

interface Props {
  data: TwinData;
  state: TwinState;
  forecast: Forecast | null;
  fusion: FusionVerdict;
  live: Record<string, LiveSensor> | null;
  snapshots: TelemetrySnapshot[];
  dspHistory: DspSample[];
  db: TelemetryDatabase | null;
  usb: UsbRig;
  onReport(): void;
  onBlackout(active: boolean): void;
  onClose(): void;
}

const HISTORY_MS = 24 * 3600_000;
const AHEAD_MS = 70 * 60_000;
const LEVEL_TONE = { ACTION: '#dc2626', WATCH: '#d97706', NOMINAL: '#059669' } as const;
const REF_TONE = { weir: '#0891b2', critical: '#dc2626', rim: '#475569', warning: '#d97706' } as const;

function Panel({ title, right, children, className = '' }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`sh-card min-w-0 rounded-md p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="sh-title">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function HydrographChart({ h }: { h: Hydrograph }) {
  const W = 1200;
  const H = 330;
  const L = 52;
  const R = 14;
  const T = 12;
  const B = 28;
  const t1 = h.now.t + AHEAD_MS;
  const t0 = h.now.t - HISTORY_MS;
  const pts = h.points.filter((p) => p.t >= t0);
  const vals = [...pts.map((p) => p.value), h.now.value, ...h.forecast.flatMap((f) => [f.lo, f.hi]), ...h.references.map((r) => r.value)];
  let y0 = Math.min(...vals);
  let y1 = Math.max(...vals);
  const pad = (y1 - y0) * 0.08 || 1;
  y0 -= pad;
  y1 += pad;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const line = (ps: { t: number; value: number }[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('');
  const seed = pts.filter((p) => p.synthetic);
  const measured = pts.filter((p) => !p.synthetic && !p.recovered);
  const recovered = pts.filter((p) => p.recovered);
  const band = h.forecast.length ? `M${X(h.now.t)} ${Y(h.now.value)}` + h.forecast.map((f) => `L${X(f.t)} ${Y(f.hi)}`).join('') + [...h.forecast].reverse().map((f) => `L${X(f.t)} ${Y(f.lo)}`).join('') + 'Z' : '';
  const ticks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  const hours = Array.from({ length: 7 }, (_, i) => h.now.t - (24 - 4 * i) * 3600_000).filter((t) => t >= t0 && t <= t1);
  const fmtV = (v: number) => (h.unit === '%' ? `${v.toFixed(0)} %` : v.toFixed(1));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${h.node} hydrograph with ST-GNN forecast`}>
      <defs>
        <pattern id="sd-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#10b98114" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#f59e0b" strokeWidth="1.5" />
        </pattern>
      </defs>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="var(--sh-line)" />
          <text x={L - 6} y={Y(v) + 3} textAnchor="end" fontSize="10" fill="var(--sh-muted)" className="sh-mono">
            {fmtV(v)}
          </text>
        </g>
      ))}
      {hours.map((t) => (
        <text key={t} x={X(t)} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--sh-muted)" className="sh-mono">
          {t === h.now.t ? 'now' : `${Math.round((t - h.now.t) / 3600_000)} h`}
        </text>
      ))}
      {h.recoveredWindows.map(([a, b]) => (
        <rect key={a} x={X(a) - 3} y={T} width={Math.max(X(b) - X(a) + 6, 6)} height={H - T - B} fill="url(#sd-hatch)" />
      ))}
      {h.references.map((r) => (
        <g key={r.label}>
          <line x1={L} x2={W - R} y1={Y(r.value)} y2={Y(r.value)} stroke={REF_TONE[r.tone]} strokeDasharray="5 4" strokeWidth="1.2" />
          <text x={W - R - 4} y={Y(r.value) - 4} textAnchor="end" fontSize="10" fill={REF_TONE[r.tone]}>
            {r.label}
          </text>
        </g>
      ))}
      <line x1={X(h.now.t)} x2={X(h.now.t)} y1={T} y2={H - B} stroke="var(--sh-ink)" strokeOpacity="0.35" />
      {band && <path d={band} fill="#6366f122" stroke="none" />}
      {seed.length > 1 && <path d={line(seed)} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="3 3" />}
      {measured.length > 1 && <path d={line(measured)} fill="none" stroke="#0f766e" strokeWidth="2" />}
      {recovered.map((p) => (
        <circle key={p.t} cx={X(p.t)} cy={Y(p.value)} r="2.4" fill="#f59e0b" />
      ))}
      {h.forecast.length > 0 && <path d={line([h.now, ...h.forecast.map((f) => ({ t: f.t, value: f.mid }))])} fill="none" stroke="#6366f1" strokeWidth="2" strokeDasharray="6 3" />}
      <circle cx={X(h.now.t)} cy={Y(h.now.value)} r="4" fill="#0f172a" />
      {h.forecast.map((f, i) => (
        <text key={f.t} x={X(f.t)} y={Y(f.hi) - 6} textAnchor="middle" fontSize="9.5" fill="#6366f1" className="sh-mono">
          +{[15, 30, 60][i] ?? ''}m
        </text>
      ))}
    </svg>
  );
}

function download(name: string, body: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function AnalyticsCommandCenterImpl(p: Props) {
  const net = p.data.network;
  const [node, setNode] = useState(LAGOON_NODE);
  const [frames, setFrames] = useState<FrameRecord[]>([]);
  const [from, setFrom] = useState<'backend' | 'local'>('local');
  const [engine, setEngine] = useState('IndexedDB');
  const [sortKey, setSortKey] = useState<StressKey>('fillPct');
  const [desc, setDesc] = useState(true);
  const [logged, setLogged] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!p.db) return;
    const r = await p.db.history(node, 2000);
    setFrames(r.frames);
    setFrom(r.from);
    setEngine((await p.db.stats()).engine);
  }, [p.db, node]);
  useEffect(() => void reload(), [reload]);

  const hydro = useMemo(() => buildHydrograph(node, frames, net, p.state, p.forecast, Date.now()), [node, frames, net, p.state, p.forecast]);
  const rows = useMemo(() => sortStress(conduitStressRows(net, p.state, p.fusion, p.live), sortKey, desc), [net, p.state, p.fusion, p.live, sortKey, desc]);
  const actions = agencyActions(net, p.state, p.fusion, p.forecast);
  const audit: DspSample[] = p.dspHistory.length > 1 ? p.dspHistory : p.snapshots.slice(-90).map((s) => ({ raw: s.rawDepthMm, kalman: s.kalmanDepthMm, truth: s.kalmanDepthMm }));
  const auditSensor = p.snapshots.at(-1)?.edgeSensor ?? 'EN-08';
  const auditSource = p.snapshots.at(-1)?.edgeSource ?? 'VIRTUAL_PROBE';
  const seeded = frames.some((f) => f.source_mode === 'SYNTHETIC_SEED');

  const head = (k: StressKey, label: string) => (
    <th className="sh-label cursor-pointer select-none whitespace-nowrap px-1.5 py-1 text-left !text-[9.5px]" onClick={() => (k === sortKey ? setDesc((d) => !d) : (setSortKey(k), setDesc(k !== 'id')))} aria-sort={k === sortKey ? (desc ? 'descending' : 'ascending') : 'none'}>
      {label} {k === sortKey && <ArrowDownUp size={9} strokeWidth={1.5} className="inline" />}
    </th>
  );

  return (
    <div className="sh-panel fixed inset-0 z-[66] flex flex-col" role="dialog" aria-label="Analytics Command Center" data-testid="analytics-command-center">
      <header className="sh-surface sh-hair-b flex h-12 shrink-0 items-center gap-3 px-4">
        <ListChecks size={18} strokeWidth={1.5} className="sh-ink" />
        <div className="min-w-0">
          <div className="sh-label !text-[9.5px]">Baguio Flood Intelligence</div>
          <div className="sh-ink truncate text-[14px] font-bold">Hydrological Analytics &amp; Decision Support</div>
        </div>
        <span className="sh-card sh-mono ml-auto hidden items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] md:flex">
          <Database size={12} strokeWidth={1.5} /> {engine} · history from {from}
        </span>
        <button onClick={p.onReport} className="sh-btn sh-on flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold">
          <FileText size={14} strokeWidth={1.5} /> Official LGU PDF
        </button>
        <button onClick={async () => p.db && download('BaguioFlood_telemetry.csv', await p.db.csv(), 'text/csv')} className="sh-btn flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px]">
          <FileSpreadsheet size={14} strokeWidth={1.5} /> Export CSV
        </button>
        <button onClick={async () => p.db && download('BaguioFlood_database_snapshot.json', JSON.stringify(await p.db.snapshot(), null, 1), 'application/json')} className="sh-btn flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px]">
          <FileJson size={14} strokeWidth={1.5} /> Export SQLite/JSON Snapshot
        </button>
        <button onClick={p.onClose} className="sh-btn rounded-md p-1.5" aria-label="Close command center">
          <X size={15} strokeWidth={1.5} />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto p-3 xl:grid-cols-2">
        <Panel
          title="ST-GNN multi-horizon basin hydrograph"
          className="xl:col-span-2"
          right={
            <div className="flex items-center gap-2 text-[11px]">
              <select aria-label="Hydrograph node" value={node} onChange={(e) => setNode(e.target.value)} className="sh-input sh-mono rounded-md px-2 py-1">
                {net.sensors.map((s) => (
                  <option key={s.sensor_id} value={s.sensor_id}>
                    {s.sensor_id}
                    {s.sensor_id === LAGOON_NODE ? ' lagoon stage' : ''}
                  </option>
                ))}
              </select>
            </div>
          }
        >
          <HydrographChart h={hydro} />
          <div className="sh-muted flex flex-wrap gap-x-4 gap-y-1 text-[10.5px]">
            <span><span className="mr-1 inline-block h-0.5 w-4 bg-[#0f766e] align-middle" />Measured / live</span>
            {seeded && <span><span className="mr-1 inline-block h-0.5 w-4 border-t border-dashed border-[#94a3b8] align-middle" />Synthetic 24 h seed (LUT design storm, not field data)</span>}
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#f59e0b] align-middle" />SD-recovered frames (hatched window)</span>
            <span><span className="mr-1 inline-block h-2 w-4 bg-[#6366f133] align-middle" />+15 / +30 / +60 min forecast, 90 % band</span>
          </div>
        </Panel>

        <Panel title="Subsurface conduit stress & bottleneck ranking" right={<span className="sh-muted text-[10.5px]">click a header to sort · 4.44 m³/s choke limit</span>}>
          <div className="max-h-[300px] overflow-auto">
            <table className="sh-mono w-full text-[11px]">
              <thead className="sh-surface sticky top-0">
                <tr>
                  {head('id', 'Conduit')}
                  <th className="sh-label px-1.5 py-1 text-left !text-[9.5px]">Dimensions</th>
                  {head('flowCms', 'Flow m³/s')}
                  {head('fillPct', 'Fill %')}
                  {head('dhDtCmMin', 'dh/dt cm/min')}
                  {head('sigma2', 'Kalman σ²')}
                  <th className="sh-label px-1.5 py-1 text-left !text-[9.5px]">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="sh-hair-b">
                    <td className="sh-ink px-1.5 py-1 font-bold">{r.id}</td>
                    <td className="px-1.5">{r.dims}</td>
                    <td className="px-1.5 text-right">{r.flowCms.toFixed(2)}</td>
                    <td className="px-1.5 text-right font-bold" style={{ color: r.fillPct >= 94 ? '#dc2626' : r.fillPct >= 75 ? '#ea580c' : r.fillPct >= 45 ? '#d97706' : '#059669' }}>
                      {r.fillPct.toFixed(0)}
                    </td>
                    <td className="px-1.5 text-right">{r.dhDtCmMin === null ? '—' : r.dhDtCmMin.toFixed(1)}</td>
                    <td className="px-1.5 text-right">{r.sigma2 === null ? '—' : r.sigma2.toFixed(1)}</td>
                    <td className="max-w-[180px] truncate px-1.5" title={r.verdict}>
                      {r.verdict}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sh-muted mt-1 text-[10px]">dh/dt and σ² exist only where an edge node watches the conduit (σ² needs a live backend frame).</div>
        </Panel>

        <Panel title="1-D adaptive Kalman signal audit" right={<span className="sh-mono sh-muted text-[10.5px]">{auditSensor} · {auditSource === 'VIRTUAL_PROBE' ? 'in-browser edge probe' : auditSource.replace('_', ' ').toLowerCase()}</span>}>
          {audit.length > 1 ? <RawVsKalmanChart samples={audit} height={180} /> : <div className="sh-muted text-[11px]">Collecting samples…</div>}
          <div className="sh-muted mt-1 text-[10.5px]">Raw ultrasonic echoes (with storm-splash spikes) vs the on-device 5-point median + 1-D Kalman track: spikes never reach the classifier, so they never raise an alarm.</div>
        </Panel>

        <Panel title="Multi-agency action matrix" className="xl:col-span-2">
          <div className="grid gap-2 md:grid-cols-3">
            {actions.map((a) => (
              <div key={a.agency} className="sh-panel rounded-md p-2.5">
                <div className="flex items-center justify-between">
                  <span className="sh-title !text-[10.5px]">{a.agency}</span>
                  <span className="rounded px-1.5 py-0.5 text-[9.5px] font-bold text-[#ffffff]" style={{ background: LEVEL_TONE[a.level] }}>
                    {a.level}
                  </span>
                </div>
                <div className="sh-ink mt-1 text-[12.5px] font-semibold leading-snug">{a.headline}</div>
                <div className="sh-muted mt-0.5 text-[11px] leading-snug">{a.detail}</div>
                <button
                  onClick={async () => {
                    if (!p.db) return;
                    const synced = await p.db.recordIncident({ node_id: 'EN-08', fusion_verdict: p.fusion.root_cause, trash_rack_occlusion_pct: p.state.blockagePct, target_agency: a.agency, action_summary: a.headline });
                    setLogged(`${a.agency} dispatch logged${synced ? ' (SQLite + IndexedDB)' : ' (IndexedDB; backend offline)'}`);
                  }}
                  className="sh-btn mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
                >
                  <Download size={12} strokeWidth={1.5} /> Log dispatch
                </button>
              </div>
            ))}
          </div>
          {logged && <div className="sh-muted mt-1.5 text-[11px]">{logged}</div>}
          <div className="sh-muted mt-1 text-[10.5px]">Decision support only: advisories are issued by CDRRMO with PAGASA bulletins and field confirmation.</div>
        </Panel>

        <div className="xl:col-span-2">
          <SdRecoveryManager
            db={p.db}
            state={p.state}
            usb={p.usb}
            nodes={net.sensors.map((s) => s.sensor_id)}
            onBlackout={p.onBlackout}
            onBackfilled={(n) => {
              setNode(n);
              void reload();
            }}
            dbEngine={engine}
          />
        </div>
      </div>
    </div>
  );
}

export const AnalyticsCommandCenter = memo(AnalyticsCommandCenterImpl);
