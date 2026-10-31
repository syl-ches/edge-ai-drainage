// Phone bottom sheet (< 768 px, Phase 9A): Maps-style sheet with three tabs over a full-screen
// 3D canvas. Tap a tab (or the grab handle) to raise / lower it; drag the handle down to dismiss.
import { memo, useRef, type ReactNode } from 'react';
import { ChartArea, ChevronRight, FileText, Radio } from 'lucide-react';
import type { TwinData } from '../../data/loadTwin';
import type { Theme } from '../../three/theme';
import type { LutInterpolator, TwinState } from '../../utils/lutInterpolator';
import type { Forecast } from '../../forecast/stgnn';
import { markerTone, MARKER_COLORS, nodeFullnessPct, visualBlockagePct } from '../../utils/fullness';
import type { ShellAction, ShellState, SheetTab } from '../../ui/shell';
import { ForecastPanel } from '../ForecastPanel';
import { SectionPanel } from './SectionPanel';

interface Props {
  shell: ShellState;
  dispatch(a: ShellAction): void;
  data: TwinData;
  interp: LutInterpolator;
  state: TwinState;
  theme: Theme;
  sectionNode: string;
  onNode(id: string): void;
  forecast: Forecast | null;
  forecastOrigin: 'BACKEND' | 'BROWSER';
  onReport(): void;
}

const TABS: { id: SheetTab; label: string; icon: ReactNode }[] = [
  { id: 'nodes', label: 'Live Nodes', icon: <Radio size={15} strokeWidth={1.5} /> },
  { id: 'section', label: 'Cross-Section', icon: <ChartArea size={15} strokeWidth={1.5} /> },
  { id: 'forecast', label: 'Forecast & PDF', icon: <FileText size={15} strokeWidth={1.5} /> },
];

function MobileSheetImpl(p: Props) {
  const drag = useRef<number | null>(null);
  const open = p.shell.sheetOpen;
  return (
    <div className="sh-sheet absolute inset-x-0 bottom-0 z-40 flex flex-col" style={{ maxHeight: '62vh', paddingBottom: 'env(safe-area-inset-bottom)' }} data-testid="mobile-sheet" aria-label="Bottom sheet">
      <button
        className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-[var(--sh-line-strong)]"
        aria-label={open ? 'Lower sheet' : 'Raise sheet'}
        onClick={() => p.dispatch({ type: 'sheet', open: !open })}
        onPointerDown={(e) => (drag.current = e.clientY)}
        onPointerUp={(e) => {
          if (drag.current === null) return;
          const dy = e.clientY - drag.current;
          drag.current = null;
          if (Math.abs(dy) > 24) p.dispatch({ type: 'sheet', open: dy < 0 });
        }}
      />
      <div className="sh-hair-b flex px-2 pt-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={open && p.shell.sheetTab === t.id}
            onClick={() => p.dispatch({ type: 'sheet', tab: t.id, open: !(open && p.shell.sheetTab === t.id) })}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${open && p.shell.sheetTab === t.id ? 'sh-ink border-b-2 border-[var(--sh-active)]' : 'sh-muted'}`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      {open && (
        <div className="overflow-y-auto overscroll-contain p-3">
          {p.shell.sheetTab === 'nodes' && (
            <ul className="space-y-1">
              {p.state.sensors.map((S) => {
                const tone = markerTone(S);
                const blk = visualBlockagePct(S);
                return (
                  <li key={S.id}>
                    <button onClick={() => p.onNode(S.id)} className="sh-card flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone === 'alarm' ? 'sh-blink' : ''}`} style={{ background: tone === 'alarm' ? '#DC2626' : MARKER_COLORS[tone] }} />
                      <span className="sh-mono sh-ink text-[13px] font-bold">{S.id}</span>
                      <span className="sh-muted min-w-0 flex-1 truncate text-[12px]">{S.sensor.name}</span>
                      <span className="sh-mono sh-ink text-[13px] font-bold">{blk !== null ? `${blk.toFixed(0)}% blk` : `${nodeFullnessPct(S).toFixed(0)}%`}</span>
                      <ChevronRight size={15} strokeWidth={1.5} className="sh-muted" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {p.shell.sheetTab === 'section' && (
            <SectionPanel
              data={p.data}
              interp={p.interp}
              state={p.state}
              theme={p.theme}
              nodeId={p.sectionNode}
              view={p.shell.sectionView}
              onView={(v) => p.dispatch({ type: 'sectionView', view: v })}
              height={200}
            />
          )}
          {p.shell.sheetTab === 'forecast' && (
            <div className="space-y-2.5">
              {p.forecast ? <ForecastPanel forecast={p.forecast} origin={p.forecastOrigin} /> : <div className="sh-muted text-[12px]">Computing the ST-GNN forecast…</div>}
              <button onClick={p.onReport} className="sh-btn sh-on flex w-full items-center justify-center gap-1.5 rounded-md py-3 text-[13px] font-semibold">
                <FileText size={15} strokeWidth={1.5} /> Download LGU PDF Report
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const MobileSheet = memo(MobileSheetImpl);
