import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileText, X } from 'lucide-react';
import { CanvasSurface, A4_H, A4_W } from '../utils/reportSurface';
import { countPages, downloadPdfReport, drawReport, REPORT_FILENAME, type ReportData } from '../utils/pdfReportGenerator';
import { ALARM_PCT } from '../utils/fullness';

/** Preview scale (canvas px per PDF pt), before devicePixelRatio. */
const PREVIEW_SCALE = 1.35;

/**
 * Data Analytics & Official PDF Report. The preview pages are drawn by the very same layout code
 * as the PDF (pdfReportGenerator.drawReport on a CanvasSurface), so what you see is what you
 * download. The PDF is built in the browser; no server is involved.
 */
function AnalyticsReportModalImpl({ data, onClose }: { data: ReportData; onClose(): void }) {
  const pages = useMemo(() => countPages(data), [data]);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const [last, setLast] = useState<{ pages: number; bytes: number } | null>(null);

  useEffect(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = PREVIEW_SCALE * dpr;
    const ctxFor = (i: number) => {
      const c = canvases.current[i];
      if (!c) throw new Error('preview canvas missing');
      c.width = Math.round(A4_W * scale);
      c.height = Math.round(A4_H * scale);
      return c.getContext('2d')!;
    };
    try {
      drawReport(new CanvasSurface(ctxFor, scale), data);
    } catch {
      /* page count changed between renders; the next data refresh redraws */
    }
  }, [data, pages]);

  const alarmed = data.sensors.filter((s) => s.id !== 'EN-09' && s.pct >= ALARM_PCT).length;
  const h60 = data.forecast?.horizons.at(-1);

  return (
    <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-[#020617]/50 p-2 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div role="dialog" aria-label="Data Analytics & Official PDF Report" className="hud-card flex h-full max-h-[920px] w-full max-w-[980px] flex-col overflow-hidden rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-700 px-4 py-2.5">
          <FileText size={18} className="text-emerald-300" />
          <div className="mr-auto min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300">Baguio City • CDRRMO • CEPMO • DPWH</div>
            <h2 className="truncate text-[15px] font-bold text-white">Data Analytics &amp; Official PDF Report</h2>
          </div>
          <button
            onClick={() => {
              const r = downloadPdfReport(data);
              setLast({ pages: r.pages, bytes: r.bytes.length });
            }}
            className="btn-accent flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px]"
          >
            <Download size={14} /> Download PDF Report
          </button>
          <button onClick={onClose} className="btn-idle rounded-lg p-1.5" aria-label="Close report">
            <X size={16} />
          </button>
        </header>
        <div className="flex flex-wrap gap-1.5 border-b border-slate-700 px-4 py-2 font-mono text-[11px] font-semibold">
          <span className="btn-idle rounded-full px-2.5 py-1">Lagoon {data.lagoon.depthM.toFixed(2)} m · {data.lagoon.surfaceElevM.toFixed(2)} m ASL</span>
          <span className="btn-idle rounded-full px-2.5 py-1">Rain {data.rainMmHr.toFixed(1)} mm/h</span>
          <span className={`rounded-full px-2.5 py-1 ${alarmed ? 'btn-danger' : 'btn-accent'}`}>{alarmed} nodes ≥ 80 %</span>
          {h60 && <span className="btn-idle rounded-full px-2.5 py-1">+60 min {h60.lagoon_depth_m.toFixed(2)} m · P(surch) {Math.round(h60.surcharge_probability_pct)} %</span>}
          <span className="btn-idle rounded-full px-2.5 py-1">{data.fusion.root_cause.replace(/_/g, ' ')}</span>
          <span className="btn-idle rounded-full px-2.5 py-1">{data.history.length} session snapshots</span>
          {last && (
            <span className="btn-accent rounded-full px-2.5 py-1">
              Saved {REPORT_FILENAME} · {last.pages} pages · {(last.bytes / 1024).toFixed(0)} kB
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto bg-[#cbd5e1] px-3 py-4">
          <div className="mx-auto flex max-w-[804px] flex-col gap-4">
            {Array.from({ length: pages }, (_, i) => (
              <canvas
                key={i}
                ref={(el) => {
                  canvases.current[i] = el;
                }}
                className="w-full rounded-sm bg-[#ffffff] shadow-xl"
                style={{ aspectRatio: `${A4_W} / ${A4_H}` }}
                aria-label={`Report page ${i + 1} of ${pages}`}
              />
            ))}
          </div>
        </div>
        <footer className="border-t border-slate-700 px-4 py-2 text-[10px] font-medium text-slate-400">
          A4 · one font (Helvetica 10 pt) · no colons or em dashes · vector charts and emblems (stylised placeholders, not official seals) · built in your browser.
        </footer>
      </div>
    </div>
  );
}

export const AnalyticsReportModal = memo(AnalyticsReportModalImpl);
