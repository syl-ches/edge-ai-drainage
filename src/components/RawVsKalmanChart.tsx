export interface DspSample {
  raw: number;
  kalman: number;
  truth: number;
}

/** Raw ultrasonic (splash spikes) vs Kalman-filtered depth: proof of on-device noise rejection. */
export function RawVsKalmanChart({ samples, height = 86 }: { samples: DspSample[]; height?: number }) {
  const w = 340;
  const h = height;
  const vals = samples.flatMap((s) => [s.raw, s.kalman, s.truth]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, 20);
  const x = (i: number) => (i / Math.max(samples.length - 1, 1)) * w;
  const y = (v: number) => h - 6 - ((v - lo) / span) * (h - 12);
  const line = (key: keyof DspSample) => samples.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join('');
  const last = samples[samples.length - 1];
  return (
    <div className="rounded-xl bg-slate-900/60 p-2 ring-1 ring-white/5">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[86px] w-full" preserveAspectRatio="none">
        <path d={line('raw')} fill="none" stroke="#F97316" strokeWidth="1" strokeOpacity="0.75" />
        <path d={line('truth')} fill="none" stroke="#64748B" strokeWidth="1" strokeDasharray="3 3" />
        <path d={line('kalman')} fill="none" stroke="#38BDF8" strokeWidth="1.8" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px]">
        <span className="text-orange-400">raw {last.raw.toFixed(0)} mm</span>
        <span className="text-sky-300">Kalman {last.kalman.toFixed(0)} mm</span>
        <span className="text-slate-500">truth {last.truth.toFixed(0)} mm</span>
      </div>
    </div>
  );
}
