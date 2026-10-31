// Collapsible 320 px right analysis dock (Phase 9A): a 2 x 3 matrix of vector tool tiles
// (NETWORK, X-RAY, CAPACITY, CCTV VMS, SECTION, LGU REPORT) over the active panel, with the
// selected asset's inspector card on top when something is picked on the map.
import { memo, type ReactNode } from 'react';
import { Cctv, ChartArea, ChevronRight, Crosshair, FileJson, FileText, Gauge, LayoutDashboard, ScanLine, Waypoints } from 'lucide-react';
import type { TwinData } from '../../data/loadTwin';
import type { Theme } from '../../three/theme';
import { ANOMALY_COLORS, bandsFor } from '../../three/palette';
import type { CameraPreset, CameraPresetId, PickHit } from '../../three/TwinEngine';
import type { FusionVerdict, LiveSensor } from '../../types/live';
import type { AnomalyClass } from '../../types/twin';
import type { LutInterpolator, TwinState } from '../../utils/lutInterpolator';
import type { Forecast } from '../../forecast/stgnn';
import { DOCK_TILES, tileActive, type DockTile, type ShellAction, type ShellState } from '../../ui/shell';
import { AssetInspectorDrawer } from '../AssetInspectorDrawer';
import { ForecastPanel } from '../ForecastPanel';
import { RawVsKalmanChart, type DspSample } from '../RawVsKalmanChart';
import { SectionPanel } from './SectionPanel';
import { fmt } from '../describe';

const TILE_ICON: Record<DockTile, ReactNode> = {
  network: <Waypoints size={26} strokeWidth={1.5} />,
  xray: <ScanLine size={26} strokeWidth={1.5} />,
  capacity: <Gauge size={26} strokeWidth={1.5} />,
  cctv: <Cctv size={26} strokeWidth={1.5} />,
  section: <ChartArea size={26} strokeWidth={1.5} />,
  report: <FileText size={26} strokeWidth={1.5} />,
};

const STATUS_COLORS = { NORMAL: '#10B981', ELEVATED: '#F59E0B', CRITICAL: '#F97316', SURCHARGED: '#DC2626' } as const;
const SHOWN_ANOMALIES: AnomalyClass[] = ['NORMAL', 'FLASH_SURGE', 'TRASH_BLOCKAGE', 'SUPERCRITICAL', 'SURCHARGED'];

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="sh-card rounded-md p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="sh-title">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-[12px]">
      <span className="sh-muted">{k}</span>
      <span className="sh-mono sh-ink text-right" style={tone ? { color: tone } : undefined}>
        {v}
      </span>
    </div>
  );
}

interface Props {
  shell: ShellState;
  dispatch(a: ShellAction): void;
  onCctv(): void;
  data: TwinData;
  interp: LutInterpolator;
  state: TwinState;
  rev: number;
  theme: Theme;
  sel: PickHit | null;
  onCloseSel(): void;
  live: Record<string, LiveSensor> | null;
  dspHistory: DspSample[];
  dspSensor: string;
  sectionNode: string;
  fusion: FusionVerdict;
  forecast: Forecast | null;
  forecastOrigin: 'BACKEND' | 'BROWSER';
  scale: number;
  onScale(v: number): void;
  cameras: CameraPreset[];
  onCamera(id: CameraPresetId): void;
  onExpandSection(): void;
  onInspector(): void;
  onReport(): void;
  onExportJson(): void;
  onAnalytics(): void;
  onSelectCctv(id: string): void;
  fps: number;
}

