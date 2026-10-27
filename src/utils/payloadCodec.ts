// 32-bit big-endian uplink codec — bit-for-bit mirror of CLAUDE.md §10 and
// pack_telemetry_payload() in scripts/generate_citycamp_twin_data.py.
//
//   [31:22] depth_code  u10  5 mm/LSB          0..5115 mm
//   [21:14] dh_dt_code  s8   1 mm/min/LSB      -128..+127
//   [13:7]  cap_code    u7   1 %/LSB           0..127 %   (Jetson: visual blockage %)
//   [6:4]   anom_code   u3   enum              0..7
//   [3:0]   vbat_code   u4   3.00 V + 0.08 V   3.00..4.20 V
//
// Encoders saturate (never wrap); rounding is round-half-up = floor(x + 0.5).

import type { AnomalyClass } from '../types/twin';

export const ANOMALY_CODES: Record<AnomalyClass, number> = {
  NORMAL: 0,
  FLASH_SURGE: 1,
  TRASH_BLOCKAGE: 2,
  SUPERCRITICAL: 3,
  SURCHARGED: 4,
  SENSOR_FAULT: 5,
  LOW_BATTERY: 6,
};
export const ANOMALY_BY_CODE: (AnomalyClass | 'RESERVED')[] = [
  'NORMAL',
  'FLASH_SURGE',
  'TRASH_BLOCKAGE',
  'SUPERCRITICAL',
  'SURCHARGED',
  'SENSOR_FAULT',
  'LOW_BATTERY',
  'RESERVED',
];

export const DEPTH_MAX_MM = 5115;
export const DHDT_MIN = -128;
export const DHDT_MAX = 127;
export const CAP_MAX_PCT = 127;

const roundHalfUp = (x: number) => Math.floor(x + 0.5);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function packTelemetryPayload(
  depthMm: number,
  dhDtMmMin: number,
  capPct: number,
  anomCode: number,
  vbatV: number,
): number {
  if (!Number.isInteger(anomCode) || anomCode < 0 || anomCode > 7) throw new RangeError('anom_code must fit in 3 bits');
  const depth = clamp(roundHalfUp(depthMm / 5), 0, 0x3ff);
  const dh = clamp(roundHalfUp(dhDtMmMin), DHDT_MIN, DHDT_MAX) & 0xff;
  const cap = clamp(roundHalfUp(capPct), 0, 0x7f);
  const vbat = clamp(roundHalfUp((vbatV - 3.0) / 0.08), 0, 0xf);
  return ((depth << 22) | (dh << 14) | (cap << 7) | (anomCode << 4) | vbat) >>> 0;
}

export interface DecodedPayload {
  depthCode: number;
  dhDtCode: number;
  capCode: number;
  anomCode: number;
  vbatCode: number;
  depthMm: number;
  dhDtMmMin: number;
  capPct: number;
  anomaly: AnomalyClass | 'RESERVED';
  vbatV: number;
}

export function unpackTelemetryPayload(word: number): DecodedPayload {
  const w = word >>> 0;
  const depthCode = (w >>> 22) & 0x3ff;
  const dhDtCode = (w >>> 14) & 0xff;
  const capCode = (w >>> 7) & 0x7f;
  const anomCode = (w >>> 4) & 0x7;
  const vbatCode = w & 0xf;
  return {
    depthCode,
    dhDtCode,
    capCode,
    anomCode,
    vbatCode,
    depthMm: depthCode * 5,
    dhDtMmMin: dhDtCode & 0x80 ? dhDtCode - 256 : dhDtCode,
    capPct: capCode,
    anomaly: ANOMALY_BY_CODE[anomCode],
    vbatV: Math.round((3.0 + vbatCode * 0.08) * 100) / 100,
  };
}

export function toHex(word: number): string {
  return `0x${(word >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function toBytesBE(word: number): string {
  const w = word >>> 0;
  return [w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

export function toBase64(word: number): string {
  const w = word >>> 0;
  return btoa(String.fromCharCode(w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff));
}

export function fromBase64(b64: string): number {
  const s = atob(b64);
  if (s.length !== 4) throw new RangeError('payload must be exactly 4 bytes');
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

/** Bit-field layout for visual breakdowns (MSB first). */
export const PAYLOAD_FIELDS = [
  { key: 'depth', label: 'depth_code', bits: [31, 22], width: 10, color: '#38BDF8', unit: '×5 mm' },
  { key: 'dhdt', label: 'dh_dt_code', bits: [21, 14], width: 8, color: '#F97316', unit: 's8 mm/min' },
  { key: 'cap', label: 'cap_code', bits: [13, 7], width: 7, color: '#FCC934', unit: '%' },
  { key: 'anom', label: 'anom_code', bits: [6, 4], width: 3, color: '#F538A0', unit: 'enum' },
  { key: 'vbat', label: 'vbat_code', bits: [3, 0], width: 4, color: '#4ADE80', unit: '+0.08 V' },
] as const;
