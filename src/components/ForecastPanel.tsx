import { memo } from 'react';
import type { Forecast } from '../forecast/stgnn';
import { ALARM_PCT } from '../utils/fullness';

const fmtMin = (m: number | null) => (m === null ? 'none in 12 h' : m <= 0 ? 'NOW' : m < 90 ? `${m.toFixed(0)} min` : `${(m / 60).toFixed(1)} h`);

/** ST-GNN +15 / +30 / +60 min forecast: lagoon stage with 90 % band, overflow, P(surcharge), next bottleneck. */
function ForecastPanelImpl({ forecast, origin }: { forecast: Forecast; origin: 'BACKEND' | 'BROWSER' }) {
  const peak = Math.max(...forecast.rain_trajectory_mm_hr);
  return (
    <div className="space-y-2 rounded-xl bg-slate-900/60 p-3 ring-1 ring-slate-700" data-testid="stgnn-forecast">
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="truncate font-bold text-emerald-300">{forecast.source.label}</span>
        <span className="shrink-0 font-mono font-semibold text-slate-400">
          {origin === 'BACKEND' ? 'backend' : 'in-browser'} · {forecast.graph.nodes} nodes · {forecast.members} members
        </span>
      </div>
      {/* rainfall trajectory sparkline (0..60 min) */}
      <svg viewBox="0 0 120 22" className="h-6 w-full" preserveAspectRatio="none" aria-label="Forecast rainfall 0 to 60 minutes">
        <polyline
          fill="none"
          stroke="#0284c7"
          strokeWidth="1.5"
          points={forecast.rain_trajectory_mm_hr.map((r, i) => `${(i / 60) * 120},${21 - (r / Math.max(peak, 1)) * 19}`).join(' ')}
        />
        {[15, 30, 60].map((m) => (
          <line key={m} x1={(m / 60) * 120} x2={(m / 60) * 120} y1="0" y2="22" stroke="#94a3b8" strokeDasharray="1.5 1.5" strokeWidth="0.6" />
        ))}
      </svg>
      <div className="grid grid-cols-3 gap-2">
        {forecast.horizons.map((h) => {
          const crit = h.next_bottleneck.capacity_pct >= ALARM_PCT;
          return (
            <div key={h.minutes} className="min-w-0 space-y-0.5">
              <div className="text-[10px] font-bold uppercase text-slate-500">+{h.minutes} min</div>
              <div className="font-mono text-[14px] font-bold text-white">{h.lagoon_depth_m.toFixed(2)} m</div>
              <div className="font-mono text-[9px] font-semibold text-slate-400">
                90 % {h.lagoon_depth_p05_m.toFixed(2)}–{h.lagoon_depth_p95_m.toFixed(2)}
              </div>
              <div className="font-mono text-[9px] text-slate-400">{h.surface_elev_m.toFixed(2)} m ASL</div>
              <div className={`font-mono text-[10px] font-bold ${h.surcharge_probability_pct >= 50 ? 'text-rose-400' : 'text-slate-300'}`}>
                P(surch) {h.surcharge_probability_pct.toFixed(0)}%
              </div>
              <div className={`font-mono text-[9px] font-semibold ${h.time_to_overflow_min !== null ? 'text-rose-400' : 'text-emerald-400'}`}>
                ovf {fmtMin(h.time_to_overflow_min)}
              </div>
              <div className={`truncate rounded px-1 font-mono text-[9px] font-bold ${crit ? 'btn-danger' : 'btn-idle'}`} title="Next critical bottleneck node">
                {h.next_bottleneck.sensor_id} {h.next_bottleneck.capacity_pct.toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[9px] font-medium text-slate-500">
        Overflow {fmtMin(forecast.time_to_overflow_min)} · RK4 lagoon + graph message passing over the 63-conduit network, FEWS orographic weighting.
      </div>
    </div>
  );
}

export const ForecastPanel = memo(ForecastPanelImpl);
