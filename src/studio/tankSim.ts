// Shared water-level physics for the Ultra-HD Pitch Studio (cutaway diorama + aquarium bench):
// fill % (0..120, bench scale: 100 % = 74 % of the sensor height) driven by pouring, holding,
// draining, slider / preset seeking, plus surface chop that feeds the virtual ultrasonic burst.
import type { HardwareRig } from '../live/serialRig';

export const MAX_FILL_PCT = 120;
export const POUR_SURGE_PCT = 15;
export const POUR_RATE_PCT_S = 10; // +15 % over 1.5 s: long enough for the Kalman to flag FLASH_SURGE
export const HOLD_RATE_PCT_S = 12;
export const DRAIN_RATE_PCT_S = 15;
export const SEEK_RATE_PCT_S = 30;
export const SURGE_CHOP_MM = 16;
export const BASE_CHOP_MM = 1.5;
export const FLAT_CHOP_MM = 0.6;

export const STUDIO_PRESETS = [
  { id: 'normal', label: 'Normal 30%', fill: 30, flat: false },
  { id: 'elevated', label: 'Elevated 60%', fill: 60, flat: false },
  { id: 'critical', label: 'Critical 85% [Trigger Red Blink]', fill: 85, flat: false },
  { id: 'overflow', label: 'Overflow 105%', fill: 105, flat: false },
] as const;

export class TankSim {
  level = 0;
  target: number | null = null;
  pourRemaining = 0;
  holding = false;
  draining = false;
  chop = BASE_CHOP_MM;
  flat = false;
  private seed = 20240917;

  get pouring(): boolean {
    return this.holding || this.pourRemaining > 0;
  }

  setTarget(v: number, flat = false): void {
    this.target = Math.min(Math.max(v, 0), MAX_FILL_PCT);
    this.flat = flat;
    this.draining = false;
    this.pourRemaining = 0;
  }

  pour(): void {
    this.pourRemaining += POUR_SURGE_PCT;
    this.target = null;
    this.flat = false;
    this.draining = false;
  }

  hold(on: boolean): void {
    this.holding = on;
    if (on) {
      this.target = null;
      this.flat = false;
      this.draining = false;
    }
  }

  drain(): void {
    this.draining = true;
    this.target = null;
    this.pourRemaining = 0;
    this.flat = false;
  }

  /** Follow a measured fill (physical USB board drives the virtual tank). */
  follow(fillPct: number): void {
    this.level = Math.min(Math.max(fillPct, 0), MAX_FILL_PCT);
    this.target = null;
    this.pourRemaining = 0;
    this.draining = false;
  }

  step(dt: number): void {
    if (this.holding) {
      this.level += HOLD_RATE_PCT_S * dt;
      this.chop = Math.max(this.chop, SURGE_CHOP_MM);
    }
    if (this.pourRemaining > 0) {
      const d = Math.min(POUR_RATE_PCT_S * dt, this.pourRemaining);
      this.level += d;
      this.pourRemaining -= d;
      this.chop = Math.max(this.chop, SURGE_CHOP_MM);
    }
    if (this.draining) {
      this.level -= DRAIN_RATE_PCT_S * dt;
      this.chop = Math.max(this.chop, 3);
      if (this.level <= 0) {
        this.level = 0;
        this.draining = false;
      }
    }
    if (this.target !== null) {
      const s = SEEK_RATE_PCT_S * dt;
      if (Math.abs(this.target - this.level) <= s) {
        this.level = this.target;
        this.target = null;
      } else this.level += Math.sign(this.target - this.level) * s;
    }
    this.level = Math.min(Math.max(this.level, 0), MAX_FILL_PCT);
    const base = this.flat ? FLAT_CHOP_MM : BASE_CHOP_MM;
    this.chop += (base - this.chop) * (1 - Math.exp(-dt / 1.2));
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return this.seed / 2 ** 32;
  }
  private gauss(): number {
    const u = Math.max(this.rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rnd());
  }

  /** 10-sample virtual ultrasonic burst of the current surface (chop + splash echoes). */
  burst(rig: HardwareRig): number[] {
    const d = rig.distanceForFill(this.level);
    return Array.from({ length: 10 }, () => {
      let x = d + this.gauss() * this.chop;
      if (this.chop > 8 && this.rnd() < 0.12) x -= 40 + this.rnd() * 40;
      return Math.round(Math.max(x, 5) * 10) / 10;
    });
  }
}

/** Water colour of the studio volumes: cyan < 45 %, amber 45-79 %, crimson (3 Hz pulse) >= 80 %. */
export const STUDIO_WATER = {
  normal: ['#06B6D4', '#22D3EE'],
  elevated: ['#F59E0B', '#FBBF24'],
  alarm: ['#EF4444', '#FCA5A5'],
} as const;

export function studioWaterTone(fillPct: number): keyof typeof STUDIO_WATER {
  return fillPct >= 80 ? 'alarm' : fillPct >= 45 ? 'elevated' : 'normal';
}
