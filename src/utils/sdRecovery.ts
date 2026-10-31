// Black-box SD telemetry & offline recovery workflow (Phase 9C), pure and deterministic.
//
//   IDLE -> BLACKOUT (cloud / LoRaWAN link cut; the node keeps logging 4-byte frames to its black box)
//        -> SYNCING  (link restored: DUMP_SD_LOG over Web Serial, or the software fail-safe replays the
//                     frames this browser buffered when no board is attached)
//        -> BACKFILLED (frames CRC-checked and inserted with sd_recovered_flag; the hydrograph gap fills)
//
// Storage tiers reported by the board: SPI microSD (SD_STATUS:OK_SPI_CARD) or the internal flash /
// EEPROM ring buffer (SD_STATUS:OK_FLASH_FAILSAFE). With no board attached the browser itself is the
// third tier (SOFTWARE_FAILSAFE). Firmware dump format (firmware/universal_hcsr04_node):
//   [SD_DUMP] {"i":0,"seq":812,"t_ms":5123456,"hex":"0x54C1672A"}
//   [SD_DUMP_END] {"frames":42,"crc32":"1A2B3C4D","tier":"SPI_SD"}
import { crc32Frames, crc8Frame, normaliseHex } from './telemetryDatabase';

export type RecoveryPhase = 'IDLE' | 'BLACKOUT' | 'SYNCING' | 'BACKFILLED';
export type StorageTier = 'SPI_SD' | 'FLASH_FAILSAFE' | 'SOFTWARE_FAILSAFE';

export interface BlackboxFrame {
  seq: number;
  timestamp_utc: string;
  payload_hex: string;
  crc8: number;
}

export interface RecoveryState {
  phase: RecoveryPhase;
  node: string;
  tier: StorageTier;
  buffered: BlackboxFrame[];
  blackoutStart: string | null;
  blackoutEnd: string | null;
  /** frames being / been synced (serial dump or the buffered copy) */
  syncFrames: BlackboxFrame[];
  crc32: string | null;
  source: 'SERIAL' | 'SOFTWARE' | null;
  result: { inserted: number; duplicates: number; status: string; synced: boolean } | null;
}

export function initialRecovery(node: string, tier: StorageTier = 'SOFTWARE_FAILSAFE'): RecoveryState {
  return { phase: 'IDLE', node, tier, buffered: [], blackoutStart: null, blackoutEnd: null, syncFrames: [], crc32: null, source: null, result: null };
}

export function startBlackout(s: RecoveryState, nowIso: string): RecoveryState {
  if (s.phase === 'BLACKOUT' || s.phase === 'SYNCING') return s;
  return { ...initialRecovery(s.node, s.tier), phase: 'BLACKOUT', blackoutStart: nowIso };
}

/** A frame the node logged while the link was down (ignored outside a blackout). */
export function bufferFrame(s: RecoveryState, f: { timestamp_utc: string; payload_hex: string }): RecoveryState {
  if (s.phase !== 'BLACKOUT') return s;
  const hex = normaliseHex(f.payload_hex);
  const frame: BlackboxFrame = { seq: s.buffered.length, timestamp_utc: f.timestamp_utc, payload_hex: hex, crc8: crc8Frame(hex) };
  return { ...s, buffered: [...s.buffered, frame] };
}

export interface SerialDump {
  frames: BlackboxFrame[];
  crc32: string | null;
  tier: StorageTier;
}

/** Restores the link and starts the burst sync: the board's dump when one arrived, else the software copy. */
export function restoreLink(s: RecoveryState, nowIso: string, dump: SerialDump | null): RecoveryState {
  if (s.phase !== 'BLACKOUT') return s;
  const frames = dump && dump.frames.length ? dump.frames : s.buffered;
  return {
    ...s,
    phase: 'SYNCING',
    blackoutEnd: nowIso,
    tier: dump && dump.frames.length ? dump.tier : 'SOFTWARE_FAILSAFE',
    source: dump && dump.frames.length ? 'SERIAL' : 'SOFTWARE',
    syncFrames: frames,
    crc32: dump && dump.frames.length ? dump.crc32 : crc32Frames(frames.map((f) => f.payload_hex)),
  };
}

export function completeBackfill(s: RecoveryState, result: NonNullable<RecoveryState['result']>): RecoveryState {
  if (s.phase !== 'SYNCING') return s;
  return { ...s, phase: 'BACKFILLED', result };
}

/** Frames whose per-frame CRC-8 tag still matches their payload. */
export function verifiedFrames(frames: BlackboxFrame[]): number {
  return frames.filter((f) => crc8Frame(f.payload_hex) === f.crc8).length;
}

// ---------------------------------------------------------------- firmware dump lines
export type DumpLine =
  | { kind: 'status'; tier: Exclude<StorageTier, 'SOFTWARE_FAILSAFE'> }
  | { kind: 'frame'; i: number; seq: number; tMs: number; hex: string }
  | { kind: 'end'; frames: number; crc32: string; tier: Exclude<StorageTier, 'SOFTWARE_FAILSAFE'> };

export function parseDumpLine(line: string): DumpLine | null {
  const t = line.trim();
  if (t === 'SD_STATUS:OK_SPI_CARD') return { kind: 'status', tier: 'SPI_SD' };
  if (t === 'SD_STATUS:OK_FLASH_FAILSAFE') return { kind: 'status', tier: 'FLASH_FAILSAFE' };
  const m = /^\[(SD_DUMP|SD_DUMP_END)\]\s*(\{.*\})$/.exec(t);
  if (!m) return null;
  try {
    const o = JSON.parse(m[2]) as Record<string, unknown>;
    if (m[1] === 'SD_DUMP') return { kind: 'frame', i: Number(o.i), seq: Number(o.seq), tMs: Number(o.t_ms), hex: normaliseHex(String(o.hex)) };
    return { kind: 'end', frames: Number(o.frames), crc32: String(o.crc32).toUpperCase(), tier: o.tier === 'FLASH_FAILSAFE' ? 'FLASH_FAILSAFE' : 'SPI_SD' };
  } catch {
    return null;
  }
}

/**
 * Assembles a dump into timestamped frames. The board only knows millis(), so frames are placed on
 * the wall clock relative to the END marker, which arrives at `endWallMs`.
 */
export function assembleDump(lines: DumpLine[], endWallMs: number): SerialDump | null {
  const end = lines.find((l): l is Extract<DumpLine, { kind: 'end' }> => l.kind === 'end');
  const frames = lines.filter((l): l is Extract<DumpLine, { kind: 'frame' }> => l.kind === 'frame').sort((a, b) => a.i - b.i);
  if (!end || !frames.length) return null;
  const lastMs = frames[frames.length - 1].tMs;
  return {
    tier: end.tier,
    crc32: end.crc32,
    frames: frames.map((f) => ({
      seq: f.seq,
      timestamp_utc: new Date(endWallMs - (lastMs - f.tMs)).toISOString(),
      payload_hex: f.hex,
      crc8: crc8Frame(f.hex),
    })),
  };
}
