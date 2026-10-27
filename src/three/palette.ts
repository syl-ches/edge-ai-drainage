import { Color } from 'three';
import type { AnomalyClass, ConduitStatus } from '../types/twin';
import type { Theme } from './theme';

export interface CapacityBand {
  max: number;
  color: string;
  /** second stop for gradient bands (daylight ramp blends within a band) */
  to?: string;
  label: string;
  name: string;
}

/** Daylight: white/green-harmonised ramp (emerald→cyan, lime→amber, orange, pulsing crimson). */
export const DAY_BANDS: CapacityBand[] = [
  { max: 0.45, color: '#10B981', to: '#06B6D4', label: '0–45%', name: 'Normal flow' },
  { max: 0.75, color: '#84CC16', to: '#F59E0B', label: '45–75%', name: 'Elevated' },
  { max: 0.94, color: '#F97316', label: '75–94%', name: 'High / near peak' },
  { max: Infinity, color: '#EF4444', label: '>94%', name: 'Surcharged' },
];

/** X-ray: the original obsidian ramp (CLAUDE.md §11). */
export const XRAY_BANDS: CapacityBand[] = [
  { max: 0.4, color: '#12B5CB', label: '0–40%', name: 'Normal flow' },
  { max: 0.75, color: '#FCC934', label: '40–75%', name: 'Elevated' },
  { max: 0.94, color: '#FA903E', label: '75–94%', name: 'Critical' },
  { max: Infinity, color: '#F538A0', label: '>94%', name: 'Surcharged' },
];

/** Back-compat alias (legend / tests): the X-ray ramp. */
export const CAPACITY_BANDS = XRAY_BANDS;

export function bandsFor(theme: Theme): CapacityBand[] {
  return theme === 'daylight' ? DAY_BANDS : XRAY_BANDS;
}

function lerpHex(a: string, b: string, t: number): string {
  return `#${new Color(a).lerp(new Color(b), Math.min(Math.max(t, 0), 1)).getHexString()}`;
}

/** Ramp colour for a capacity ratio (0..1.27) in the given theme. */
export function capacityColor(ratio: number, theme: Theme = 'xray'): string {
  const bands = bandsFor(theme);
  let lo = 0;
  for (const b of bands) {
    if (ratio <= b.max) {
      if (!b.to || !Number.isFinite(b.max)) return b.color;
      return lerpHex(b.color, b.to, (ratio - lo) / (b.max - lo));
    }
    lo = b.max;
  }
  return bands[bands.length - 1].color;
}

export const STATUS_CODE: Record<ConduitStatus, number> = {
  NORMAL: 0,
  ELEVATED: 1,
  CRITICAL: 2,
  SURCHARGED: 3,
};

/** Mid-tone anomaly colours: legible on both the white diorama and the obsidian X-ray. */
export const ANOMALY_COLORS: Record<AnomalyClass, string> = {
  NORMAL: '#16A34A',
  FLASH_SURGE: '#EA580C',
  TRASH_BLOCKAGE: '#9333EA',
  SUPERCRITICAL: '#2563EB',
  SURCHARGED: '#E11D48',
  SENSOR_FAULT: '#64748B',
  LOW_BATTERY: '#CA8A04',
};

/** Trash-rack bar colour: steel -> amber -> red as visual blockage grows. */
export function rackColor(blockagePct: number, out = new Color()): Color {
  const steel = new Color('#94A3B8');
  const amber = new Color('#F59E0B');
  const red = new Color('#EF4444');
  const t = Math.min(Math.max(blockagePct / 100, 0), 1);
  return t < 0.5 ? out.copy(steel).lerp(amber, t / 0.5) : out.copy(amber).lerp(red, (t - 0.5) / 0.5);
}
