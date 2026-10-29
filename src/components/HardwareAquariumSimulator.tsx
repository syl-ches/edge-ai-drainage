// Phase 7B companion site: /?view=hardware-sim (or /hardware-sim).
// An interactive aquarium / demo drainage tank with an ESP32-S3 / Arduino ultrasonic rig. Every
// 200 ms the virtual HC-SR04 / A02YYUW takes a 10-sample burst of the water surface (plus chop), runs
// it through the same edge pipeline as the firmware (Kalman + INT8 classifier + 32-bit packer,
// bench-standpipe scaling: 100 % = 74 % of the sensor height, 1 s = 1 storm-min) and broadcasts
// the packet to the 3D map tab (BroadcastChannel, < 2 ms, no backend) and to the FastAPI backend
// (POST /api/v1/ingest/lorawan). A physical board on USB (Web Serial) can replace the virtual one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Cpu, Droplets, Gauge, Hand, Radio, Unplug, Usb, Waves } from 'lucide-react';
import type { NetworkFile, Sensor } from '../types/twin';
import { backendBase } from '../live/telemetry';
import { openSyncBus, postToBackend, type HardwarePacket, type SyncBus, type SyncScope } from '../live/hardwareSync';
import { HardwareRig, type DistanceUnit } from '../live/serialRig';
import { useUsbRig } from '../live/useUsbRig';
import { ALARM_PCT, ELEVATED_PCT, MARKER_COLORS, alarmBlink, sensorGeometry } from '../utils/fullness';
import { PAYLOAD_FIELDS, unpackTelemetryPayload } from '../utils/payloadCodec';
import { BLIND_ZONE_MM, STANDPIPE_FULL_BORE_FRACTION } from '../edge/edgePipeline';

const TICK_MS = 200;
const POST_MS = 500;
const POUR_SURGE_PCT = 15;
const POUR_RATE_PCT_S = 10; // +15 % over 1.5 s: long enough for the Kalman to flag FLASH_SURGE
const HOLD_RATE_PCT_S = 12;
const DRAIN_RATE_PCT_S = 12;
const SEEK_RATE_PCT_S = 30;
const SURGE_CHOP_MM = 16;
const BASE_CHOP_MM = 1.5;
const FLAT_CHOP_MM = 0.6;
const MAX_FILL = 120;

export type BoardKind = 'ESP32_S3' | 'UNO';
export type UltrasonicKind = 'HC-SR04' | 'A02YYUW';
/** Pinout of firmware/universal_hcsr04_node (resistor-free hackathon wiring). */
export const BOARDS: Record<BoardKind, { name: string; pins: string; link: string }> = {
  ESP32_S3: { name: 'ESP32-S3 · universal edge node', pins: 'TRIG 5 · ECHO 6 · LED G 7 · Y 8 · R 9', link: 'USB serial + Wi-Fi POST every 500 ms' },
  UNO: { name: 'Arduino Uno · universal edge node', pins: 'TRIG 9 · ECHO 10 · LED G 4 · Y 5 · R 6', link: 'USB serial 115200 baud' },
};
/** Near-field blind zone drawn under the transducer, mm. */
const BLIND_MM: Record<UltrasonicKind, number> = { 'HC-SR04': 20, A02YYUW: BLIND_ZONE_MM };

export const AQUARIUM_PRESETS = [
  { id: 'empty', label: 'Empty (0%)', fill: 0, flat: false },
  { id: 'normal', label: 'Normal Flow (30%)', fill: 30, flat: false },
  { id: 'elevated', label: 'Elevated (60%)', fill: 60, flat: false },
  { id: 'alarm', label: 'Almost Full — Trigger Red Blink (85%)', fill: 85, flat: false },
  { id: 'surcharge', label: 'Full Surcharge (105%)', fill: 105, flat: false },
  { id: 'clog', label: 'Simulate Trash Clog Backwater (82% Flat Pool)', fill: 82, flat: true },
] as const;

export const TANK_MARKS = [
  { pct: 0, label: '0% Dry' },
  { pct: 45, label: '45% Elevated' },
  { pct: 80, label: '80% High Alarm — Blinks Red on Map' },
  { pct: 94, label: '94% Pipe Peak' },
  { pct: 100, label: '100% Full / Overflow' },
];

interface Sim {
  level: number;
  target: number | null;
  pourRemaining: number;
  holding: boolean;
  draining: boolean;
  chop: number;
  flat: boolean;
}

function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

const params = () => new URLSearchParams(window.location.search);

