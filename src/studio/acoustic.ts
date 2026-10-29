// Bouncing ultrasonic wave scheduler for the Pitch Studio (pure, unit-tested).
// Downward rings leave the transducer, strike the live water surface (impact ring), turn into an
// upward echo ring and are "received" back at the transducer. New pings are fired every half
// round-trip (clamped), so as the water rises the path shortens and the bounce rate speeds up.
// Visual speed is scaled for legibility; the displayed time of flight uses the real speed of sound.

/** Speed of sound the A02YYUW / HC-SR04 assume: 343.2 m/s = 0.3432 mm/us. */
export const SOUND_MM_PER_US = 0.3432;

/** Round-trip time of flight for an air gap (microseconds). */
export function timeOfFlightUs(airGapMm: number): number {
  return (2 * Math.max(airGapMm, 0)) / SOUND_MM_PER_US;
}

export interface AcousticRing {
  id: number;
  /** current height (scene units) */
  y: number;
  dir: 'down' | 'up';
  /** distance travelled since emission (scene units), drives ring radius */
  travelled: number;
}

export interface AcousticImpact {
  id: number;
  y: number;
  age: number;
}

export interface AcousticEvents {
  emitted: number;
  hits: number;
  received: number;
}

export class AcousticBouncer {
  rings: AcousticRing[] = [];
  impacts: AcousticImpact[] = [];
  private nextId = 1;
  private sinceEmit = Infinity;
  /** total echoes received so far */
  received = 0;

  constructor(
    /** visual ring speed, scene units per second */
    readonly speed: number,
    readonly minInterval = 0.12,
    readonly maxInterval = 0.7,
    readonly maxRings = 10,
    readonly impactLife = 0.6,
  ) {}

  /** Seconds between pings for a given gap: half the visual round trip, clamped. */
  interval(gap: number): number {
    const roundTrip = (2 * Math.max(gap, 0)) / this.speed;
    return Math.min(Math.max(roundTrip / 2, this.minInterval), this.maxInterval);
  }

  update(dt: number, sensorY: number, waterY: number): AcousticEvents {
    const ev: AcousticEvents = { emitted: 0, hits: 0, received: 0 };
    const gap = Math.max(sensorY - waterY, 0);
    this.sinceEmit += dt;
    if (this.sinceEmit >= this.interval(gap) && this.rings.length < this.maxRings && gap > 1e-6) {
      this.sinceEmit = 0;
      this.rings.push({ id: this.nextId++, y: sensorY, dir: 'down', travelled: 0 });
      ev.emitted++;
    }
    const step = this.speed * dt;
    const keep: AcousticRing[] = [];
    for (const r of this.rings) {
      if (r.dir === 'down') {
        r.y -= step;
        r.travelled += step;
        if (r.y <= waterY) {
          // strike: impact ring on the surface, echo heads back up from the surface
          r.travelled += r.y - waterY;
          r.y = waterY;
          r.dir = 'up';
          this.impacts.push({ id: this.nextId++, y: waterY, age: 0 });
          ev.hits++;
        }
        keep.push(r);
      } else {
        r.y += step;
        r.travelled += step;
        if (r.y >= sensorY) {
          ev.received++;
          this.received++;
          continue;
        }
        keep.push(r);
      }
    }
    this.rings = keep;
    this.impacts = this.impacts.filter((i) => (i.age += dt) < this.impactLife);
    return ev;
  }
}
