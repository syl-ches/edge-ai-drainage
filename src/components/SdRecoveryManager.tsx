// BLACK-BOX SD TELEMETRY & OFFLINE RECOVERY panel (Phase 9C).
// Three steps: cut the link (the node keeps logging 4-byte frames), restore it and burst-sync the
// black box (DUMP_SD_LOG over Web Serial when a board is attached, else this browser's fail-safe
// copy), then backfill the hydrograph gap. Works with or without hardware.
import { memo, useEffect, useRef, useState } from 'react';
import { Check, CloudOff, Database, HardDrive, RadioTower, ShieldCheck, Waves, X } from 'lucide-react';
import type { TwinState } from '../utils/lutInterpolator';
import type { UsbRig } from '../live/useUsbRig';
import type { TelemetryDatabase } from '../utils/telemetryDatabase';
import {
  assembleDump,
  bufferFrame,
  completeBackfill,
  initialRecovery,
  parseDumpLine,
  restoreLink,
  startBlackout,
  verifiedFrames,
  type DumpLine,
  type RecoveryState,
  type StorageTier,
} from '../utils/sdRecovery';
import { crc8Frame } from '../utils/telemetryDatabase';

interface Props {
  db: TelemetryDatabase | null;
  state: TwinState;
  usb: UsbRig;
  nodes: string[];
  /** cut / restore the live cloud stream in the App (backend POSTs + DB mirror) */
  onBlackout(active: boolean): void;
  /** the gap is backfilled: the hydrograph reloads and highlights the window */
  onBackfilled(node: string, window: [string, string]): void;
  dbEngine: string;
}

const TIER_LABEL: Record<StorageTier, string> = {
  SPI_SD: 'SPI microSD (FAT32) + internal flash mirror',
  FLASH_FAILSAFE: 'Internal flash / EEPROM ring (SD unavailable)',
  SOFTWARE_FAILSAFE: 'Browser fail-safe copy (no board attached)',
};

