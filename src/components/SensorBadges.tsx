import { useEffect, useRef } from 'react';
import { Cctv, ChevronRight } from 'lucide-react';
import type { TwinEngine } from '../three/TwinEngine';
import type { Theme } from '../three/theme';
import type { TwinState } from '../utils/lutInterpolator';
import { badgeContent, MARKER_COLORS } from '../utils/fullness';

interface Props {
  engine: TwinEngine;
  state: TwinState;
  rev: number;
  theme: Theme;
  visible: boolean;
  onSelect(id: string): void;
  /** The vision node's pill (EN-09) opens the nearest Command Center CCTV feeds. */
  onCctv?(id: string): void;
}

/**
 * Compact clickable map pills pinned above each surface marker: status dot + `EN-XX` + one
 * number + chevron (`EN-08 88%`, CCTV icon + `EN-09 15% blk`). Alarmed nodes (>= 80 % full)
 * turn into a pulsing red pill. Clicking opens the node inspector + cross-section cutaway; the
 * vision node's pill also opens the Command Center CCTV monitor.
 * Positions are updated every frame with CSS transforms only (no React re-render).
 */
export function SensorBadges({ engine, state, visible, onSelect, onCctv }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const beacons = engine.sensors.beacons;

  useEffect(
    () =>
      engine.addFrameListener(() => {
        beacons.forEach((b, i) => {
          const el = refs.current[i];
          if (!el) return;
          const p = engine.project(b.top);
          el.style.display = p.visible ? 'flex' : 'none';
          el.style.transform = `translate(-50%, -100%) translate(${p.x.toFixed(1)}px, ${(p.y - 4).toFixed(1)}px)`;
        });
      }),
    [engine, beacons],
  );

  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {beacons.map((b, i) => {
        const t = state.sensors[i];
        if (!t) return null;
        const c = badgeContent(t);
        const alarm = c.tone === 'alarm';
        return (
          <button
            key={b.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => {
              onSelect(b.id);
              if (c.vision) onCctv?.(b.id);
            }}
            title={c.vision ? `${b.sensor.name}: open node inspector + nearest Command Center CCTV` : `${b.sensor.name}: open node inspector`}
            aria-label={`${c.id} ${c.value}${alarm ? ' alarm' : ''}: ${c.vision ? 'open CCTV monitor' : 'open node inspector'}`}
            data-tone={c.tone}
            className={`sensor-pill pointer-events-auto absolute left-0 top-0 cursor-pointer items-center gap-1.5 rounded-full py-1 pl-2 pr-1.5 font-mono text-[11px] font-bold shadow-lg will-change-transform ${
              alarm ? 'sensor-pill-alarm' : ''
            }`}
            style={{ display: 'none' }}
          >
            {c.vision ? (
              <Cctv size={12} strokeWidth={2} />
            ) : (
              <span className={`h-2 w-2 shrink-0 rounded-full ${alarm ? 'sensor-dot-blink' : ''}`} style={{ background: alarm ? '#FEE2E2' : MARKER_COLORS[c.tone] }} />
            )}
            <span className="whitespace-nowrap">{c.id}</span>
            <span className="whitespace-nowrap tabular-nums">{c.value}</span>
            <ChevronRight size={13} strokeWidth={3} className="-ml-0.5 opacity-80" />
          </button>
        );
      })}
    </div>
  );
}
