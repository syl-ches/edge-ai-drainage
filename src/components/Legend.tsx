import { ANOMALY_COLORS, bandsFor } from '../three/palette';
import type { Theme } from '../three/theme';
import type { AnomalyClass } from '../types/twin';

const SHOWN: AnomalyClass[] = ['NORMAL', 'FLASH_SURGE', 'TRASH_BLOCKAGE', 'SUPERCRITICAL', 'SURCHARGED'];

export function Legend({ theme }: { theme: Theme }) {
  const bands = bandsFor(theme);
  return (
    <div className="pointer-events-none absolute bottom-8 right-14 z-10 hidden w-60 rounded-xl border border-white/10 bg-slate-950/75 p-3 text-[11px] text-slate-300 shadow-lg shadow-black/20 backdrop-blur-md sm:block">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">Conduit / node fullness</div>
      <div className="flex overflow-hidden rounded">
        {bands.map((b) => (
          <div key={b.label} className="h-2 flex-1" style={{ background: b.to ? `linear-gradient(90deg, ${b.color}, ${b.to})` : b.color }} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] leading-tight text-slate-500">
        {bands.map((b) => (
          <span key={b.label}>
            {b.label}
            <br />
            {b.name}
          </span>
        ))}
      </div>
      <div className="mb-1.5 mt-3 text-[10px] uppercase tracking-wider text-slate-500">Edge-AI anomaly</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {SHOWN.map((a) => (
          <div key={a} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: ANOMALY_COLORS[a] }} />
            <span className="truncate">{a.replace('_', ' ')}</span>
          </div>
        ))}
      </div>
      <div className="mb-1 mt-3 text-[10px] uppercase tracking-wider text-slate-500">Geometry</div>
      <div className="space-y-0.5 text-slate-400">
        <div><span className="font-mono text-slate-200">▭</span> RECT_CLOSED box / tunnel</div>
        <div><span className="font-mono text-slate-200">◯</span> CIRCULAR RCPC</div>
        <div><span className="font-mono text-slate-200">∩</span> ARCH rock choke</div>
        <div>Glass shell = structure · core = live water</div>
      </div>
    </div>
  );
}