function SdRecoveryManagerImpl({ db, state, usb, nodes, onBlackout, onBackfilled, dbEngine }: Props) {
  const [node, setNode] = useState(nodes.includes('EN-07') ? 'EN-07' : nodes[0]);
  const [rs, setRs] = useState<RecoveryState>(() => initialRecovery(node));
  const [boardTier, setBoardTier] = useState<StorageTier | null>(null);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ state, node });
  latest.current = { state, node };
  const dumpLines = useRef<DumpLine[]>([]);

  // Board status lines (SD_STATUS:...) and any DUMP_SD_LOG burst.
  useEffect(
    () =>
      usb.onLine((line) => {
        const d = parseDumpLine(line);
        if (!d) return;
        if (d.kind === 'status') setBoardTier(d.tier);
        else dumpLines.current.push(d);
      }),
    [usb],
  );

  // While blacked out the node keeps logging one frame per second.
  useEffect(() => {
    if (rs.phase !== 'BLACKOUT') return;
    const id = window.setInterval(() => {
      const S = latest.current.state.sensors.find((s) => s.id === latest.current.node);
      if (S) setRs((r) => bufferFrame(r, { timestamp_utc: new Date().toISOString(), payload_hex: S.payloadHex }));
    }, 1000);
    return () => window.clearInterval(id);
  }, [rs.phase]);

  // Waterfall reveal of the synced frames.
  useEffect(() => {
    if (rs.phase !== 'SYNCING' && rs.phase !== 'BACKFILLED') return;
    if (shown >= rs.syncFrames.length) return;
    const id = window.setTimeout(() => setShown((n) => Math.min(n + Math.max(2, Math.ceil(rs.syncFrames.length / 30)), rs.syncFrames.length)), 45);
    return () => window.clearTimeout(id);
  }, [rs.phase, rs.syncFrames.length, shown]);

  const blackout = () => {
    setShown(0);
    setRs((r) => startBlackout({ ...r, node }, new Date().toISOString()));
    onBlackout(true);
  };

  const restore = async () => {
    setBusy(true);
    let dump = null;
    if (usb.status === 'connected') {
      dumpLines.current = [];
      if (await usb.send('DUMP_SD_LOG')) {
        const t0 = Date.now();
        while (Date.now() - t0 < 3000 && !dumpLines.current.some((l) => l.kind === 'end')) await new Promise((r) => setTimeout(r, 100));
        dump = assembleDump(dumpLines.current, Date.now());
      }
    }
    onBlackout(false);
    const next = restoreLink(rs, new Date().toISOString(), dump);
    setShown(0);
    setRs(next);
    if (db) {
      const batchId = `SD-${next.node}-${Date.now()}`;
      const res = await db.sdBackfill(next.node, next.syncFrames.map((f) => ({ timestamp_utc: f.timestamp_utc, payload_hex: f.payload_hex })), next.crc32, batchId);
      setRs((r) => completeBackfill(r, { inserted: res.frames_recovered, duplicates: res.duplicates, status: res.integrity_crc_status, synced: res.synced }));
    }
    setBusy(false);
  };

  const backfill = () => {
    if (rs.phase !== 'BACKFILLED' || !rs.syncFrames.length) return;
    onBackfilled(rs.node, [rs.syncFrames[0].timestamp_utc, rs.syncFrames.at(-1)!.timestamp_utc]);
  };

  const tier: StorageTier = rs.source === 'SERIAL' ? rs.tier : usb.status === 'connected' && boardTier ? boardTier : rs.source === 'SOFTWARE' ? 'SOFTWARE_FAILSAFE' : (boardTier ?? 'SOFTWARE_FAILSAFE');
  const waterfall = rs.syncFrames.slice(Math.max(0, shown - 14), shown);
  const ok = verifiedFrames(rs.syncFrames.slice(0, shown));
  return (
    <section className="sh-card rounded-md p-3" aria-label="Black-box SD telemetry and offline recovery" data-testid="sd-recovery">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="sh-title flex items-center gap-1.5">
          <HardDrive size={14} strokeWidth={1.5} /> Black-box SD telemetry &amp; offline recovery
        </h2>
        <select aria-label="Black-box node" value={node} onChange={(e) => setNode(e.target.value)} disabled={rs.phase === 'BLACKOUT' || busy} className="sh-input sh-mono rounded-md px-2 py-1 text-[11px]">
          {nodes.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5 text-[11px] sm:grid-cols-3">
        {(
          [
            ['Edge storage media', TIER_LABEL[tier]],
            ['Frame compression', '32-bit (4-byte hex) · 96 % smaller than JSON'],
            ['Database engine', dbEngine],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="sh-panel rounded-md px-2 py-1.5">
            <div className="sh-label !text-[9.5px]">{k}</div>
            <div className="sh-ink font-medium">{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 grid gap-1.5 sm:grid-cols-3">
        <button onClick={blackout} disabled={rs.phase === 'BLACKOUT' || busy} className={`sh-btn flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11.5px] font-semibold ${rs.phase === 'BLACKOUT' ? 'sh-on' : ''}`}>
          <CloudOff size={14} strokeWidth={1.5} /> 1. Simulate Typhoon Comms Blackout
        </button>
        <button onClick={() => void restore()} disabled={rs.phase !== 'BLACKOUT' || busy} className="sh-btn flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11.5px] font-semibold">
          <RadioTower size={14} strokeWidth={1.5} /> 2. Restore Link &amp; Trigger SD Burst Sync
        </button>
        <button onClick={backfill} disabled={rs.phase !== 'BACKFILLED'} className="sh-btn flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11.5px] font-semibold">
          <Waves size={14} strokeWidth={1.5} /> 3. Backfill Hydrograph Gap
        </button>
      </div>
      <div className="sh-mono mt-2.5 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
        <div>
          <span className="sh-label block !text-[9.5px]">Phase</span>
          <span className="sh-ink">{rs.phase}</span>
        </div>
        <div>
          <span className="sh-label block !text-[9.5px]">Buffered offline frames</span>
          <span className="sh-ink">{rs.buffered.length}</span>
        </div>
        <div>
          <span className="sh-label block !text-[9.5px]">Burst source</span>
          <span className="sh-ink">{rs.source === 'SERIAL' ? 'Board DUMP_SD_LOG' : rs.source === 'SOFTWARE' ? 'Browser fail-safe' : '—'}</span>
        </div>
        <div>
          <span className="sh-label block !text-[9.5px]">CRC-32 / batch</span>
          <span className="sh-ink">
            {rs.crc32 ?? '—'} {rs.result ? `· ${rs.result.status}` : ''}
          </span>
        </div>
      </div>
      {(rs.phase === 'SYNCING' || rs.phase === 'BACKFILLED') && (
        <div className="sh-mono mt-2 rounded-md bg-[#020617] px-2 py-1.5 text-[10.5px] leading-snug text-[#a7f3d0]" aria-label="SD burst waterfall">
          {waterfall.map((f) => (
            <div key={`${f.seq}-${f.timestamp_utc}`} className="flex items-center gap-2">
              <span className="text-[#64748b]">{f.timestamp_utc.slice(11, 19)}</span>
              <span className="text-[#f8fafc]">{f.payload_hex}</span>
              <span>CRC8 0x{f.crc8.toString(16).toUpperCase().padStart(2, '0')}</span>
              {crc8Frame(f.payload_hex) === f.crc8 ? <Check size={11} strokeWidth={2} className="text-[#34d399]" /> : <X size={11} strokeWidth={2} className="text-[#f87171]" />}
            </div>
          ))}
          <div className="mt-1 text-[#94a3b8]">
            {shown} / {rs.syncFrames.length} frames streamed · {ok} CRC-verified
          </div>
        </div>
      )}
      {rs.result && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px]">
          {rs.result.status === 'FAIL' ? <X size={13} strokeWidth={1.5} className="mt-0.5 text-[#dc2626]" /> : <ShieldCheck size={13} strokeWidth={1.5} className="mt-0.5 text-[#059669]" />}
          <span>
            {rs.result.status === 'FAIL'
              ? 'Batch CRC-32 mismatch: frames rejected, nothing written.'
              : `${rs.result.inserted} frames written with sd_recovered_flag (${rs.result.duplicates} duplicates skipped) · ${rs.result.synced ? 'mirrored to the SQLite backend' : 'stored in IndexedDB (backend offline)'}. No frame logged during the simulated blackout was lost.`}
          </span>
        </div>
      )}
      <div className="sh-muted mt-2 flex items-center gap-1 text-[10.5px]">
        <Database size={11} strokeWidth={1.5} />
        {usb.status === 'connected' ? `Board on Web Serial (${usb.label ?? 'USB'}): step 2 sends DUMP_SD_LOG.` : 'No board attached: the browser buffers the frames and replays them (software fail-safe).'}
      </div>
    </section>
  );
}

export const SdRecoveryManager = memo(SdRecoveryManagerImpl);
