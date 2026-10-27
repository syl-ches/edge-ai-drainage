import { memo, type ReactNode } from 'react';
import { Boxes, Building2, Gauge, Layers3, Moon, Sun, TreePine, Waves } from 'lucide-react';
import type { Theme } from '../three/theme';
import type { LayerFlags } from '../utils/urlState';

interface Props {
  theme: Theme;
  onTheme(t: Theme): void;
  layers: LayerFlags;
  onToggleLayer(key: keyof LayerFlags): void;
  simOpen: boolean;
  onSimulator(): void;
  inspectorOpen: boolean;
  onInspector(): void;
}

/** Short label below 2xl (1536 px), the full label above, so the bar never scrolls on laptops. */
function Label({ short, full }: { short: string; full: string }) {
  return (
    <>
      <span className="whitespace-nowrap 2xl:hidden">{short}</span>
      <span className="hidden whitespace-nowrap 2xl:inline">{full}</span>
    </>
  );
}

function Pill({ on, onClick, icon, children, title }: { on: boolean; onClick(): void; icon: ReactNode; children: ReactNode; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition ${
        on
          ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/50'
          : 'bg-slate-900/60 text-slate-500 ring-1 ring-white/10 hover:text-slate-300'
      }`}
    >
      {icon}
      {children}
      <span className={`ml-0.5 rounded px-1 font-mono text-[9px] ${on ? 'bg-sky-500/20' : 'bg-slate-800'}`}>{on ? 'ON' : 'OFF'}</span>
    </button>
  );
}

const LAYER_DEFS: { key: keyof LayerFlags; label: string; short: string; icon: ReactNode }[] = [
  { key: 'buildings', label: 'Surface Buildings', short: 'Buildings', icon: <Building2 size={13} /> },
  { key: 'vegetation', label: '3D Vegetation & Parks', short: 'Vegetation', icon: <TreePine size={13} /> },
  { key: 'network', label: 'Subsurface Drainage Network', short: 'Drainage', icon: <Waves size={13} /> },
  { key: 'badges', label: 'Node Fullness Badges', short: 'Badges', icon: <Gauge size={13} /> },
];

/** Theme switch, layer toggles and the two tool launchers (top of the viewport). */
function TopBarImpl(p: Props) {
  return (
    <div className="pointer-events-auto absolute inset-x-2 top-2 z-30 sm:left-[404px] sm:right-3 sm:top-3">
      <div className="flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-slate-800/80 bg-slate-950/75 p-1.5 shadow-xl shadow-black/30 backdrop-blur-md [scrollbar-width:none]">
        <div className="flex shrink-0 rounded-xl bg-slate-900/80 p-0.5 ring-1 ring-white/5" role="radiogroup" aria-label="Theme">
          {(
            [
              ['daylight', 'Daylight', 'Daylight Diorama', <Sun key="s" size={13} />],
              ['xray', 'X-Ray', 'Dark X-Ray', <Moon key="m" size={13} />],
            ] as const
          ).map(([t, short, label, icon]) => (
            <button
              key={t}
              role="radio"
              aria-checked={p.theme === t}
              onClick={() => p.onTheme(t)}
              title={label}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                p.theme === t ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/40' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {icon}
              <Label short={short} full={label} />
            </button>
          ))}
        </div>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-700" />
        {LAYER_DEFS.map((d) => (
          <Pill key={d.key} on={p.layers[d.key]} icon={d.icon} title={`Toggle ${d.label}`} onClick={() => p.onToggleLayer(d.key)}>
            <Label short={d.short} full={d.label} />
          </Pill>
        ))}
        <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-700" />
        <button
          onClick={p.onSimulator}
          title="Cross-Section Simulator"
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
            p.simOpen ? 'bg-sky-500 text-slate-950' : 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/50 hover:bg-sky-500/25'
          }`}
        >
          <Layers3 size={13} />
          <Label short="Simulator" full="Cross-Section Simulator" />
        </button>
        <button
          onClick={p.onInspector}
          title="Subsurface Utility Inspector"
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
            p.inspectorOpen ? 'bg-sky-500 text-slate-950' : 'bg-slate-900/70 text-slate-300 ring-1 ring-white/10 hover:text-slate-200'
          }`}
        >
          <Boxes size={13} />
          <Label short="Inspector" full="Utility Inspector" />
        </button>
      </div>
    </div>
  );
}

export const TopBar = memo(TopBarImpl);
