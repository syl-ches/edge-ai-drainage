import { useEffect, useRef } from 'react';
import { AlertTriangle, Camera } from 'lucide-react';
import type { TwinEngine } from '../three/TwinEngine';
import { ANOMALY_COLORS, capacityColor } from '../three/palette';
import type { Theme } from '../three/theme';
import type { TwinState } from '../utils/lutInterpolator';
import { nodeDepthM, nodeFullnessPct, visualBlockagePct } from '../utils/fullness';

interface Props {
  engine: TwinEngine;
  state: TwinState;
  rev: number;
  theme: Theme;
  visible: boolean;
  onSelect(id: string): void;
}

/**
 * Floating per-node fullness badges ("EN-08 • 72% Full • 1.94m" + mini vertical bar) pinned
 * above each 3D gauge; repositioned every frame with CSS transforms only (no React re-render).
 */
export function SensorBadges({ engine, state, theme, visible, onSelect }: Props) {
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
          el.style.transform = `translate(-50%, -100%) translate(${p.x.toFixed(1)}px, ${(p.y - 8).toFixed(1)}px)`;
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
        const pct = nodeFullnessPct(t);
        const fill = capacityColor(pct / 100, theme);
        const anomaly = ANOMALY_COLORS[t.anomaly];
        const blocked = visualBlockagePct(t);
        return (
          <button
            key={b.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => onSelect(b.id)}
            title={`${b.sensor.name} — ${t.anomaly}`}
            className="pointer-events-auto absolute left-0 top-0 items-center gap-1.5 rounded-lg border border-slate-800/90 bg-slate-950/90 py-1 pl-1 pr-2 font-mono text-[10px] font-semibold text-slate-100 shadow-lg shadow-black/25 backdrop-blur will-change-transform"
            style={{ display: 'none', boxShadow: `inset 3px 0 0 ${anomaly}` }}
          >
            <span className="relative ml-1 h-6 w-1.5 overflow-hidden rounded-full bg-slate-800">
              <span className="absolute inset-x-0 bottom-0 rounded-full" style={{ height: `${Math.min(pct, 100)}%`, background: fill }} />
            </span>
            <span className="whitespace-nowrap">
              <span className="text-sky-300">{b.id}</span>
              <span className="text-slate-500"> • </span>
              <span style={{ color: pct > 94 ? '#E11D48' : undefined }}>{pct.toFixed(0)}% Full</span>
              <span className="text-slate-500"> • </span>
              {nodeDepthM(t).toFixed(2)}m
            </span>
            {blocked !== null && (
              <span className="flex items-center gap-0.5 text-sky-300" title="YOLOv8 visual rack blockage">
                <Camera size={11} />
                {blocked.toFixed(0)}% blk
              </span>
            )}
            {t.saturated.length > 0 && <AlertTriangle size={11} className="text-amber-400" />}
          </button>
        );
      })}
    </div>
  );
}
