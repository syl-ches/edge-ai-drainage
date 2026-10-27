import { useEffect, useMemo, useState } from 'react';
import { encode } from 'uqr';
import { Check, Copy, QrCode, X } from 'lucide-react';
import { shareUrl } from '../utils/urlState';

const HOST_KEY = 'citycamp.qr.host';

function readHost(): string {
  try {
    return localStorage.getItem(HOST_KEY) ?? '';
  } catch {
    return '';
  }
}

/** QR matrix rendered as a single SVG path (crisp at any size, scannable from a projector). */
function QrSvg({ text }: { text: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x},${y}h1v1h-1z`;
      }),
    );
    return { path: d, size: qr.size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full" shapeRendering="crispEdges" role="img" aria-label="QR code for the current view">
      <rect width={size} height={size} fill="#FFFFFF" />
      <path d={path} fill="#020617" />
    </svg>
  );
}

export function QrShareModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const [host, setHost] = useState(readHost);
  const [copied, setCopied] = useState(false);
  const [, force] = useState(0);

  useEffect(() => {
    if (!open) return;
    // URL is debounce-written; refresh once it has settled.
    const t = window.setTimeout(() => force((n) => n + 1), 300);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem(HOST_KEY, host);
    } catch {
      /* private mode */
    }
  }, [host]);

  if (!open) return null;
  const url = shareUrl(host);
  const isLocalhost = /\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="hud-card w-full max-w-sm rounded-2xl p-5 text-slate-200"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-title"
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-sky-400">
              <QrCode size={11} /> Share this exact view
            </div>
            <h2 id="qr-title" className="text-base font-semibold text-white">
              Scan to open the 3D twin
            </h2>
          </div>
          <button onClick={onClose} className="btn-idle rounded-lg p-1.5" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="mx-auto mt-4 aspect-square w-60 overflow-hidden rounded-xl bg-[#ffffff] p-1">
          <QrSvg text={url} />
        </div>
        <div className="mt-3 break-all rounded-lg bg-slate-900/80 p-2 font-mono text-[10px] text-slate-400 ring-1 ring-white/5">{url}</div>
        <label className="mt-3 block text-[10px] uppercase tracking-wider text-slate-500">
          LAN IP / deployed host override
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="e.g. 192.168.1.23:5173 or https://twin.example.ph"
            className="mt-1 w-full rounded-lg bg-slate-900 px-2.5 py-2 font-mono text-xs normal-case tracking-normal text-slate-100 outline-none ring-1 ring-white/10 focus:ring-sky-400/60"
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        {isLocalhost && (
          <p className="mt-2 text-[11px] text-amber-300">
            “localhost” won’t resolve on panelists’ phones — enter this laptop’s Wi-Fi IP (dev server already listens on the LAN).
          </p>
        )}
        <button
          onClick={copy}
          className="btn-active mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm"
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? 'Copied' : 'Copy Prototype Link'}
        </button>
      </div>
    </div>
  );
}
