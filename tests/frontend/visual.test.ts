import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { LutFile, NetworkFile } from '../../src/types/twin';
import type { TwinFrame } from '../../src/types/live';
import { LutInterpolator } from '../../src/utils/lutInterpolator';
import { CAP_MAX_PCT } from '../../src/utils/payloadCodec';
import { DEFAULT_URL_STATE, parseUrlState, serializeUrlState } from '../../src/utils/urlState';
import {
  ALARM_PCT,
  EN07_MAST_M,
  EN08_MAST_M,
  alarmBlink,
  alarmConduitId,
  badgeContent,
  fullnessStatus,
  markerTone,
  nodeFullnessPct,
  sensorGeometry,
  ultrasonicDistanceMm,
  visualBlockagePct,
} from '../../src/utils/fullness';
import { capacityColor } from '../../src/three/palette';
import { GLASS, SHADING_SHOWS_EDGES, createBuildingMaterials } from '../../src/three/materials/buildingMaterials';
import { BASELINE_WEATHER, OPEN_METEO_URL, parseOpenMeteo, precipRateMmHr, weatherLabel } from '../../src/live/weather';
import { backendCommand, frameMatchesDriver, resolveLiveTarget } from '../../src/live/liveDriver';
import type { LiveSnapshot } from '../../src/live/telemetry';
import { weatherStatus } from '../../src/ui/shell';

const network = JSON.parse(readFileSync('public/data/city_camp_network.json', 'utf8')) as NetworkFile;
const lut = JSON.parse(readFileSync('public/data/simulation_lut.json', 'utf8')) as LutFile;
const interp = LutInterpolator.fromFiles(network, lut);
const sensor = (id: string) => network.sensors.find((s) => s.sensor_id === id)!;

