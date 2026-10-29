import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { NetworkFile } from '../types/twin';
import type { PickKind } from '../three/TwinEngine';
import type { TwinState } from '../utils/lutInterpolator';
import { markerTone, MARKER_COLORS } from '../utils/fullness';

export interface SearchPick {
  kind: PickKind;
  id: string;
  lng: number;
  lat: number;
}

interface Props {
  network: NetworkFile;
  state: TwinState;
  onPick(p: SearchPick): void;
}

interface Item extends SearchPick {
  title: string;
  sub: string;
  hay: string;
}

const GROUPS: { kind: PickKind; label: string }[] = [
  { kind: 'sensor', label: 'Sensors' },
  { kind: 'node', label: 'Nodes' },
  { kind: 'conduit', label: 'Conduits' },
];
const MAX_RESULTS = 12;

function buildIndex(network: NetworkFile): Item[] {
  const nodeById = new Map(network.nodes.map((n) => [n.id, n]));
  const items: Item[] = [];
  for (const s of network.sensors) {
    items.push({
      kind: 'sensor',
      id: s.sensor_id,
      lng: s.coordinates[0],
      lat: s.coordinates[1],
      title: `${s.sensor_id} ${s.name}`,
      sub: s.role.replace(/_/g, ' ').toLowerCase(),
      hay: `${s.sensor_id} ${s.name} ${s.role} ${s.mount_node}`.toLowerCase(),
    });
  }
  for (const n of network.nodes) {
    items.push({
      kind: 'node',
      id: n.id,
      lng: n.coordinates[0],
      lat: n.coordinates[1],
      title: `${n.id} ${n.name}`,
      sub: n.barangay,
      hay: `${n.id} ${n.name} ${n.barangay}`.toLowerCase(),
    });
  }
  for (const c of network.conduits) {
    const a = nodeById.get(c.from_node)?.coordinates ?? c.coordinates[0];
    const b = nodeById.get(c.to_node)?.coordinates ?? c.coordinates[1];
    items.push({
      kind: 'conduit',
      id: c.id,
      lng: (a[0] + b[0]) / 2,
      lat: (a[1] + b[1]) / 2,
      title: `${c.id} ${c.name}`,
      sub: `${c.road} · ${c.barangay}`,
      hay: `${c.id} ${c.name} ${c.road} ${c.barangay}`.toLowerCase(),
    });
  }
  return items;
}

/** Every whitespace-separated term must appear; ID prefix matches rank first. Empty query lists the sensors. */
function search(index: Item[], query: string): Item[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return index.filter((i) => i.kind === 'sensor');
  const hits = index.filter((i) => terms.every((t) => i.hay.includes(t)));
  const idFirst = (i: Item) => (i.id.toLowerCase().startsWith(terms[0]) ? 0 : 1);
  return hits.sort((a, b) => idFirst(a) - idFirst(b)).slice(0, MAX_RESULTS);
}

/** Collapsed search icon in the top bar; expands to an input with grouped results (sensors, nodes, conduits). */
export function SearchBox({ network, state, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const index = useMemo(() => buildIndex(network), [network]);
  const results = useMemo(() => search(index, query), [index, query]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setCursor(0);
  };
  const pick = (item: Item | undefined) => {
    if (!item) return;
    onPick(item);
    close();
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title="Search sensors, nodes and conduits" aria-label="Search" className="btn-idle flex shrink-0 items-center rounded-full p-2">
        <Search size={13} />
      </button>
    );
  }

  const dot = (item: Item) => {
    if (item.kind !== 'sensor') return null;
    const s = state.sensors.find((x) => x.id === item.id);
    return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s ? MARKER_COLORS[markerTone(s)] : '#94a3b8' }} />;
  };

  return (
    <>
      <div className="btn-idle flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-[11px]">
        <Search size={13} className="shrink-0" />
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.nativeEvent.stopPropagation(); // do not also clear the map selection
              close();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              pick(results[cursor]);
            }
          }}
          placeholder="Search EN-08, trash rack, TUN-C01…"
          aria-label="Search sensors, nodes and conduits"
          className="w-36 bg-transparent text-[11px] text-white outline-none placeholder:text-slate-400 sm:w-56"
        />
        <button onClick={close} aria-label="Close search" className="rounded-full p-1 hover:bg-white/10">
          <X size={12} />
        </button>
      </div>
      <div
        className="hud-card fixed inset-x-2 top-[calc(var(--topbar-h,48px)+16px)] z-40 max-h-[60vh] overflow-y-auto rounded-2xl p-1.5 text-[11px] sm:inset-x-auto sm:left-[404px] sm:w-[380px]"
        role="listbox"
      >
        {results.length === 0 && <div className="px-3 py-2 opacity-70">No sensors, nodes or conduits match “{query}”.</div>}
        {GROUPS.map((g) => {
          const rows = results.filter((r) => r.kind === g.kind);
          if (!rows.length) return null;
          return (
            <div key={g.kind}>
              <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-wide opacity-60">{g.label}</div>
              {rows.map((r) => (
                <button
                  key={`${r.kind}-${r.id}`}
                  role="option"
                  aria-selected={results[cursor] === r}
                  onClick={() => pick(r)}
                  onMouseEnter={() => setCursor(results.indexOf(r))}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left ${results[cursor] === r ? 'bg-sky-500/25' : ''}`}
                >
                  {dot(r)}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{r.title}</span>
                    <span className="block truncate text-[10px] opacity-70">{r.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
