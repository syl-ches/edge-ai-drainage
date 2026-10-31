// SECTION card of the right dock / mobile sheet (Phase 9A): the live catchment profile
// (Mirador hillside -> lagoon bowl -> sloped rack EN-08 -> 1.5 x 1.7 m tunnel choke) or the
// selected node's manhole cutaway, drawn with the Cross-Section Simulator's canvas painters.
import { useEffect, useRef } from 'react';
import { Maximize2 } from 'lucide-react';
import type { TwinData } from '../../data/loadTwin';
import type { Theme } from '../../three/theme';
import { capacityColor } from '../../three/palette';
import type { LutInterpolator, TwinState } from '../../utils/lutInterpolator';
import { nodeFullnessPct } from '../../utils/fullness';
import { drawCatchmentProfile, drawNodeCutaway, PALETTES } from '../crossSection/draw';
import { SectionSmoother } from '../crossSection/models';
import type { SectionView } from '../../ui/shell';

interface Props {
  data: TwinData;
  interp: LutInterpolator;
  state: TwinState;
  theme: Theme;
  nodeId: string;
  view: SectionView;
  onView(v: SectionView): void;
  onExpand?(): void;
  height?: number;
}

const LOGICAL_MIN_W = 560;

export const SECTION_LEGEND: { label: string; color: string }[] = [
  { label: 'Terrain', color: '#475569' },
  { label: 'Culvert', color: '#94A3B8' },
  { label: 'Normal (<45%)', color: '#10B981' },
  { label: 'Warning (45-79%)', color: '#F59E0B' },
  { label: 'Critical (>=80% 3 Hz)', color: '#DC2626' },
];

export function SectionPanel({ data, interp, state, theme, nodeId, view, onView, onExpand, height = 230 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ data, interp, state, theme, nodeId, view });
  latest.current = { data, interp, state, theme, nodeId, view };
  const smooth = useRef(new SectionSmoother());

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
      if (w < 2 || h < 2) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // The painters lay out labels for >= 560 px; draw at that logical width and scale down so
      // the dock shows a clean miniature (the expand button opens the full-size simulator).
      const k = Math.min(w / LOGICAL_MIN_W, 1);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
      const lw = w / k;
      const lh = h / k;
      const dt = (now - last) / 1000;
      last = now;
      const sm = smooth.current;
      sm.update(dt, q.state, q.interp, q.data.network, q.nodeId);
      const pal = PALETTES[q.theme];
      if (q.view === 'cutaway') drawNodeCutaway(ctx, lw, lh, sm.nodeModel(q.state, q.interp, q.data.network, q.nodeId, false), now / 1000, pal, capacityColor(sm.full / 100, q.theme));
      else drawCatchmentProfile(ctx, lw, lh, sm.profileModel(q.state, q.interp, q.data.network, false), now / 1000, pal, (r) => capacityColor(r, q.theme));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const S = state.sensors[interp.sensorIndex.get(nodeId) ?? 0];
  return (
    <section className="sh-card rounded-md" aria-label="Section">
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <h2 className="sh-title">Section</h2>
        <div className="flex items-center gap-1">
          <div className="sh-seg !rounded-md" role="radiogroup" aria-label="Section view">
            {(
              [
                ['profile', 'Basin Profile'],
                ['cutaway', 'Manhole Cutaway'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={view === v} onClick={() => onView(v)} className="!rounded-[5px] !px-2 !text-[10px]">
                {label}
              </button>
            ))}
          </div>
          {onExpand && (
            <button onClick={onExpand} className="sh-btn rounded-md p-1.5" aria-label="Open the full Cross-Section Simulator">
              <Maximize2 size={13} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>
      <div ref={wrapRef} className="relative mx-3 overflow-hidden rounded" style={{ height }}>
        <canvas ref={canvasRef} className="block" aria-label={view === 'profile' ? 'Catchment longitudinal profile' : `${nodeId} manhole cutaway`} />
      </div>
      {view === 'cutaway' && (
        <div className="sh-mono grid grid-cols-4 gap-1 px-3 pt-2 text-[10.5px]">
          {(
            [
              ['Node', S.id],
              ['Fill', `${nodeFullnessPct(S).toFixed(0)} %`],
              ['dh/dt', `${(S.dhDtMmMin / 10).toFixed(1)} cm/min`],
              ['Packet', S.payloadHex],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <div className="sh-label !text-[9px]">{k}</div>
              <div className="sh-ink truncate">{v}</div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-3 pt-2 text-[10.5px]" aria-label="Section legend">
        {SECTION_LEGEND.map((l) => (
          <span key={l.label} className="sh-muted flex items-center gap-1">
            <span className={`inline-block h-2.5 w-2.5 ${l.label.startsWith('Critical') ? 'sh-blink' : ''}`} style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
    </section>
  );
}