describe('urlState (theme / shader / layers / simulator deep links)', () => {
  it('starts in Live Weather & Telemetry mode; mode=sim opts into the simulator', () => {
    expect(DEFAULT_URL_STATE.mode).toBe('LIVE');
    expect(parseUrlState('').mode).toBe('LIVE');
    expect(parseUrlState('?mode=live').mode).toBe('LIVE');
    const sim = parseUrlState('?mode=sim&rain=150');
    expect(sim.mode).toBe('SIM');
    expect(serializeUrlState(sim)).toContain('mode=sim');
    expect(serializeUrlState(parseUrlState(''))).not.toContain('mode=');
  });
  it('defaults to the daylight diorama, surface first: Solid Concrete with the subsurface hidden (Phase 9A)', () => {
    const s = parseUrlState('');
    expect(s.theme).toBe('daylight');
    expect(s.shader).toBe('solid');
    expect(s.shader).toBe(DEFAULT_URL_STATE.shader);
    expect(s.layers).toEqual({ buildings: true, vegetation: true, network: false, badges: true, waterways: true });
    expect(s.sim).toBeNull();
  });
  it('round-trips every visual field', () => {
    const s = parseUrlState('?theme=xray&shader=wire&bld=0&veg=0&net=1&badges=0&wwy=0&sim=profile&simnode=EN-03&rain=150&clog=90&mode=sim');
    expect(s).toMatchObject({ theme: 'xray', shader: 'wire', sim: 'profile', simNode: 'EN-03', rain: 150, clog: 90, mode: 'SIM' });
    expect(s.layers).toEqual({ buildings: false, vegetation: false, network: true, badges: false, waterways: false });
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

describe('node fullness (markers, badges, simulator)', () => {
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

const evalSensor = (id: string, rain = 25, clog = 0) => {
  const st = interp.evaluate(rain, clog);
  return { ...st.sensors[interp.sensorIndex.get(id)!] };
};

describe('surface markers + compact badges (Phase 7A)', () => {
  it('turns red at >= 80 % full, surcharge or a live hardware surge', () => {
    const S = evalSensor('EN-03');
    expect(markerTone({ ...S, capacityPct: 20, anomaly: 'NORMAL', liveSurge: false })).toBe('normal');
    expect(markerTone({ ...S, capacityPct: 45, anomaly: 'NORMAL', liveSurge: false })).toBe('elevated');
    expect(markerTone({ ...S, capacityPct: 79.9, anomaly: 'NORMAL', liveSurge: false })).toBe('elevated');
    expect(markerTone({ ...S, capacityPct: ALARM_PCT, anomaly: 'NORMAL', liveSurge: false })).toBe('alarm');
    expect(markerTone({ ...S, capacityPct: 30, anomaly: 'SURCHARGED', liveSurge: false })).toBe('alarm');
    expect(markerTone({ ...S, capacityPct: 30, anomaly: 'FLASH_SURGE', liveSurge: true })).toBe('alarm');
  });
  it('blinks red <-> light red at 3 Hz', () => {
    expect(alarmBlink(0)).toBeCloseTo(0.5, 9);
    expect(alarmBlink(1 / 12)).toBeCloseTo(1, 9); // quarter period of 3 Hz
    expect(alarmBlink(1 / 3)).toBeCloseTo(alarmBlink(0), 9);
  });
  it('puts flooded nodes in alarm under the typhoon case and maps them to a conduit', () => {
    const st = interp.evaluate(200, 85);
    const alarmed = st.sensors.filter((S) => markerTone(S) === 'alarm');
    expect(alarmed.length).toBeGreaterThan(0);
    for (const S of alarmed) {
      const id = alarmConduitId(S.sensor);
      if (S.sensor.attached_kind === 'STORAGE') expect(id).toBeNull();
      else expect(interp.conduitIndex.has(id!)).toBe(true);
    }
    expect(interp.evaluate(0, 0).sensors.every((S) => markerTone(S) !== 'alarm')).toBe(true);
  });
  it('compact badge = id + one number (the vision node shows its blockage)', () => {
    const en08 = badgeContent(evalSensor('EN-08', 100, 50));
    expect(en08.id).toBe('EN-08');
    expect(en08.value).toMatch(/^\d+%$/);
    expect(en08.vision).toBe(false);
    expect(badgeContent(evalSensor('EN-09', 25, 15))).toMatchObject({ id: 'EN-09', value: '15% blk', vision: true });
  });
});

describe('building shading modes (Phase 7A)', () => {
  it('draws edge lines in Holo Wireframe only', () => {
    expect(SHADING_SHOWS_EDGES).toEqual({ solid: false, wire: true, glass: false });
    const mats = createBuildingMaterials(new Vector3());
    const meshes = { solid: { visible: false }, glass: { visible: false }, wireFill: { visible: false }, edges: { visible: true } };
    const m = meshes as unknown as Parameters<typeof mats.apply>[1];
    mats.apply('glass', m);
    expect(meshes).toEqual({ solid: { visible: false }, glass: { visible: true }, wireFill: { visible: false }, edges: { visible: false } });
    mats.apply('solid', m);
    expect(meshes.solid.visible && !meshes.edges.visible).toBe(true);
    mats.apply('wire', m);
    expect(meshes.wireFill.visible && meshes.edges.visible).toBe(true);
  });
  it('uses the specified outline-free Fresnel glass and a matte #EFEFEF solid (Phase 9B)', () => {
    const mats = createBuildingMaterials(new Vector3());
    expect(GLASS).toMatchObject({ baseOpacity: 0.08, rimPower: 2.8, rimGain: 0.48, alphaMin: 0.06, alphaMax: 0.62 });
    expect(mats.glass.transparent && !mats.glass.depthWrite && mats.glass.depthTest).toBe(true);
    expect(mats.glass.uniforms.uCoreColor.value.toArray()).toEqual([0.95, 0.99, 1.0]);
    expect(mats.glass.uniforms.uRimColor.value.toArray()).toEqual([0.06, 0.72, 0.58]);
    expect(mats.glass.fragmentShader).toContain('clamp(uBaseOpacity + fresnel * 0.48, 0.06, 0.62)');
    expect(mats.solid.fragmentShader).not.toMatch(/storey|glazing/);
    expect(mats.solid.fragmentShader).toContain('mix(dark, vec3(0.9373), uDay)');
  });
});

describe('live Baguio weather (Open-Meteo)', () => {
  it('queries Baguio City with the required current fields and no key', () => {
    expect(OPEN_METEO_URL).toContain('latitude=16.4093&longitude=120.5863');
    expect(OPEN_METEO_URL).toContain('current=temperature_2m,precipitation,rain,showers,weather_code,wind_speed_10m');
    expect(OPEN_METEO_URL).not.toMatch(/apikey|key=/i);
  });
  it('converts the 15-min precipitation total to mm/hr', () => {
    expect(precipRateMmHr({ precipitation: 1.5, interval: 900 })).toBeCloseTo(6, 9);
    expect(precipRateMmHr({ precipitation: 0, rain: 0.5, showers: 0.25, interval: 900 })).toBeCloseTo(3, 9);
    expect(precipRateMmHr({ precipitation: 999, interval: 900 })).toBe(250);
    expect(precipRateMmHr({})).toBe(0);
  });
  it('parses a response and labels the condition', () => {
    const w = parseOpenMeteo({
      current: { time: '2026-10-27T14:00', interval: 900, temperature_2m: 18.4, precipitation: 2.5, rain: 2.5, showers: 0, weather_code: 63, wind_speed_10m: 9.1 },
    });
    expect(w).toMatchObject({ rainMmHr: 10, temperatureC: 18.4, code: 63, label: 'Moderate Rain', source: 'OPEN_METEO' });
    expect(weatherLabel(0, 0)).toBe('Clear');
    expect(weatherLabel(2, 1.2)).toBe('Light Rain');
    expect(weatherLabel(82, 12)).toBe('Heavy Monsoon Shower');
    expect(weatherLabel(63, 45)).toBe('Heavy Monsoon Shower');
    expect(() => parseOpenMeteo({})).toThrow();
  });
});

describe('live driver (default = live weather)', () => {
  const weather = { ...BASELINE_WEATHER, rainMmHr: 12.5, label: 'Moderate Rain', source: 'OPEN_METEO' as const };
  const frame = (mode: TwinFrame['mode'], precip_source: TwinFrame['precip_source'] = 'TWIN', storm_id = 'DESIGN_TYPHOON_12H') =>
    ({
      mode,
      precip_source,
      storm_id,
      scenario: { rainfall_mm_hr: 140, trash_rack_blockage_pct: 60 },
      hardware_override: mode === 'HARDWARE' ? { sensor_id: 'EN-08', age_s: 3 } : null,
    }) as TwinFrame;
  const snap = (f: TwinFrame | null, source: LiveSnapshot['source'] = 'BACKEND_WS'): LiveSnapshot => ({
    source,
    rain: 90,
    clog: 40,
    clockS: 0,
    periodS: 120,
    frame: f,
    wsUrl: 'ws://x',
  });

  it('drives rainfall from live weather and pushes it to the backend fleet', () => {
    const t = resolveLiveTarget({ kind: 'WEATHER' }, weather, null);
    expect(t).toMatchObject({ rain: 12.5, clog: 0, source: 'WEATHER' });
    expect(backendCommand({ kind: 'WEATHER' })).toEqual({ type: 'control', precip_source: 'LIVE_FEED', trash_rack_blockage_pct: 0 });
    expect(weatherStatus('LIVE', weather, t)).toBe('Live Weather Synced • Click "Simulation Mode" to stress-test');
    expect(weatherStatus('SIM', weather, t)).toContain('Simulation mode');
    expect(weatherStatus('LIVE', BASELINE_WEATHER, t)).toContain('Offline');
  });
  it('lets a hardware uplink override; pitch and replay take over on demand', () => {
    expect(resolveLiveTarget({ kind: 'WEATHER' }, weather, snap(frame('HARDWARE')))).toMatchObject({ rain: 140, clog: 60, source: 'HARDWARE' });
    const pitch = { kind: 'PITCH' as const, id: 'monsoon', label: 'Monsoon Surge', rain: 100, clog: 50 };
    expect(resolveLiveTarget(pitch, weather, snap(frame('SCENARIO')))).toMatchObject({ rain: 100, clog: 50, source: 'PITCH' });
    const replay = { kind: 'REPLAY' as const, stormId: 'OMPONG_2018', label: 'Ompong' };
    expect(resolveLiveTarget(replay, weather, snap(null, 'LOCAL_PLAYBACK'))).toMatchObject({ rain: 90, clog: 40, source: 'REPLAY' });
    expect(backendCommand(replay)).toEqual({ type: 'control', precip_source: 'HISTORICAL', storm_id: 'OMPONG_2018' });
    expect(backendCommand(pitch)).toEqual({ type: 'control', precip_source: 'TWIN', rainfall_mm_hr: 100, trash_rack_blockage_pct: 50 });
    // once the backend serves its own LIVE_FEED, its rate drives the twin
    expect(resolveLiveTarget({ kind: 'WEATHER' }, weather, snap(frame('SCENARIO', 'LIVE_FEED'))).rain).toBe(140);
  });
  it('ignores backend frames that predate the chosen driver', () => {
    const replay = { kind: 'REPLAY' as const, stormId: 'OMPONG_2018', label: 'Ompong' };
    expect(frameMatchesDriver({ kind: 'WEATHER' }, frame('PLAYBACK', 'HISTORICAL'))).toBe(false);
    expect(frameMatchesDriver({ kind: 'WEATHER' }, frame('SCENARIO', 'LIVE_FEED'))).toBe(true);
    expect(frameMatchesDriver(replay, frame('PLAYBACK', 'HISTORICAL', 'OMPONG_2018'))).toBe(true);
    expect(frameMatchesDriver(replay, frame('PLAYBACK', 'HISTORICAL', 'DESIGN_TYPHOON_12H'))).toBe(false);
    expect(frameMatchesDriver(replay, frame('HARDWARE'))).toBe(true);
  });
});
