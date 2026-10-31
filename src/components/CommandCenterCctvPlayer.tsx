// Command Center CCTV monitor + DVR replay (Phase 9B).
//
// When an Edge-AI node reports rising water, the twin resolves the nearest existing Command Center
// cameras (src/utils/cctvStreams.ts) and shows them side by side with a DVR timeline over a
// 60-minute storm. A configured VMS stream (HLS / HTTP via the backend) or a local clip is played
// as-is; otherwise the camera's procedural replay of the intake compound is shown, and every
// procedural frame is labelled SIMULATED REPLAY on screen and in every export. The YOLOv8 overlay
// is drawn only on procedural frames (no model runs in the browser on real footage).
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Camera,
  Cctv,
  Download,
  Film,
  Link2,
  Link2Off,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  ScanEye,
  ShieldAlert,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import type { TwinData } from '../data/loadTwin';
import { LutInterpolator } from '../utils/lutInterpolator';
import {
  connectionBadge,
  feedSource,
  loadCctvRegistry,
  loadLocalClips,
  nearestCameras,
  type CctvRegistry,
  type NearestFeed,
} from '../utils/cctvStreams';
import {
  ACTION_LABEL,
  detectionsFor,
  formatStormTime,
  osdTimestamp,
  PLAYBACK_SPEEDS,
  REPLAY_MINUTES,
  REPLAY_PRESETS,
  replayFrame,
  SKIP_STORM_MIN,
  TIMELAPSE,
  type ReplayFrame,
  type ReplayPresetId,
} from '../cctv/replay';
import { createCctvRenderer, drawCctv, FEED_H, FEED_W, type CctvRenderer } from '../cctv/cctvScene';

interface Props {
  data: TwinData;
  sensorId: string;
  api: string | null;
  onClose(): void;
}

type Layout = 'split' | 'primary' | 'secondary';
const SIM_TAG = 'SIMULATED REPLAY';

const VERDICT_TONE: Record<string, string> = {
  TRASH_RACK_OCCLUSION_DISPATCH: 'btn-danger',
  LAGOON_OVERFLOW_EVACUATION: 'btn-danger',
  DOWNSTREAM_CHOKE_BACKWATER_OVERRIDE: 'btn-amber',
  DEBRIS_WATCH: 'btn-sky',
  NOMINAL: 'btn-accent',
};

