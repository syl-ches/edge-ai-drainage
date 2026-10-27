import { Pin } from 'lucide-react';
import type { CardModel } from './describe';

interface Props {
  card: CardModel;
  x: number;
  y: number;
  pinned: boolean;
}

const CARD_W = 300;

export function Tooltip({ card, x, y, pinned }: Props) {
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  // Flip to the cursor's left on the right half so the card never hides under the verification bar.
  const left = x > vw / 2 ? Math.max(x - CARD_W - 18, 12) : Math.min(x + 18, vw - CARD_W - 12);
  const top = Math.max(Math.min(y + 18, vh - 380), 12);
  return (
    <div
      className="pointer-events-none absolute z-40 rounded-xl border border-white/10 bg-slate-950/85 p-3 text-xs shadow-2xl shadow-black/60 backdrop-blur-md"
      style={{ left, top, width: CARD_W, borderTopColor: card.accent, borderTopWidth: 2 }}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400">
        <span>{card.kicker}</span>
        {pinned && <Pin size={11} className="text-slate-300" />}
      </div>
      <div className="mt-0.5 font-mono text-sm font-semibold text-white">{card.title}</div>
      <div className="truncate text-slate-400">{card.subtitle}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {card.badges.map((b) => (
          <span
            key={b.text}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
            style={{ color: b.color, background: `${b.color}1F`, boxShadow: `inset 0 0 0 1px ${b.color}55` }}
          >
            {b.text}
          </span>
        ))}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {card.rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-slate-500">{r.label}</dt>
            <dd className={`text-right ${r.mono ? 'font-mono' : ''} text-slate-200`} style={r.tone ? { color: r.tone } : undefined}>
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {!pinned && <div className="mt-2 text-[10px] text-slate-500">Click to inspect</div>}
    </div>
  );
}
