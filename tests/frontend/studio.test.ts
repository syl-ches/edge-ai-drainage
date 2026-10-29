// Ultra-HD Pitch Studio: tank physics, acoustic bounce scheduler, scene mappings and the
// studio -> edge pipeline -> map alarm chain.
import { describe, expect, it } from 'vitest';
import { MAX_FILL_PCT, POUR_SURGE_PCT, STUDIO_PRESETS, TankSim, studioWaterTone } from '../../src/studio/tankSim';
import { AcousticBouncer, SOUND_MM_PER_US, timeOfFlightUs } from '../../src/studio/acoustic';
import { CUT, cutawayWaterY } from '../../src/studio/cutaway';
import { TANK_SENSOR_M, benchWaterHeight } from '../../src/studio/bench';
import { HardwareRig } from '../../src/live/serialRig';
import type { HardwarePacket } from '../../src/live/hardwareSync';
import { hardwareBannerText } from '../../src/components/HardwareAlertBanner';
import { STUDIO_CAMERAS, studioPixelRatio } from '../../src/components/UltraHdPitchStudio';
import { isHardwareSimRoute, isPitchStudioRoute } from '../../src/main.route';

const run = (sim: TankSim, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) sim.step(dt);
};

describe('TankSim', () => {
  it('a click pour adds exactly +15 % over 1.5 s with surge chop', () => {
    const s = new TankSim();
    s.setTarget(30);
    run(s, 2);
    expect(s.level).toBe(30);
    s.pour();
    expect(s.pouring).toBe(true);
    run(s, 0.5);
    expect(s.chop).toBeGreaterThan(10);
    run(s, 1.5);
    expect(s.level).toBeCloseTo(30 + POUR_SURGE_PCT, 6);
    expect(s.pouring).toBe(false);
  });

  it('holding keeps pouring until released and clamps at the max', () => {
    const s = new TankSim();
    s.hold(true);
    run(s, 20);
    expect(s.level).toBe(MAX_FILL_PCT);
    s.hold(false);
    expect(s.pouring).toBe(false);
  });

  it('drain resets to 0 % and stops', () => {
    const s = new TankSim();
    s.setTarget(105);
    run(s, 5);
    s.drain();
    run(s, 10);
    expect(s.level).toBe(0);
    expect(s.draining).toBe(false);
  });

  it('presets seek their fill; follow() mirrors a physical board', () => {
    expect(STUDIO_PRESETS.map((p) => p.fill)).toEqual([30, 60, 85, 105]);
    for (const p of STUDIO_PRESETS) {
      const s = new TankSim();
      s.setTarget(p.fill);
      run(s, 5);
      expect(s.level).toBe(p.fill);
    }
    const s = new TankSim();
    s.pour();
    s.follow(72.5);
    expect(s.level).toBe(72.5);
    expect(s.pouring).toBe(false);
  });

  it('water tone: cyan < 45, amber 45-79, crimson >= 80', () => {
    expect(studioWaterTone(0)).toBe('normal');
    expect(studioWaterTone(44.9)).toBe('normal');
    expect(studioWaterTone(45)).toBe('elevated');
    expect(studioWaterTone(79.9)).toBe('elevated');
    expect(studioWaterTone(80)).toBe('alarm');
    expect(studioWaterTone(120)).toBe('alarm');
  });
});

describe('AcousticBouncer', () => {
  it('time of flight uses 343.2 m/s round trip', () => {
    expect(SOUND_MM_PER_US).toBe(0.3432);
    expect(timeOfFlightUs(343.2)).toBeCloseTo(2000, 6);
    expect(timeOfFlightUs(-5)).toBe(0);
  });

  it('rings hit the water, echo back up and are received', () => {
    const b = new AcousticBouncer(2);
    let hits = 0;
    let received = 0;
    let emitted = 0;
    for (let i = 0; i < 600; i++) {
      const ev = b.update(1 / 60, 1, 0);
      emitted += ev.emitted;
      hits += ev.hits;
      received += ev.received;
    }
    expect(emitted).toBeGreaterThan(5);
    expect(hits).toBeGreaterThanOrEqual(received);
    expect(received).toBeGreaterThan(0);
    expect(b.received).toBe(received);
    expect(b.rings.every((r) => r.y >= 0 && r.y <= 1)).toBe(true);
    expect(b.rings.length).toBeLessThanOrEqual(b.maxRings);
  });

  it('the bounce rate speeds up as the air gap shrinks', () => {
    const b = new AcousticBouncer(2);
    expect(b.interval(0.2)).toBeLessThan(b.interval(0.6));
    expect(b.interval(0.001)).toBe(b.minInterval);
    expect(b.interval(100)).toBe(b.maxInterval);
    const count = (gap: number) => {
      const x = new AcousticBouncer(2);
      let n = 0;
      for (let i = 0; i < 600; i++) n += x.update(1 / 60, gap, 0).received;
      return n;
    };
    expect(count(0.3)).toBeGreaterThan(count(1.2));
  });
});