export default function CommandCenterCctvPlayer({ data, sensorId, api, onClose }: Props) {
  const interp = useMemo(() => new LutInterpolator(data), [data]); // private: evaluate() mutates
  const [registry, setRegistry] = useState<CctvRegistry | null>(null);
  const [clips, setClips] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState(sensorId);
  const [preset, setPreset] = useState<ReplayPresetId>('backwater');
  const [tMin, setTMin] = useState(32);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof PLAYBACK_SPEEDS)[number]>(1);
  const [yolo, setYolo] = useState(true);
  const [layout, setLayout] = useState<Layout>('split');
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState<ReplayFrame>(() => replayFrame(interp, 'backwater', 32));
  // Authoritative replay clock for the render loop; React state follows it at 10 Hz.
  const tRef = useRef(tMin);
  const live = useRef({ playing, speed, preset, yolo, focus });
  live.current = { playing, speed, preset, yolo, focus };

  const canvasA = useRef<HTMLCanvasElement>(null);
  const canvasB = useRef<HTMLCanvasElement>(null);
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const composite = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    void loadCctvRegistry(api).then(setRegistry);
    void loadLocalClips().then(setClips);
  }, [api]);

  const sensor = data.network.sensors.find((s) => s.sensor_id === focus) ?? data.network.sensors[0];
  const feeds: NearestFeed[] = useMemo(() => (registry ? nearestCameras(sensor, registry, 2) : []), [registry, sensor]);
  const sources = feeds.map((f) => feedSource(f.camera, clips[f.camera.camera_id] ?? null));
  const hasProcedural = feeds.some((f) => f.camera.scene);

  // ---------------------------------------------------------------- render loop (30 fps)
  useEffect(() => {
    let renderer: CctvRenderer | null = null;
    try {
      renderer = createCctvRenderer();
    } catch {
      setNotice('WebGL is unavailable here, so the procedural replay cannot render. Real streams and clips still play.');
    }
    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    let n = 0;
    const t0 = performance.now();
    const wallStart = new Date();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const L = live.current;
      if (L.playing) {
        tRef.current = Math.min(tRef.current + (dt * TIMELAPSE * L.speed) / 60, REPLAY_MINUTES);
        if (tRef.current >= REPLAY_MINUTES) setPlaying(false);
      }
      if (now - lastDraw < 1000 / 30) return;
      lastDraw = now;
      n++;
      const f = replayFrame(interp, L.preset, tRef.current);
      if (n % 3 === 0) {
        setFrame(f);
        setTMin(tRef.current);
      }
      const t = (now - t0) / 1000;
      renderer?.update(t, { waterElevM: f.lagoonElevM, occlusionPct: f.occlusionPct, rainMmHr: f.rainMmHr, regime: f.regime });
      // OSD clock: replay start (now, when the monitor opened) + storm time.
      const osd = osdTimestamp(new Date(wallStart.getTime() + f.tMin * 60_000));
      const dets = detectionsFor(f);
      const draw = (cv: HTMLCanvasElement | null, video: HTMLVideoElement | null, feed: NearestFeed | undefined, src: string | undefined) => {
        if (!cv || !feed) return;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        const procedural = src === 'PROCEDURAL' && renderer && feed.camera.scene;
        let image: CanvasImageSource | null = null;
        let boxes: { det: (typeof dets)[number]; box: { key: string; x: number; y: number; w: number; h: number } }[] | null = null;
        if (procedural && renderer) {
          const r = renderer.render(feed.camera);
          image = r.image;
          boxes = L.yolo ? dets.flatMap((d) => r.boxes.filter((b) => b.key === d.key).map((b) => ({ det: d, box: b }))) : null;
        } else if (video && video.readyState >= 2) image = video;
        drawCctv(ctx, cv.width, cv.height, image, {
          timestamp: osd,
          label: feed.camera.osd_label,
          tag: procedural ? SIM_TAG : null,
          rainMmHr: procedural ? f.rainMmHr : 0,
          frame: n,
          detections: boxes as never,
        });
      };
      const fs = feedsRef.current;
      draw(canvasA.current, videoA.current, fs.feeds[0], fs.sources[0]);
      draw(canvasB.current, videoB.current, fs.feeds[1], fs.sources[1]);
      if (composite.current) composeEvidence(composite.current, f);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      renderer?.dispose();
    };
  }, [interp]);
  const feedsRef = useRef({ feeds, sources });
  feedsRef.current = { feeds, sources };

  // Video elements follow their source (stream URL or local clip).
  useEffect(() => {
    [videoA.current, videoB.current].forEach((v, i) => {
      if (!v) return;
      const feed = feeds[i];
      const url = feed?.camera.stream?.url ?? (feed ? clips[feed.camera.camera_id] : undefined);
      if (url && v.src !== url) {
        v.src = url;
        void v.play().catch(() => setNotice(`Could not play ${feed!.camera.camera_id}. Browsers need an HLS-capable player or an MP4 / WebM URL from the VMS gateway.`));
      }
      if (!url && v.src) v.removeAttribute('src');
    });
  }, [feeds, clips]);

  // Scrubbing moves local clips to the same fraction of their length.
  const seek = useCallback((t: number) => {
    const v = Math.min(Math.max(t, 0), REPLAY_MINUTES);
    tRef.current = v;
    setTMin(v);
    for (const el of [videoA.current, videoB.current]) if (el && el.duration > 0) el.currentTime = (v / REPLAY_MINUTES) * el.duration;
  }, []);

  const pickPreset = (id: ReplayPresetId) => {
    setPreset(id);
    seek(id === 'baseline' ? 10 : id === 'debris' ? 18 : 12);
    setPlaying(true);
  };

  // ---------------------------------------------------------------- evidence export
  function composeEvidence(out: HTMLCanvasElement, f: ReplayFrame) {
    const ctx = out.getContext('2d');
    if (!ctx) return;
    const W = out.width;
    const half = Math.round((W * 9) / 16);
    ctx.fillStyle = '#0B0E11';
    ctx.fillRect(0, 0, out.width, out.height);
    if (canvasA.current) ctx.drawImage(canvasA.current, 0, 0, W, half);
    if (canvasB.current) ctx.drawImage(canvasB.current, 0, half, W, half);
    const y = half * 2;
    const fs = feedsRef.current;
    const anyProcedural = fs.sources.includes('PROCEDURAL');
    const en08 = f.sensors['EN-08'];
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, y, W, out.height - y);
    ctx.fillStyle = '#F8FAFC';
    ctx.font = '700 22px ui-monospace, Consolas, monospace';
    ctx.fillText(`BAGUIO COMMAND CENTER CCTV EVIDENCE  ${live.current.focus}  ${fs.feeds.map((x) => x.camera.camera_id).join(' + ')}`, 24, y + 36);
    ctx.font = '500 19px ui-monospace, Consolas, monospace';
    ctx.fillText(
      `EN-08 ${en08.capacityPct.toFixed(0)} % ${en08.anomaly} payload ${en08.payloadHex}   rack occlusion ${f.occlusionPct.toFixed(0)} %   gauge ${f.gaugeM.toFixed(2)} m   rain ${f.rainMmHr.toFixed(0)} mm/hr`,
      24,
      y + 66,
    );
    ctx.fillText(`Fusion ${f.verdict.root_cause}   Action ${ACTION_LABEL[f.action]}   storm t ${formatStormTime(f.tMin)}`, 24, y + 94);
    ctx.fillStyle = anyProcedural ? '#FBBF24' : '#94A3B8';
    ctx.fillText(
      anyProcedural ? 'SIMULATED REPLAY: procedural rendering from the digital twin, not camera footage. Not admissible as incident evidence.' : 'Source: configured VMS stream / local clip.',
      24,
      y + 122,
    );
  }

  const evidenceCanvas = () => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = Math.round((1280 * 9) / 16) * 2 + 150;
    composeEvidence(c, frame);
    return c;
  };
  const stamp = () => `${focus}_${preset}_${formatStormTime(frame.tMin).replace(':', '')}`;
  const downloadSnapshot = () => {
    const c = evidenceCanvas();
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `CityCamp_CCTV_${stamp()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  };
  const recordClip = () => {
    if (typeof MediaRecorder === 'undefined') {
      setNotice('This browser cannot record canvas clips (MediaRecorder missing). Use the snapshot instead.');
      return;
    }
    const c = evidenceCanvas();
    composite.current = c;
    const stream = c.captureStream(30);
    const type = ['video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => {
      composite.current = null;
      setRecording(false);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(parts, { type: 'video/webm' }));
      a.download = `CityCamp_CCTV_${stamp()}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    setRecording(true);
    setPlaying(true);
    rec.start();
    setTimeout(() => rec.stop(), 8000);
  };

  const onDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    const feed = feeds[i];
    if (!file || !feed) return;
    if (!/^video\//.test(file.type)) {
      setNotice('Drop an .mp4 or .webm clip.');
      return;
    }
    setClips((c) => ({ ...c, [feed.camera.camera_id]: URL.createObjectURL(file) }));
  };
  const pickFile = (i: number) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/mp4,video/webm';
    input.onchange = () => {
      const file = input.files?.[0];
      const feed = feeds[i];
      if (file && feed) setClips((c) => ({ ...c, [feed.camera.camera_id]: URL.createObjectURL(file) }));
    };
    input.click();
  };

  const primary = feeds[0];
  const badge = primary ? connectionBadge(primary, focus, sources[0]) : 'Resolving nearest Command Center feeds';
  const connected = sources[0] === 'VMS_STREAM';
  const dets = detectionsFor(frame);

  const viewport = (i: number, ref: React.RefObject<HTMLCanvasElement | null>, vref: React.RefObject<HTMLVideoElement | null>) => {
    const feed = feeds[i];
    const show = layout === 'split' || (layout === 'primary' ? i === 0 : i === 1);
    return (
      <div className={`${show ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop(i)}>
        <div className="flex items-center gap-2 border-b border-[#1e293b] bg-[#0b1220] px-2 py-1 font-mono text-[10px] text-[#cbd5e1]">
          <Cctv size={12} strokeWidth={1.5} />
          <span className="font-bold text-[#f8fafc]">{feed?.camera.camera_id ?? '—'}</span>
          <span className="truncate">{feed?.camera.sector}</span>
          <span className="ml-auto tabular-nums">{feed ? `${feed.distanceM.toFixed(0)} m` : ''}</span>
          <span className={`rounded px-1.5 py-0.5 font-bold ${sources[i] === 'PROCEDURAL' ? 'bg-[#b45309] text-[#fffbeb]' : sources[i] === 'NO_SIGNAL' ? 'bg-[#334155] text-[#e2e8f0]' : 'bg-[#047857] text-[#ecfdf5]'}`}>
            {sources[i] === 'PROCEDURAL' ? 'SIMULATED' : sources[i] === 'VMS_STREAM' ? 'VMS' : sources[i] === 'LOCAL_CLIP' ? 'CLIP' : 'NO SIGNAL'}
          </span>
          <button onClick={() => pickFile(i)} title="Load a local .mp4 / .webm clip for this camera" className="rounded p-0.5 hover:bg-[#1e293b]" aria-label={`Load clip for ${feed?.camera.camera_id ?? 'camera'}`}>
            <Upload size={12} strokeWidth={1.5} />
          </button>
        </div>
        <div className="relative min-h-0 flex-1 bg-[#000000]">
          <canvas ref={ref} width={FEED_W} height={FEED_H} className="h-full w-full object-contain" aria-label={`${feed?.camera.name ?? 'Camera'} feed`} />
          <video ref={vref} className="hidden" muted loop playsInline crossOrigin="anonymous" />
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[72] flex flex-col bg-[#020617] text-[#e2e8f0]" role="dialog" aria-label="Command Center CCTV monitor">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#1e293b] bg-[#0f172a] px-3 py-2">
        <Cctv size={18} strokeWidth={1.5} className="text-[#22d3ee]" />
        <div className="mr-2 min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">Command Center CCTV · nearest feeds</div>
          <div className="truncate text-[14px] font-bold text-[#f8fafc]">
            {focus} · {sensor.name}
          </div>
        </div>
        <span className={`flex max-w-[620px] items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold ${connected ? 'border-[#047857] bg-[#064e3b] text-[#d1fae5]' : 'border-[#92400e] bg-[#451a03] text-[#fde68a]'}`}>
          {connected ? <Link2 size={12} strokeWidth={1.5} /> : <Link2Off size={12} strokeWidth={1.5} />}
          <span className="truncate">{badge}</span>
        </span>
        <select aria-label="Edge-AI node" value={focus} onChange={(e) => setFocus(e.target.value)} className="ml-auto rounded-md border border-[#334155] bg-[#0b1220] px-2 py-1 font-mono text-[11px]">
          {data.network.sensors.map((s) => (
            <option key={s.sensor_id} value={s.sensor_id}>
              {s.sensor_id} · {s.name}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-md border border-[#334155]" role="radiogroup" aria-label="Monitor layout">
          {(
            [
              ['split', 'Split'],
              ['primary', primary?.camera.camera_id.replace('CAM-', '') ?? 'A'],
              ['secondary', feeds[1]?.camera.camera_id.replace('CAM-', '') ?? 'B'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={layout === k} onClick={() => setLayout(k)} className={`px-2.5 py-1 font-mono text-[10px] font-semibold ${layout === k ? 'bg-[#f8fafc] text-[#0f172a]' : 'text-[#cbd5e1] hover:bg-[#1e293b]'}`}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="rounded-md border border-[#334155] p-1.5 hover:bg-[#1e293b]" aria-label="Close CCTV monitor">
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className={`flex min-h-0 flex-1 gap-1 p-1 ${layout === 'split' ? 'flex-col' : ''}`}>
          {viewport(0, canvasA, videoA)}
          {viewport(1, canvasB, videoB)}
        </div>

        <aside className="w-full shrink-0 space-y-2 overflow-y-auto border-t border-[#1e293b] bg-[#0b1220] p-3 text-[11px] lg:w-[340px] lg:border-l lg:border-t-0">
          {notice && (
            <div className="flex items-start gap-1.5 rounded-md border border-[#92400e] bg-[#451a03] px-2 py-1.5 text-[#fde68a]">
              <TriangleAlert size={13} strokeWidth={1.5} className="mt-0.5 shrink-0" /> {notice}
            </div>
          )}
          {!hasProcedural && (
            <button onClick={() => setFocus('EN-08')} className="w-full rounded-md border border-[#334155] px-2 py-1.5 text-left hover:bg-[#1e293b]">
              The nearest cameras for {focus} have no stream configured. Procedural replay exists for the City Camp Lagoon pair: show EN-08.
            </button>
          )}
          <section className={`rounded-md px-2.5 py-2 ${VERDICT_TONE[frame.action]}`}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] opacity-90">Multi-sensor fusion · {formatStormTime(frame.tMin)}</div>
            <div className="mt-0.5 text-[13px] font-bold">{ACTION_LABEL[frame.action]}</div>
            <div className="mt-1 opacity-90">{frame.verdict.action}</div>
            {frame.evacuationWarning && (
              <div className="mt-1.5 flex items-center gap-1 rounded bg-[#7f1d1d] px-1.5 py-1 font-bold text-[#fee2e2]">
                <ShieldAlert size={12} strokeWidth={1.5} />
                CDRRMO evacuation-warning review: lagoon overflow {frame.overflowEtaMin === 0 ? 'now' : `in about ${frame.overflowEtaMin?.toFixed(0)} min`}
              </div>
            )}
          </section>
          <section className="grid grid-cols-2 gap-1.5 font-mono tabular-nums">
            {(
              [
                ['Rack occlusion', `${frame.occlusionPct.toFixed(0)} %`],
                ['Staff gauge', `${frame.gaugeM.toFixed(2)} m`],
                ['EN-08 fill', `${frame.sensors['EN-08'].capacityPct.toFixed(0)} %`],
                ['EN-08 class', frame.sensors['EN-08'].anomaly],
                ['EN-10 choke', `${frame.sensors['EN-10'].capacityPct.toFixed(0)} %`],
                ['Rain', `${frame.rainMmHr.toFixed(0)} mm/hr`],
                ['Weir', frame.weirSubmerged ? 'SUBMERGED' : 'exposed'],
                ['EN-08 payload', frame.sensors['EN-08'].payloadHex],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-md border border-[#1e293b] bg-[#0f172a] px-2 py-1">
                <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-[#94a3b8]">{k}</div>
                <div className="truncate text-[12px] font-bold text-[#f8fafc]">{v}</div>
              </div>
            ))}
          </section>
          <section className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#94a3b8]">Storm replay presets</div>
            {REPLAY_PRESETS.map((p) => (
              <button key={p.id} onClick={() => pickPreset(p.id)} title={p.description} aria-pressed={preset === p.id} className={`block w-full rounded-md border px-2 py-1.5 text-left ${preset === p.id ? 'border-[#f8fafc] bg-[#1e293b] font-bold text-[#f8fafc]' : 'border-[#334155] hover:bg-[#1e293b]'}`}>
                {p.label}
              </button>
            ))}
          </section>
          <section className="space-y-1.5">
            <button onClick={() => setYolo((v) => !v)} aria-pressed={yolo} className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 font-semibold ${yolo ? 'border-[#22d3ee] bg-[#083344] text-[#cffafe]' : 'border-[#334155]'}`}>
              <ScanEye size={13} strokeWidth={1.5} /> YOLOv8 AI Vision Overlay: {yolo ? 'ON' : 'OFF'}
            </button>
            {yolo && (
              <ul className="space-y-0.5 font-mono text-[10px]">
                {dets.map((d) => (
                  <li key={d.key} className="flex justify-between">
                    <span>{d.label}</span>
                    <span className="tabular-nums">{d.confidence.toFixed(2)}</span>
                  </li>
                ))}
                <li className="text-[#94a3b8]">Overlay is drawn on procedural frames only. Confidences follow the replay state; inference on real footage runs on the Jetson node.</li>
              </ul>
            )}
          </section>
          <section className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#94a3b8]">Download CCTV evidence clip / snapshot</div>
            <div className="flex gap-1.5">
              <button onClick={downloadSnapshot} className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[#f8fafc] px-2 py-1.5 font-semibold text-[#0f172a]">
                <Camera size={13} strokeWidth={1.5} /> Snapshot PNG
              </button>
              <button onClick={recordClip} disabled={recording} className="flex flex-1 items-center justify-center gap-1 rounded-md border border-[#f8fafc] px-2 py-1.5 font-semibold disabled:opacity-60">
                <Film size={13} strokeWidth={1.5} /> {recording ? 'Recording 8 s' : 'Record 8 s clip'}
              </button>
            </div>
            <p className="text-[10px] text-[#94a3b8]">Exports burn in the OSD, overlay and EN-08 telemetry. Procedural frames are marked SIMULATED REPLAY in the image.</p>
          </section>
        </aside>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-[#1e293b] bg-[#0f172a] px-3 py-2 font-mono text-[11px]">
        <button onClick={() => seek(tRef.current - SKIP_STORM_MIN)} className="rounded-md border border-[#334155] px-2 py-1 hover:bg-[#1e293b]" title={`Back 15 s of time-lapse (${SKIP_STORM_MIN} storm min)`} aria-label="Back 15 seconds">
          <RotateCcw size={13} strokeWidth={1.5} className="mr-1 inline" />
          -15s
        </button>
        <button
          onClick={() => {
            if (!playing && tRef.current >= REPLAY_MINUTES) seek(0);
            setPlaying((p) => !p);
          }} className="rounded-md bg-[#f8fafc] px-3 py-1 font-bold text-[#0f172a]" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={14} strokeWidth={1.5} /> : <Play size={14} strokeWidth={1.5} />}
        </button>
        <button onClick={() => seek(tRef.current + SKIP_STORM_MIN)} className="rounded-md border border-[#334155] px-2 py-1 hover:bg-[#1e293b]" title={`Forward 15 s of time-lapse (${SKIP_STORM_MIN} storm min)`} aria-label="Forward 15 seconds">
          +15s
          <RotateCw size={13} strokeWidth={1.5} className="ml-1 inline" />
        </button>
        <span className="tabular-nums text-[#f8fafc]">{formatStormTime(tMin)}</span>
        <input
          type="range"
          min={0}
          max={REPLAY_MINUTES}
          step={0.05}
          value={tMin}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Replay timeline"
          className="hud-range h-2 min-w-[160px] flex-1 cursor-pointer appearance-none rounded-full"
          style={{ background: `linear-gradient(90deg, #22d3ee ${(tMin / REPLAY_MINUTES) * 100}%, #334155 0)` }}
        />
        <span className="tabular-nums text-[#94a3b8]">{formatStormTime(REPLAY_MINUTES)}</span>
        <div className="flex overflow-hidden rounded-md border border-[#334155]" role="radiogroup" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((s) => (
            <button key={s} role="radio" aria-checked={speed === s} onClick={() => setSpeed(s)} className={`px-2 py-1 ${speed === s ? 'bg-[#f8fafc] font-bold text-[#0f172a]' : 'hover:bg-[#1e293b]'}`}>
              {s}x
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[#94a3b8]">time-lapse: 1x = {TIMELAPSE} storm-s per s</span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-[#94a3b8]">
          <Download size={11} strokeWidth={1.5} /> drop an .mp4 / .webm on a viewport to replay real footage
        </span>
      </footer>
    </div>
  );
}