function RightDockImpl(p: Props) {
  const net = p.data.network;
  const L = p.state.lagoon;
  const total = Math.max(net.conduits.length, 1);
  const shapes = net.conduits.reduce<Record<string, number>>((m, c) => ((m[c.shape] = (m[c.shape] ?? 0) + 1), m), {});
  const stressed = net.conduits
    .map((c, i) => ({ c, cap: p.state.conduits.capacity[i], q: p.state.conduits.flow[i] }))
    .sort((a, b) => b.cap - a.cap)
    .slice(0, 6);
  const bands = bandsFor(p.theme);

  const panel = (() => {
    switch (p.shell.panel) {
      case 'network':
        return (
          <>
            <Card title="Network">
              <KV k="Nodes" v={`${net.nodes.length}`} />
              <KV k="Conduits" v={`${net.conduits.length} (${shapes.RECT_CLOSED ?? 0} box, ${shapes.CIRCULAR ?? 0} circular, ${shapes.ARCH ?? 0} arch)`} />
              <KV k="Edge-AI nodes" v={`${net.sensors.length}`} />
              <KV k="Governing outflow" v={`${fmt(p.interp.tunnelLimitCms, 2)} m³/s choke`} />
              <div className="sh-label mb-1 mt-2.5">Pipe visibility</div>
              <div className="sh-seg !rounded-md" role="radiogroup" aria-label="Pipe visibility scale">
                {[1, 2.5].map((k) => (
                  <button key={k} role="radio" aria-checked={Math.abs(p.scale - k) < 1e-6} onClick={() => p.onScale(k)} className="flex-1 !rounded-[5px]">
                    {k === 1 ? '1.0x true scale' : '2.5x visibility'}
                  </button>
                ))}
              </div>
              <div className="sh-label mb-1 mt-2.5">Camera</div>
              <div className="grid grid-cols-2 gap-1">
                {p.cameras.map((c) => (
                  <button key={c.id} onClick={() => p.onCamera(c.id)} className="sh-btn flex items-center gap-1 rounded-md px-2 py-1.5 text-left text-[11px]">
                    <Crosshair size={12} strokeWidth={1.5} className="shrink-0" />
                    <span className="truncate">{c.label}</span>
                  </button>
                ))}
              </div>
              <button onClick={p.onInspector} className="sh-btn mt-2 w-full rounded-md py-1.5 text-[11px]">
                Subsurface Utility Inspector
              </button>
            </Card>
            <Card title="Legend">
              <div className="flex overflow-hidden rounded">
                {bands.map((b) => (
                  <div key={b.label} className="h-2 flex-1" style={{ background: b.to ? `linear-gradient(90deg, ${b.color}, ${b.to})` : b.color }} />
                ))}
              </div>
              <div className="sh-muted mt-1 grid grid-cols-4 gap-1 text-[10px] leading-tight">
                {bands.map((b) => (
                  <span key={b.label}>
                    {b.label}
                    <br />
                    {b.name}
                  </span>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                {SHOWN_ANOMALIES.map((a) => (
                  <span key={a} className="sh-ink flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: ANOMALY_COLORS[a] }} />
                    {a.replace('_', ' ')}
                  </span>
                ))}
              </div>
              <div className="sh-muted mt-2 text-[10.5px]">Glass shell = structure · core = live water. Box culverts, circular RCPC and the arch rock choke are drawn to their true sections.</div>
            </Card>
          </>
        );
      case 'capacity':
        return (
          <>
            <Card title="Capacity">
              <div className="space-y-1">
                {(['NORMAL', 'ELEVATED', 'CRITICAL', 'SURCHARGED'] as const).map((k) => (
                  <div key={k} className="flex items-center gap-2 text-[11px]">
                    <span className="sh-muted w-[78px]">{k}</span>
                    <span className="relative h-2 flex-1 overflow-hidden rounded bg-[var(--sh-hover)]">
                      <span className="absolute inset-y-0 left-0" style={{ width: `${(p.state.statusCounts[k] / total) * 100}%`, background: STATUS_COLORS[k] }} />
                    </span>
                    <span className="sh-mono sh-ink w-6 text-right">{p.state.statusCounts[k]}</span>
                  </div>
                ))}
              </div>
              <div className="sh-hair-t mt-2.5 pt-2">
                <KV k="Lagoon depth" v={`${fmt(L.depthM, 2)} / 6.5 m`} tone={L.isOverflowing ? '#DC2626' : undefined} />
                <KV k="Surface elevation" v={`${fmt(L.surfaceElevM, 2)} m ASL`} />
                <KV k="Overflow in" v={L.isOverflowing ? 'NOW' : L.timeToOverflowMin === null ? 'none' : `${L.timeToOverflowMin.toFixed(0)} min`} tone={L.isOverflowing || L.timeToOverflowMin !== null ? '#DC2626' : '#10B981'} />
                <KV k="Outflow / inflow" v={`${fmt(L.orificeFlowCms, 2)} / ${fmt(L.inflowCms, 1)} m³/s`} />
                <KV k="Kirschmer head loss" v={`${fmt(L.headLossM, 3)} m`} />
                <KV k="Bottleneck" v={L.control === 'TUNNEL_CHOKE' ? '1.5 x 1.7 m rock choke' : L.control === 'TRASH_RACK' ? 'trash-rack orifice' : 'none'} />
              </div>
            </Card>
            <Card title="Fusion verdict" right={<span className="sh-mono sh-muted text-[10px]">{(p.fusion.confidence * 100).toFixed(0)}%</span>}>
              <div className="sh-mono sh-ink text-[11px] font-bold">{p.fusion.root_cause}</div>
              <div className="mt-1 text-[11.5px] leading-snug">{p.fusion.action}</div>
              {p.fusion.suppressed_false_alarm && <div className="mt-1.5 rounded border border-[#10b981] px-2 py-1 text-[10.5px] text-[#047857]">Rack alarm suppressed: vision shows a clear rack.</div>}
            </Card>
            <button onClick={p.onAnalytics} className="sh-btn flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-[12px] font-semibold">
              <LayoutDashboard size={14} strokeWidth={1.5} /> Open Analytics Command Center
            </button>
            <Card title="Most stressed conduits">
              <table className="sh-mono w-full text-[11px]">
                <tbody>
                  {stressed.map(({ c, cap, q }) => (
                    <tr key={c.id} className="sh-hair-b last:border-0">
                      <td className="sh-ink py-1">{c.id}</td>
                      <td className="sh-muted">{c.shape === 'CIRCULAR' ? `Ø${c.geometry.diameter_m}` : `${c.geometry.span_m}x${c.geometry.rise_m}`}</td>
                      <td className="sh-muted text-right">{q.toFixed(2)}</td>
                      <td className="text-right font-bold" style={{ color: cap >= 0.94 ? '#DC2626' : cap >= 0.75 ? '#F97316' : cap >= 0.45 ? '#F59E0B' : '#10B981' }}>
                        {(cap * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        );
      case 'report':
        return (
          <>
            <Card title="ST-GNN forecast">
              {p.forecast ? <ForecastPanel forecast={p.forecast} origin={p.forecastOrigin} /> : <div className="sh-muted text-[11px]">Computing…</div>}
            </Card>
            {p.dspHistory.length > 1 && (
              <Card title={`Edge DSP · ${p.dspSensor}`}>
                <RawVsKalmanChart samples={p.dspHistory} />
              </Card>
            )}
            <Card title="LGU report">
              <button onClick={p.onReport} className="sh-btn sh-on flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-[12px] font-semibold">
                <FileText size={14} strokeWidth={1.5} /> Official LGU PDF Report
              </button>
              <button onClick={p.onAnalytics} className="sh-btn mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-semibold">
                <LayoutDashboard size={14} strokeWidth={1.5} /> Analytics Command Center
              </button>
              <button onClick={p.onExportJson} className="sh-btn mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px]">
                <FileJson size={14} strokeWidth={1.5} /> Telemetry JSON export
              </button>
              <div className="sh-muted mt-1.5 text-[10.5px]">The four agency emblems in the PDF are stylised placeholders, not official seals.</div>
            </Card>
          </>
        );
      default:
        return (
          <SectionPanel
            data={p.data}
            interp={p.interp}
            state={p.state}
            theme={p.theme}
            nodeId={p.sectionNode}
            view={p.shell.sectionView}
            onView={(v) => p.dispatch({ type: 'sectionView', view: v })}
            onExpand={p.onExpandSection}
          />
        );
    }
  })();

  return (
    <aside className="sh-panel sh-hair-l relative flex h-full w-[320px] shrink-0 flex-col" aria-label="Analysis dock" data-testid="right-dock">
      <button onClick={() => p.dispatch({ type: 'right', open: false })} className="sh-btn absolute -left-[19px] top-3 z-20 rounded-l-md border-r-0 px-0.5 py-3" aria-label="Collapse right dock">
        <ChevronRight size={14} strokeWidth={1.5} />
      </button>
      <div className="space-y-2.5 overflow-y-auto overscroll-contain p-2.5">
        <div className="grid grid-cols-3 gap-1.5" role="toolbar" aria-label="Analysis tools">
          {DOCK_TILES.map((t) => (
            <button
              key={t.id}
              aria-pressed={tileActive(p.shell, t.id)}
              onClick={() => {
                p.dispatch({ type: 'tile', tile: t.id });
                if (t.id === 'cctv') p.onCctv();
              }}
              className="sh-tile flex h-[76px] flex-col items-center justify-center gap-1.5 rounded-md"
              data-testid={`tile-${t.id}`}
            >
              {TILE_ICON[t.id]}
              <span className="text-[9px] font-semibold uppercase tracking-[0.1em]">{t.label}</span>
            </button>
          ))}
        </div>
        {p.sel && (
          <AssetInspectorDrawer
            embedded
            hit={p.sel}
            data={p.data}
            interp={p.interp}
            state={p.state}
            rev={p.rev}
            live={p.live}
            dspHistory={p.sel.kind === 'sensor' ? p.dspHistory : []}
            onClose={p.onCloseSel}
            onCctv={p.onSelectCctv}
          />
        )}
        {panel}
        <div className="sh-mono sh-muted flex justify-between px-1 text-[10px]">
          <span>{p.fps.toFixed(0)} fps</span>
          <span>{p.shell.surface === 'fresnel' ? 'X-RAY · Fresnel glass' : p.shell.surface === 'wire' ? 'Holo wireframe' : 'Solid concrete'}</span>
        </div>
      </div>
    </aside>
  );
}

export const RightDock = memo(RightDockImpl);