describe('scene mappings', () => {
  it('cutaway: 0 % = culvert invert, 100 % = crown, surcharge climbs the shaft below the sensor', () => {
    expect(cutawayWaterY(0)).toBe(CUT.culvert.invert);
    expect(cutawayWaterY(100)).toBeCloseTo(CUT.culvert.invert + CUT.culvert.rise, 9);
    expect(cutawayWaterY(110)).toBeGreaterThan(cutawayWaterY(100));
    expect(cutawayWaterY(120)).toBeLessThan(CUT.sensorY);
  });

  it('bench: 100 % = 74 % of the sensor height (standpipe convention)', () => {
    expect(benchWaterHeight(0)).toBe(0);
    expect(benchWaterHeight(100)).toBeCloseTo(0.74 * TANK_SENSOR_M, 9);
    expect(benchWaterHeight(50)).toBeCloseTo(0.37 * TANK_SENSOR_M, 9);
  });

  it('pixel ratio: x1.5 by default, x2 supersampled, capped at 3', () => {
    expect(studioPixelRatio(1, false)).toBe(1.5);
    expect(studioPixelRatio(1, true)).toBe(2);
    expect(studioPixelRatio(2, false)).toBe(3);
    expect(studioPixelRatio(2, true)).toBe(3);
  });

  it('has the five camera presets', () => {
    expect(STUDIO_CAMERAS.map((c) => c.id)).toEqual(['iso', 'sensor', 'street', 'culvert', 'bench']);
  });

  it('routes /?view=pitch-studio and /pitch-studio', () => {
    expect(isPitchStudioRoute({ search: '?view=pitch-studio', pathname: '/' })).toBe(true);
    expect(isPitchStudioRoute({ search: '', pathname: '/pitch-studio' })).toBe(true);
    expect(isPitchStudioRoute({ search: '?view=hardware-sim', pathname: '/' })).toBe(false);
    expect(isHardwareSimRoute({ search: '?view=pitch-studio', pathname: '/' })).toBe(false);
  });
});

describe('studio -> edge pipeline -> map alarm', () => {
  const rig = () =>
    new HardwareRig({ sensorId: 'EN-08', deviceEui: '02BA6C1000000008', fullScaleM: 2.0, tankHeightMm: 300, scope: 'single_node', origin: 'AQUARIUM_SIM' });
  const drive = (sim: TankSim, r: HardwareRig, seconds: number, t0: number): HardwarePacket[] => {
    const out: HardwarePacket[] = [];
    for (let k = 0; k < seconds * 5; k++) {
      run(sim, 0.2);
      out.push(r.ingestBurst(sim.burst(r), t0 + k * 200));
    }
    return out;
  };

  it('the Critical 85 % preset trips the red alarm banner', () => {
    const s = new TankSim();
    const r = rig();
    s.setTarget(85);
    const ps = drive(s, r, 20, 0);
    const last = ps[ps.length - 1];
    expect(last.fillPct).toBeGreaterThan(80);
    expect(last.capacityPct).toBeGreaterThanOrEqual(80);
    const banner = hardwareBannerText(last);
    expect(banner.alarm).toBe(true);
    expect(banner.text).toBe(`🔴 LIVE SENSOR ALERT — EN-08 AT ${Math.round(last.capacityPct)}% CAPACITY`);
  });

  it('a pour surge from a steady 30 % raises FLASH_SURGE', () => {
    const s = new TankSim();
    const r = rig();
    s.setTarget(30);
    const steady = drive(s, r, 15, 0);
    expect(steady[steady.length - 1].anomaly).toBe('NORMAL');
    s.pour();
    const surge = drive(s, r, 3, 15_000);
    expect(surge.some((p) => p.anomaly === 'FLASH_SURGE')).toBe(true);
  });
});