export default function HardwareAquariumSimulator() {
  const [network, setNetwork] = useState<NetworkFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sensorId, setSensorId] = useState(() => (/^EN-\d{2}$/.test(params().get('sensor') ?? '') ? params().get('sensor')! : 'EN-08'));
  const [scope, setScope] = useState<SyncScope>('single_node');
  const [syncOn, setSyncOn] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [tankMm, setTankMm] = useState(300);
  const [board, setBoard] = useState<BoardKind>(() => (params().get('board') === 'uno' ? 'UNO' : 'ESP32_S3'));
  const [ultrasonic, setUltrasonic] = useState<UltrasonicKind>('HC-SR04');
  const [unit, setUnit] = useState<DistanceUnit>('auto');
  const [level, setLevel] = useState(0);
  const [packet, setPacket] = useState<HardwarePacket | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [backend, setBackend] = useState<'unknown' | 'ok' | 'offline'>('unknown');
  const [txFlash, setTxFlash] = useState(0);
  const api = params().get('api');
  const sim = useRef<Sim>({ level: 0, target: null, pourRemaining: 0, holding: false, draining: false, chop: BASE_CHOP_MM, flat: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bus = useRef<SyncBus | null>(null);
  const lastPost = useRef(0);
  const monitorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = 'daylight';
    document.title = 'Arduino & Aquarium Drainage Simulator · City Camp Twin';
    fetch(`${import.meta.env.BASE_URL}data/city_camp_network.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((n: NetworkFile) => setNetwork({ ...n, sensors: n.sensors.filter((s) => s.is_active), conduits: n.conduits.filter((c) => c.is_active) }))
      .catch((e: Error) => setError(e.message));
  }, []);

  const sensor: Sensor | undefined = network?.sensors.find((s) => s.sensor_id === sensorId);
  const rigCfg = useMemo(
    () => ({
      sensorId,
      deviceEui: sensor?.device_eui ?? sensorId,
      fullScaleM: sensor && network ? sensorGeometry(sensor, network).fullScaleM : 1,
      tankHeightMm: tankMm,
      scope,
      origin: 'AQUARIUM_SIM' as const,
    }),
    [sensorId, sensor, network, tankMm, scope],
  );
  const rig = useRef<HardwareRig | null>(null);
  rig.current ??= new HardwareRig(rigCfg);
  useEffect(() => rig.current!.configure(rigCfg), [rigCfg]);

  // ------------------------------------------------------------------ packet fan-out
  const emit = useCallback(
    (p: HardwarePacket, line: string) => {
      setPacket(p);
      setTxFlash((x) => x + 1);
      setLog((l) => {
        const next = l.length >= 120 ? l.slice(l.length - 119) : l.slice();
        next.push(line);
        return next;
      });
      if (!syncOnRef.current) return;
      bus.current?.publish(p);
      const now = Date.now();
      if (now - lastPost.current >= POST_MS) {
        lastPost.current = now;
        void postToBackend(backendBase(api), p).then((ok) => setBackend(ok ? 'ok' : 'offline'));
      }
    },
    [api],
  );
  const syncOnRef = useRef(syncOn);
  syncOnRef.current = syncOn;

  useEffect(() => {
    const b = openSyncBus();
    bus.current = b;
    const off = b.subscribe((m) => {
      if (m.type === 'disconnect' && m.from === 'MAP') {
        setSyncOn(false);
        setNotice('The 3D map disconnected this simulator. Sync is paused: switch it back on to resume.');
      }
    });
    return () => {
      off();
      b.close();
    };
  }, []);

  const usb = useUsbRig({ ...rigCfg, origin: 'WEB_SERIAL' }, unit, (p) => {
    sim.current.level = Math.min(Math.max(p.fillPct, 0), MAX_FILL);
    emit(p, `[EDGE_TX] {"device_eui":"${p.sensorId}","payload_hex":"${p.payloadHex}","fill_pct":${p.fillPct.toFixed(1)},"anomaly":"${p.anomaly}"}`);
  });
  const usbLive = usb.status === 'connected';

  // ------------------------------------------------------------------ physics + virtual sensor
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastTick = 0;
    let lastUi = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const s = sim.current;
      if (!usbLive) {
        if (s.holding) {
          s.level += HOLD_RATE_PCT_S * dt;
          s.chop = Math.max(s.chop, SURGE_CHOP_MM);
        }
        if (s.pourRemaining > 0) {
          const d = Math.min(POUR_RATE_PCT_S * dt, s.pourRemaining);
          s.level += d;
          s.pourRemaining -= d;
          s.chop = Math.max(s.chop, SURGE_CHOP_MM);
        }
        if (s.draining) {
          s.level -= DRAIN_RATE_PCT_S * dt;
          s.chop = Math.max(s.chop, 3);
          if (s.level <= 0) {
            s.level = 0;
            s.draining = false;
          }
        }
        if (s.target !== null) {
          const step = SEEK_RATE_PCT_S * dt;
          if (Math.abs(s.target - s.level) <= step) {
            s.level = s.target;
            s.target = null;
          } else s.level += Math.sign(s.target - s.level) * step;
        }
        s.level = Math.min(Math.max(s.level, 0), MAX_FILL);
        const base = s.flat ? FLAT_CHOP_MM : BASE_CHOP_MM;
        s.chop += (base - s.chop) * (1 - Math.exp(-dt / 1.2));
        if (now - lastTick >= TICK_MS && rig.current) {
          lastTick = now;
          const d = rig.current.distanceForFill(s.level);
          const burst = Array.from({ length: 10 }, () => {
            let x = d + gauss() * s.chop;
            if (s.chop > 8 && Math.random() < 0.12) x -= 40 + Math.random() * 40; // splash echo
            return Math.round(Math.max(x, 5) * 10) / 10;
          });
          const p = rig.current.ingestBurst(burst, now);
          emit(p, `[EDGE_TX] {"device_eui":"${p.sensorId}","payload_hex":"${p.payloadHex}","dist_mm":${(p.distanceMm ?? 0).toFixed(0)},"fill_pct":${p.fillPct.toFixed(1)},"anomaly":"${p.anomaly}"}`);
        }
      }
      if (now - lastUi > 66) {
        lastUi = now;
        setLevel(s.level);
      }
      draw(now / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usbLive, emit, tankMm]);

  useEffect(() => {
    const el = monitorRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, usb.lines]);

  // ------------------------------------------------------------------ canvas
  const latestPacket = useRef<HardwarePacket | null>(null);
  const ultrasonicRef = useRef(ultrasonic);
  ultrasonicRef.current = ultrasonic;
  latestPacket.current = packet;
  const draw = (t: number) => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAquarium(ctx, W, H, t, sim.current, latestPacket.current, tankMm, ultrasonicRef.current);
  };

  // ------------------------------------------------------------------ controls
  const setTarget = (v: number, flat = false) => {
    const s = sim.current;
    s.target = v;
    s.flat = flat;
    s.draining = false;
    s.pourRemaining = 0;
  };
  const pour = () => {
    const s = sim.current;
    s.pourRemaining += POUR_SURGE_PCT;
    s.target = null;
    s.flat = false;
    s.draining = false;
  };
  const drain = () => {
    const s = sim.current;
    s.draining = true;
    s.target = null;
    s.pourRemaining = 0;
    s.flat = false;
  };

  if (error) return <div className="p-6 text-sm font-semibold text-[#b91c1c]">Could not load the network ({error}).</div>;

  const pct = packet ? Math.min(packet.capacityPct, 127) : 0;
  const alarm = pct >= ALARM_PCT || packet?.anomaly === 'SURCHARGED';
  const decoded = packet ? unpackTelemetryPayload(parseInt(packet.payloadHex, 16) >>> 0) : null;
  const codes = decoded ? [decoded.depthCode, decoded.dhDtCode, decoded.capCode, decoded.anomCode, decoded.vbatCode] : [];
  const values = decoded ? [`${decoded.depthMm} mm`, `${decoded.dhDtMmMin} mm/min`, `${decoded.capPct} %`, String(decoded.anomaly), `${decoded.vbatV.toFixed(2)} V`] : [];
  const airGap = packet?.distanceMm ?? rig.current?.distanceForFill(level) ?? 0;
  const mapUrl = `${import.meta.env.BASE_URL}${api ? `?api=${encodeURIComponent(api)}` : ''}`;

  return (
    <div className="min-h-full overflow-y-auto bg-[#eef2f0] text-[#0f172a]" style={{ height: '100%' }}>
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[#cbd5e1] bg-[#ffffff]/95 px-4 py-2 shadow-sm">
        <a href={mapUrl} target="_blank" rel="noreferrer" className="btn-idle flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px]">
          <ArrowLeft size={13} /> 3D map
        </a>
        <div className="mr-auto min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#047857]">Edge-AI Digital Twin · Companion</div>
          <h1 className="truncate text-[16px] font-extrabold">Arduino / ESP32 &amp; Aquarium Drainage Simulator</h1>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] font-bold">
          Map sensor
          <select aria-label="Target map sensor" value={sensorId} onChange={(e) => setSensorId(e.target.value)} className="btn-idle rounded-lg px-2 py-1.5 text-[11px]">
            {(network?.sensors ?? []).map((s) => (
              <option key={s.sensor_id} value={s.sensor_id}>
                {s.sensor_id} · {s.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-1" role="radiogroup" aria-label="Map sync scope">
          {(
            [
              ['single_node', 'Targeted Sensor Mode'],
              ['full_catchment', 'Full Catchment Coupling Mode'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={scope === k} onClick={() => setScope(k)} className={`rounded-full px-3 py-1.5 text-[11px] ${scope === k ? 'btn-active' : 'btn-idle'}`}>
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setSyncOn((v) => !v);
            setNotice(null);
          }}
          aria-pressed={syncOn}
          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] ${syncOn ? 'btn-accent' : 'btn-danger'}`}
        >
          {syncOn ? <Radio size={13} /> : <Unplug size={13} />} {syncOn ? 'Map sync ON' : 'Map sync paused'}
        </button>
      </header>

      {notice && <div className="mx-4 mt-3 rounded-xl bg-[#fef3c7] px-3 py-2 text-[12px] font-semibold text-[#78350f] ring-1 ring-[#f59e0b]">{notice}</div>}

      <main className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="hud-card flex min-h-[460px] flex-col overflow-hidden rounded-2xl">
          <div className="flex flex-wrap items-center gap-2 border-b border-[#cbd5e1] px-3 py-2 text-[11px] font-semibold">
            <span className={`rounded-full px-2 py-0.5 font-mono text-[12px] font-extrabold text-[#ffffff] ${alarm ? 'hw-banner-alarm' : ''}`} style={alarm ? undefined : { background: pct >= ELEVATED_PCT ? MARKER_COLORS.elevated : MARKER_COLORS.normal }}>
              {sensorId} · {pct.toFixed(0)}% full
            </span>
            <span className="font-mono">air gap {airGap.toFixed(0)} mm ({(airGap / 10).toFixed(1)} cm)</span>
            <span className="font-mono">dh/dt {(packet?.dhDtMmMin ?? 0).toFixed(1)} mm/min</span>
            <span className="font-mono">σ²_d {(packet?.sigmaD2 ?? 0).toFixed(1)} mm²</span>
            <span className="rounded-full bg-[#0f172a] px-2 py-0.5 font-mono text-[11px] font-bold text-[#ffffff]">{packet?.anomaly ?? 'NORMAL'}</span>
            <span className="ml-auto text-[#475569]">{usbLive ? `USB board ${usb.label}` : `Virtual ${ultrasonic} · 5 Hz`}</span>
          </div>
          <div ref={wrapRef} className="relative min-h-[380px] flex-1">
            <canvas ref={canvasRef} className="absolute inset-0 block" aria-label="Aquarium drainage tank visualisation" />
          </div>
          <div className="space-y-2 border-t border-[#cbd5e1] px-3 py-3">
            <label className="flex items-center gap-3 text-[11px] font-bold">
              <span className="w-28 shrink-0">Water level</span>
              <input
                type="range"
                min={0}
                max={MAX_FILL}
                step={1}
                value={Math.round(level)}
                disabled={usbLive}
                aria-label="Aquarium water level percent"
                onChange={(e) => setTarget(Number(e.target.value))}
                className="hud-range h-2 flex-1 cursor-pointer appearance-none rounded-full"
                style={{ background: `linear-gradient(90deg, #10b981, #f59e0b ${(ELEVATED_PCT / MAX_FILL) * 100}%, #dc2626 ${(ALARM_PCT / MAX_FILL) * 100}%, #7f1d1d)` }}
              />
              <span className="w-14 text-right font-mono text-[14px]">{level.toFixed(0)}%</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={pour} disabled={usbLive} className="btn-sky flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] disabled:opacity-50">
                <Droplets size={13} /> Pour Water (+15% Surge)
              </button>
              <button
                disabled={usbLive}
                onPointerDown={() => {
                  sim.current.holding = true;
                  sim.current.target = null;
                  sim.current.flat = false;
                  sim.current.draining = false;
                }}
                onPointerUp={() => (sim.current.holding = false)}
                onPointerLeave={() => (sim.current.holding = false)}
                onPointerCancel={() => (sim.current.holding = false)}
                className="btn-active flex select-none items-center gap-1 rounded-full px-3 py-1.5 text-[11px] disabled:opacity-50"
              >
                <Hand size={13} /> Hold to Pour
              </button>
              <button onClick={drain} disabled={usbLive} className="btn-danger flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] disabled:opacity-50">
                <Waves size={13} /> Open Drain Valve
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5" aria-label="Quick demo presets">
              {AQUARIUM_PRESETS.map((pr) => (
                <button
                  key={pr.id}
                  disabled={usbLive}
                  onClick={() => setTarget(pr.fill, pr.flat)}
                  className={`rounded-full px-2.5 py-1 text-[10px] disabled:opacity-50 ${pr.fill >= ALARM_PCT ? 'btn-amber' : 'btn-idle'}`}
                >
                  {pr.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="flex flex-col gap-3">
          {/* Virtual board */}
          <div className="rounded-2xl bg-[#0c3b2e] p-3 text-[#ffffff] shadow-xl ring-1 ring-[#065f46]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu size={18} />
                <div>
                  <div className="text-[13px] font-extrabold">{BOARDS[board].name}</div>
                  <div className="font-mono text-[10px] text-[#a7f3d0]">
                    {rigCfg.deviceEui} → {sensorId} · {ultrasonic} · {BOARDS[board].link}
                  </div>
                </div>
              </div>
              <div className="flex gap-1" role="radiogroup" aria-label="Board">
                {(
                  [
                    ['ESP32_S3', 'ESP32-S3'],
                    ['UNO', 'Uno'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} role="radio" aria-checked={board === k} onClick={() => setBoard(k)} className={`rounded-full px-2 py-0.5 text-[10px] ${board === k ? 'btn-accent' : 'btn-idle'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 font-mono text-[10px] text-[#a7f3d0]">{BOARDS[board].pins}</div>
            <div className="mt-3 grid grid-cols-5 gap-1 text-center text-[10px] font-bold">
              <Led on color="#22c55e" label="PWR" />
              <Led key={txFlash} on flash color="#22d3ee" label="TX" />
              <Led on={pct < ELEVATED_PCT} color="#22c55e" label="GREEN <45%" />
              <Led on={pct >= ELEVATED_PCT && !alarm} color="#facc15" label="YELLOW 45-79%" />
              <Led on={alarm} blink color="#ef4444" label="RED ≥80% 3 Hz" />
            </div>
            <div className="mt-3 rounded-lg bg-black/30 p-2 font-mono">
              <div className="text-[10px] text-[#a7f3d0]">32-bit uplink (big-endian)</div>
              <div className="text-[22px] font-extrabold tracking-wider">{packet?.payloadHex ?? '0x00000000'}</div>
              <table className="mt-1 w-full text-[10px]">
                <tbody>
                  {PAYLOAD_FIELDS.map((f, i) => (
                    <tr key={f.key}>
                      <td className="pr-1" style={{ color: f.color }}>
                        [{f.bits[0]}:{f.bits[1]}]
                      </td>
                      <td>{f.label}</td>
                      <td className="text-right">{codes[i] ?? 0}</td>
                      <td className="pl-2 text-right text-[#d1fae5]">{values[i] ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Serial monitor */}
          <div className="hud-card flex min-h-[220px] flex-col overflow-hidden rounded-2xl">
            <div className="flex items-center justify-between border-b border-[#cbd5e1] px-3 py-1.5 text-[11px] font-bold">
              <span>Arduino Serial Monitor · 115200 baud</span>
              <span className="font-mono text-[10px] text-[#475569]">{usbLive ? 'USB' : 'virtual'}</span>
            </div>
            <div ref={monitorRef} className="h-56 overflow-y-auto bg-[#020617] px-2 py-1 font-mono text-[10px] leading-snug text-[#86efac]" aria-live="off">
              {(usbLive ? usb.lines : log).map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {l}
                </div>
              ))}
            </div>
          </div>

          {/* USB + sync status */}
          <div className="hud-card space-y-2 rounded-2xl p-3 text-[11px]">
            <div className="flex flex-wrap gap-1.5">
              {usbLive ? (
                <button onClick={() => void usb.disconnect()} className="btn-danger flex items-center gap-1 rounded-full px-3 py-1.5">
                  <Unplug size={13} /> Disconnect USB board
                </button>
              ) : (
                <button
                  onClick={() => void usb.connect()}
                  disabled={usb.status === 'unsupported' || usb.status === 'connecting'}
                  className="btn-active flex items-center gap-1 rounded-full px-3 py-1.5 disabled:opacity-50"
                >
                  <Usb size={13} /> {usb.status === 'connecting' ? 'Connecting…' : 'Connect USB Arduino / ESP32'}
                </button>
              )}
              <select aria-label="Ultrasonic sensor" value={ultrasonic} onChange={(e) => setUltrasonic(e.target.value as UltrasonicKind)} className="btn-idle rounded-lg px-2 py-1">
                <option value="HC-SR04">HC-SR04 / JSN-SR04T</option>
                <option value="A02YYUW">DFRobot A02YYUW</option>
              </select>
              <select aria-label="Distance unit for plain numbers" value={unit} onChange={(e) => setUnit(e.target.value as DistanceUnit)} className="btn-idle rounded-lg px-2 py-1">
                <option value="auto">plain numbers: auto mm/cm</option>
                <option value="mm">plain numbers: mm</option>
                <option value="cm">plain numbers: cm</option>
              </select>
              <label className="flex items-center gap-1 font-bold">
                sensor → floor
                <input
                  type="number"
                  min={100}
                  max={2000}
                  step={10}
                  value={tankMm}
                  onChange={(e) => setTankMm(Math.min(Math.max(Number(e.target.value) || 400, 100), 2000))}
                  className="btn-idle w-20 rounded-lg px-2 py-1 font-mono"
                />
                mm
              </label>
            </div>
            <p className="font-medium text-[#334155]">
              {usb.status === 'unsupported'
                ? 'Web Serial needs Chrome or Edge on desktop. Otherwise run scripts/serial_bridge.py.'
                : `100 % full = ${(tankMm * STANDPIPE_FULL_BORE_FRACTION).toFixed(0)} mm of water (74 % of the ${tankMm} mm sensor height). Flash firmware/universal_hcsr04_node (ESP32-S3 or Uno + HC-SR04, USB or Wi-Fi) or firmware/arduino_aquarium_demo (Uno / Nano / Mega / ESP32, HC-SR04 / JSN-SR04T / A02YYUW).`}
            </p>
            {usb.error && <p className="font-semibold text-[#b91c1c]">{usb.error}</p>}
            <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
              <span className={`rounded-full px-2 py-0.5 font-bold ${bus.current?.transport === 'none' ? 'btn-danger' : 'btn-accent'}`}>cross-tab: {bus.current?.transport ?? '…'}</span>
              <span className={`rounded-full px-2 py-0.5 font-bold ${backend === 'ok' ? 'btn-accent' : backend === 'offline' ? 'btn-amber' : 'btn-idle'}`}>
                backend {backendBase(api)}: {backend === 'ok' ? 'ingesting' : backend === 'offline' ? 'offline (map still syncs)' : '…'}
              </span>
              <span className="btn-idle rounded-full px-2 py-0.5 font-bold">
                <Gauge size={10} className="mr-1 inline" />
                scope: {scope === 'single_node' ? 'targeted sensor' : 'full catchment'}
              </span>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function Led({ on, color, label, blink = false, flash = false }: { on: boolean; color: string; label: string; blink?: boolean; flash?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className={`h-4 w-4 rounded-full ring-2 ring-black/40 ${on && blink ? 'sensor-dot-blink' : ''} ${on && flash ? 'led-flash' : ''}`}
        style={{ background: on ? color : '#1f2937', boxShadow: on ? `0 0 12px ${color}` : 'none' }}
      />
      <span>{label}</span>
    </div>
  );
}

// ------------------------------------------------------------------ 2.5D tank renderer
function drawAquarium(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, s: Sim, p: HardwarePacket | null, tankMm: number, sensor: UltrasonicKind) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(148,163,184,0.18)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const x0 = W * 0.2;
  const x1 = W * 0.66;
  const top = H * 0.24;
  const bottom = H * 0.88;
  const dx = Math.min(W * 0.05, 34);
  const dy = -Math.min(H * 0.04, 20);
  const yOf = (f: number) => bottom - (f / 100) * STANDPIPE_FULL_BORE_FRACTION * (bottom - top);
  const pct = p ? Math.min(p.capacityPct, 127) : s.level;
  const alarm = pct >= ALARM_PCT;
  const blinkK = alarmBlink(t);

  // back panel
  ctx.fillStyle = 'rgba(186,230,253,0.18)';
  ctx.fillRect(x0 + dx, top + dy, x1 - x0, bottom - top);
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + dx, top + dy, x1 - x0, bottom - top);

  // water
  const wy = yOf(s.level);
  const amp = Math.min(s.chop, 20) * 0.35 + 0.6;
  const wave = (x: number) => Math.sin(x * 0.045 + t * 3.1) * amp + Math.sin(x * 0.11 - t * 4.7) * amp * 0.5;
  const g = ctx.createLinearGradient(0, wy, 0, bottom);
  if (alarm) {
    const k = 0.35 + 0.35 * blinkK;
    g.addColorStop(0, `rgba(248,113,113,${0.75 + 0.2 * k})`);
    g.addColorStop(1, 'rgba(185,28,28,0.9)');
  } else {
    g.addColorStop(0, 'rgba(56,189,248,0.85)');
    g.addColorStop(1, 'rgba(14,116,144,0.95)');
  }
  if (s.level > 0.2) {
    // top surface (2.5D)
    ctx.fillStyle = alarm ? 'rgba(252,165,165,0.85)' : 'rgba(125,211,252,0.8)';
    ctx.beginPath();
    ctx.moveTo(x0, wy + wave(x0));
    for (let x = x0; x <= x1; x += 6) ctx.lineTo(x, wy + wave(x));
    ctx.lineTo(x1 + dx, wy + dy + wave(x1));
    for (let x = x1; x >= x0; x -= 6) ctx.lineTo(x + dx, wy + dy + wave(x + 9));
    ctx.closePath();
    ctx.fill();
    // front body
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, bottom);
    ctx.lineTo(x0, wy + wave(x0));
    for (let x = x0; x <= x1; x += 6) ctx.lineTo(x, wy + wave(x));
    ctx.lineTo(x1, bottom);
    ctx.closePath();
    ctx.fill();
    // side
    ctx.fillStyle = alarm ? 'rgba(153,27,27,0.55)' : 'rgba(8,145,178,0.45)';
    ctx.beginPath();
    ctx.moveTo(x1, wy + wave(x1));
    ctx.lineTo(x1 + dx, wy + dy + wave(x1));
    ctx.lineTo(x1 + dx, bottom + dy);
    ctx.lineTo(x1, bottom);
    ctx.closePath();
    ctx.fill();
  }

  // glass front + edges
  ctx.strokeStyle = alarm ? `rgba(220,38,38,${0.6 + 0.4 * blinkK})` : '#334155';
  ctx.lineWidth = alarm ? 4 : 2.5;
  ctx.strokeRect(x0, top, x1 - x0, bottom - top);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#334155';
  for (const [ax, ay] of [
    [x0, top],
    [x1, top],
    [x1, bottom],
  ]) {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + dx, ay + dy);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x0 + 8, top + 6, 10, bottom - top - 12);

  // graduations
  ctx.font = '600 11px ui-sans-serif, system-ui';
  ctx.textBaseline = 'middle';
  for (const m of TANK_MARKS) {
    const y = yOf(m.pct);
    const c = m.pct >= ALARM_PCT ? '#b91c1c' : m.pct >= ELEVATED_PCT ? '#b45309' : '#0f172a';
    ctx.strokeStyle = c;
    ctx.lineWidth = m.pct === ALARM_PCT ? 2 : 1.2;
    ctx.setLineDash(m.pct === ALARM_PCT ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1 + 14, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c;
    ctx.fillText(m.label, x1 + dx + 18, y);
  }

  // sensor rig: bracket, ultrasonic module (HC-SR04: twin transducers; A02YYUW: sealed probe), DS18B20
  const cx = (x0 + x1) / 2 + dx / 2;
  const sy = top - 10;
  ctx.fillStyle = '#475569';
  ctx.fillRect(x0 - 10, sy - 26, x1 - x0 + dx + 20, 7);
  if (sensor === 'HC-SR04') {
    ctx.fillStyle = '#1d4ed8';
    ctx.fillRect(cx - 32, sy - 19, 64, 17);
    for (const ox of [-17, 17]) {
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.arc(cx + ox, sy - 2, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.arc(cx + ox, sy - 2, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 8px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('HC-SR04', cx, sy - 12);
  } else {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(cx - 24, sy - 19, 48, 19);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('A02YYUW', cx, sy - 9);
  }
  ctx.textAlign = 'left';
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + 40, sy - 19);
  ctx.lineTo(cx + 40, sy + 28);
  ctx.stroke();
  ctx.fillStyle = '#64748b';
  ctx.beginPath();
  ctx.arc(cx + 40, sy + 31, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#334155';
  ctx.font = '600 10px ui-sans-serif, system-ui';
  ctx.fillText(`DS18B20 ${p ? p.tempC.toFixed(1) : '24.0'} °C`, cx + 48, sy + 30);
  ctx.fillText(sensor === 'HC-SR04' ? 'HC-SR04 ultrasonic (TRIG / ECHO)' : 'A02YYUW ultrasonic transducer', cx + 32, sy - 33);

  // blind zone (3 cm under the face) + acoustic arcs
  const pxPerMm = (bottom - top) / tankMm;
  const face = top;
  ctx.fillStyle = 'rgba(220,38,38,0.14)';
  ctx.fillRect(cx - 30, face, 60, BLIND_MM[sensor] * pxPerMm);
  ctx.fillStyle = '#b91c1c';
  ctx.font = '700 10px ui-sans-serif, system-ui';
  ctx.fillText(`${BLIND_MM[sensor] / 10} cm Blind Zone`, x0 - 92, face + (BLIND_MM[sensor] * pxPerMm) / 2);
  const target = s.level > 0.2 ? wy : bottom;
  for (let k = 0; k < 4; k++) {
    const f = (t * 0.9 + k / 4) % 1;
    const y = face + f * (target - face);
    ctx.strokeStyle = `rgba(14,165,233,${0.75 * (1 - f)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, y, 12 + f * 30, 4 + f * 6, 0, 0, Math.PI);
    ctx.stroke();
  }
  const gap = p?.distanceMm ?? tankMm * (1 - (s.level / 100) * STANDPIPE_FULL_BORE_FRACTION);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x0 - 18, face);
  ctx.lineTo(x0 - 18, target);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#0f172a';
  ctx.font = '800 11px ui-monospace, monospace';
  ctx.fillText(`${gap.toFixed(0)} mm`, x0 - 86, (face + target) / 2 + 12);
  ctx.fillText(`${(gap / 10).toFixed(1)} cm`, x0 - 86, (face + target) / 2 + 26);

  // pitcher + pour stream
  const pouring = s.holding || s.pourRemaining > 0;
  const px = x0 + (x1 - x0) * 0.22;
  ctx.save();
  ctx.translate(px - 40, top - 70);
  ctx.rotate(pouring ? 0.55 : 0.1);
  ctx.fillStyle = '#e0f2fe';
  ctx.strokeStyle = '#0369a1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-18, -22);
  ctx.lineTo(18, -22);
  ctx.lineTo(22, 22);
  ctx.lineTo(-22, 22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(18, -16);
  ctx.lineTo(32, -24);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#0369a1';
  ctx.font = '700 10px ui-sans-serif, system-ui';
  ctx.fillText(pouring ? 'Inflow hose / pitcher: POURING' : 'Inflow hose / pitcher', px - 70, top - 104);
  if (pouring) {
    ctx.strokeStyle = 'rgba(14,165,233,0.85)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(px - 18, top - 86);
    ctx.quadraticCurveTo(px + 6, top - 40, px + 10 + Math.sin(t * 20) * 2, (s.level > 0.2 ? wy : bottom) - 2);
    ctx.stroke();
    for (let k = 0; k < 8; k++) {
      const a = (t * 6 + k * 0.9) % (Math.PI * 2);
      ctx.fillStyle = 'rgba(14,165,233,0.7)';
      ctx.beginPath();
      ctx.arc(px + 10 + Math.cos(a) * 18, (s.level > 0.2 ? wy : bottom) - Math.abs(Math.sin(a)) * 14, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // drain valve + outflow
  const vy = bottom - 34;
  ctx.fillStyle = '#64748b';
  ctx.fillRect(x1, vy - 6, 70, 12);
  ctx.save();
  ctx.translate(x1 + 46, vy);
  ctx.rotate(s.draining ? t * 4 : 0);
  ctx.strokeStyle = s.draining ? '#dc2626' : '#0f172a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.moveTo(-11, 0);
  ctx.lineTo(11, 0);
  ctx.moveTo(0, -11);
  ctx.lineTo(0, 11);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = s.draining ? '#b91c1c' : '#0f172a';
  ctx.font = '700 10px ui-sans-serif, system-ui';
  ctx.fillText(s.draining ? 'Drain valve OPEN' : 'Drain valve', x1 + 24, vy - 18);
  if (s.draining && s.level > 0.2) {
    ctx.strokeStyle = 'rgba(14,165,233,0.8)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x1 + 70, vy);
    ctx.quadraticCurveTo(x1 + 92, vy + 6, x1 + 96, H - 6);
    ctx.stroke();
  }

  ctx.fillStyle = '#475569';
  ctx.font = '600 10px ui-sans-serif, system-ui';
  ctx.fillText(`Aquarium / demo drainage tank · sensor ${tankMm} mm above the floor · 100 % = 74 % of that (bench standpipe scale)`, 12, H - 10);
}
