import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LutFile, NetworkFile } from '../../src/types/twin';
import { LutInterpolator } from '../../src/utils/lutInterpolator';
import { CAP_MAX_PCT } from '../../src/utils/payloadCodec';
import { DEFAULT_URL_STATE, parseUrlState, serializeUrlState } from '../../src/utils/urlState';
import { EN07_MAST_M, EN08_MAST_M, fullnessStatus, nodeFullnessPct, sensorGeometry, ultrasonicDistanceMm, visualBlockagePct } from '../../src/utils/fullness';
import { capacityColor } from '../../src/three/palette';

const network = JSON.parse(readFileSync('public/data/city_camp_network.json', 'utf8')) as NetworkFile;
const lut = JSON.parse(readFileSync('public/data/simulation_lut.json', 'utf8')) as LutFile;
const interp = LutInterpolator.fromFiles(network, lut);
const sensor = (id: string) => network.sensors.find((s) => s.sensor_id === id)!;

describe('urlState (theme / shader / layers / simulator deep links)', () => {
  it('defaults to the daylight diorama with every layer on', () => {
    const s = parseUrlState('');
    expect(s.theme).toBe('daylight');
    expect(s.shader).toBe(DEFAULT_URL_STATE.shader);
    expect(s.layers).toEqual({ buildings: true, vegetation: true, network: true, badges: true });
    expect(s.sim).toBeNull();
  });
  it('round-trips every visual field', () => {
    const s = parseUrlState('?theme=xray&shader=wire&bld=0&veg=0&net=1&badges=0&sim=profile&simnode=EN-03&rain=150&clog=90');
    expect(s).toMatchObject({ theme: 'xray', shader: 'wire', sim: 'profile', simNode: 'EN-03', rain: 150, clog: 90 });
    expect(s.layers).toEqual({ buildings: false, vegetation: false, network: true, badges: false });
    expect(parseUrlState(`?${serializeUrlState(s)}`)).toEqual(s);
  });
  it('maps the legacy xray=0 link to buildings off and rejects junk', () => {
    expect(parseUrlState('?xray=0').layers.buildings).toBe(false);
    const s = parseUrlState('?shader=chrome&sim=side&simnode=EN-8;drop');
    expect(s.shader).toBe(DEFAULT_URL_STATE.shader);
    expect(s.sim).toBeNull();
    expect(s.simNode).toBe(DEFAULT_URL_STATE.simNode);
  });
});

describe('node fullness (gauges, badges, simulator)', () => {
  it('follows the backend mount rules (lid <= 4.4 m, else crown-mounted)', () => {
    expect(sensorGeometry(sensor('EN-01'), network).crownMounted).toBe(false);
    expect(sensorGeometry(sensor('EN-05'), network).crownMounted).toBe(true);
    expect(sensorGeometry(sensor('EN-10'), network).crownMounted).toBe(true);
    expect(sensorGeometry(sensor('EN-07'), network)).toMatchObject({ shape: 'STORAGE', mountM: EN07_MAST_M, fullScaleM: network.lagoon.max_depth_m });
    expect(sensorGeometry(sensor('EN-08'), network)).toMatchObject({ shape: 'ORIFICE', mountM: EN08_MAST_M });
  });
  it('stays on the u7 cap_code scale for every node in every grid cell', () => {
    for (const rain of lut.axes.rainfall_mm_hr) {
      for (const clog of lut.axes.trash_rack_blockage_pct) {
        const st = interp.evaluate(rain, clog);
        for (const S of st.sensors) {
          const pct = nodeFullnessPct(S);
          expect(pct).toBeGreaterThanOrEqual(0);
          expect(pct).toBeLessThanOrEqual(CAP_MAX_PCT);
          const g = sensorGeometry(S.sensor, network);
          const d = ultrasonicDistanceMm(S, g);
          expect(d).toBeGreaterThanOrEqual(30);
          if (S.sensor.hardware === 'JETSON_YOLO_TRASHRACK') {
            expect(visualBlockagePct(S)).toBeCloseTo(clog, 6);
            expect(pct).toBeCloseTo(Math.min(S.hRatio * 100, CAP_MAX_PCT), 9);
          } else {
            expect(visualBlockagePct(S)).toBeNull();
            expect(pct).toBeCloseTo(Math.min(S.capacityPct, CAP_MAX_PCT), 9);
          }
        }
      }
    }
  });
  it('labels the daylight ramp bands at 45 / 75 / 94 %', () => {
    expect(fullnessStatus(45).label).toBe('Normal Flow');
    expect(fullnessStatus(46).label).toBe('Elevated');
    expect(fullnessStatus(80).label).toBe('High');
    expect(fullnessStatus(95).label).toBe('Surcharge');
    expect(capacityColor(0, 'daylight').toUpperCase()).toBe('#10B981');
    expect(capacityColor(0.8, 'daylight').toUpperCase()).toBe('#F97316');
    expect(capacityColor(1.1, 'daylight').toUpperCase()).toBe('#EF4444');
    expect(capacityColor(0.2).toUpperCase()).toBe('#12B5CB');
  });
});
