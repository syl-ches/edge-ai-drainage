// Phase 9B: nearest Command Center CCTV resolver, storm replay presets + fusion verdicts, and the
// City Camp Lagoon intake-compound builder.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, type BufferGeometry } from 'three';
import type { LutFile, NetworkFile, PrecipLibrary } from '../../src/types/twin';
import { LutInterpolator } from '../../src/utils/lutInterpolator';
import { arbitrate } from '../../src/utils/fusion';
import { connectionBadge, feedSource, haversineM, nearestCameras, type CctvRegistry } from '../../src/utils/cctvStreams';
import { detectionsFor, formatStormTime, osdTimestamp, REPLAY_MINUTES, REPLAY_PRESETS, replayFrame, SKIP_STORM_MIN } from '../../src/cctv/replay';
import {
  buildIntakeCompound,
  gaugeReadingM,
  INTAKE,
  onRack,
  RACK_RUN,
  RACK_SLOPE_LEN,
  RACK_VISUAL_ANGLE_DEG,
  regimeOf,
  weirSubmerged,
  type ColorMaterial,
} from '../../src/intake/compound';

const network = JSON.parse(readFileSync('public/data/city_camp_network.json', 'utf8')) as NetworkFile;
const lut = JSON.parse(readFileSync('public/data/simulation_lut.json', 'utf8')) as LutFile;
const library = JSON.parse(readFileSync('public/data/precip_library.json', 'utf8')) as PrecipLibrary;
const registry = JSON.parse(readFileSync('public/data/cctv_cameras.json', 'utf8')) as CctvRegistry;
const golden = JSON.parse(readFileSync('tests/frontend/fixtures/cctv_golden.json', 'utf8')) as {
  nearest: Record<string, { camera_id: string; distance_m: number; in_coverage: boolean }[]>;
};
const sensor = (id: string) => network.sensors.find((s) => s.sensor_id === id)!;
const interp = () => new LutInterpolator({ network, lut, library });

describe('nearest Command Center CCTV resolver (≡ backend/cctv.py)', () => {
  it('reproduces the Python golden mapping for every node', () => {
    for (const s of network.sensors.filter((x) => x.is_active)) {
      const got = nearestCameras(s, registry, 2);
      const want = golden.nearest[s.sensor_id];
      expect(got.map((f) => f.camera.camera_id)).toEqual(want.map((w) => w.camera_id));
      got.forEach((f, i) => {
        expect(f.distanceM).toBeCloseTo(want[i].distance_m, 1);
        expect(f.inCoverage).toBe(want[i].in_coverage);
      });
    }
  });

  it('maps the lagoon intake nodes to City Camp Lagoon A (12 m) then B', () => {
    for (const id of ['EN-08', 'EN-09']) {
      const [a, b] = nearestCameras(sensor(id), registry, 2);
      expect(a.camera.camera_id).toBe('CAM-CCL-A');
      expect(a.camera.osd_label).toBe('City Camp Lagoon A');
      expect(a.distanceM).toBeCloseTo(12, 0);
      expect(b.camera.camera_id).toBe('CAM-CCL-B');
      expect(b.camera.osd_label).toBe('City Camp Lagoon B');
      expect(a.camera.scene).toBe('CCL_A');
      expect(b.camera.scene).toBe('CCL_B');
    }
    // every other node resolves a pair, nearest first
    for (const s of network.sensors) {
      const f = nearestCameras(s, registry, 2);
      expect(f).toHaveLength(2);
      expect(f[0].distanceM).toBeLessThanOrEqual(f[1].distanceM);
    }
    expect(haversineM([120.5863, 16.4093], [120.5863, 16.4093])).toBe(0);
  });

  it('never claims a live VMS link that is not configured', () => {
    const [a] = nearestCameras(sensor('EN-08'), registry, 2);
    expect(registry.cameras.every((c) => c.stream === null && c.registry_status === 'PLACEHOLDER')).toBe(true);
    expect(feedSource(a.camera, null)).toBe('PROCEDURAL');
    expect(connectionBadge(a, 'EN-08', 'PROCEDURAL')).toBe('Procedural replay · VMS stream not configured · nearest mapped feed (12 m from EN-08)');
    expect(feedSource(a.camera, '/cctv/clip.mp4')).toBe('LOCAL_CLIP');
    const streamed = { ...a, camera: { ...a.camera, stream: { protocol: 'hls' as const, url: 'https://gw/ccl-a.m3u8' } } };
    expect(feedSource(streamed.camera, null)).toBe('VMS_STREAM');
    expect(connectionBadge(streamed, 'EN-08', 'VMS_STREAM')).toBe('Command Center VMS stream · auto-retrieved nearest feed (12 m from EN-08)');
    const street = registry.cameras.find((c) => c.camera_id === 'CAM-KSD-01')!;
    expect(feedSource(street, null)).toBe('NO_SIGNAL');
  });
});

describe('CCTV storm replay presets + multi-sensor fusion', () => {
  it('presets carry the specified occlusion', () => {
    const [baseline, debris, backwater] = REPLAY_PRESETS;
    expect(baseline.label).toBe('Preset 1: Dry / Post-Clearing Baseline (15% Occlusion)');
    expect(debris.label).toBe('Preset 2: Typhoon Surface Debris Occlusion (78% Clogged)');
    expect(backwater.label).toMatch(/^Preset 3: Clean Grate \+ Downstream Rock-Choke Backwater/);
    const L = interp();
    for (const t of [0, 30, 60]) expect(replayFrame(L, 'baseline', t).occlusionPct).toBe(15);
    expect(replayFrame(L, 'debris', 0).occlusionPct).toBe(30);
    expect(replayFrame(L, 'debris', 25).occlusionPct).toBe(78);
    expect(replayFrame(L, 'debris', 60).occlusionPct).toBe(78);
    for (const t of [0, 30, 60]) expect(replayFrame(L, 'backwater', t).occlusionPct).toBeLessThan(15);
  });

  it('baseline stays nominal', () => {
    const L = interp();
    for (let t = 0; t <= REPLAY_MINUTES; t += 10) {
      const f = replayFrame(L, 'baseline', t);
      expect(f.action).toBe('NOMINAL');
      expect(f.weirSubmerged).toBe(false);
    }
  });

  it('typhoon debris: watch, then CEPMO trash-rack clearing dispatch once the pool backs up', () => {
    const L = interp();
    expect(replayFrame(L, 'debris', 10).action).toBe('DEBRIS_WATCH');
    const end = replayFrame(L, 'debris', 60);
    expect(end.action).toBe('TRASH_RACK_OCCLUSION_DISPATCH');
    expect(end.verdict.root_cause).toBe('CONFIRMED_TRASH_RACK_OCCLUSION');
    expect(end.verdict.suppressed_false_alarm).toBe(false);
    expect(end.evacuationWarning).toBe(false);
  });

  it('clean grate + rock-choke backwater: rack alarm suppressed, then CDRRMO escalation', () => {
    const L = interp();
    expect(replayFrame(L, 'backwater', 5).action).toBe('NOMINAL');
    const mid = replayFrame(L, 'backwater', 30);
    expect(mid.action).toBe('DOWNSTREAM_CHOKE_BACKWATER_OVERRIDE');
    expect(mid.verdict.suppressed_false_alarm).toBe(true);
    expect(mid.weirSubmerged).toBe(true);
    const end = replayFrame(L, 'backwater', 60);
    expect(end.sensors['EN-08'].anomaly).toBe('SURCHARGED'); // deep pool outranks the flat-pool class
    expect(end.action).toBe('DOWNSTREAM_CHOKE_BACKWATER_OVERRIDE');
    expect(end.evacuationWarning).toBe(true);
    expect(end.overflowEtaMin!).toBeLessThanOrEqual(60);
  });

  it('scrubbing is deterministic and the lagoon rises monotonically under constant rain', () => {
    const L = interp();
    let prev = 0;
    for (let t = 10; t <= 60; t += 2.5) {
      const f = replayFrame(L, 'backwater', t);
      expect(f.lagoonDepthM).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f.lagoonDepthM;
    }
    expect(replayFrame(L, 'debris', 42.5)).toEqual(replayFrame(interp(), 'debris', 42.5));
    expect(replayFrame(L, 'debris', -5).tMin).toBe(0);
    expect(replayFrame(L, 'debris', 99).tMin).toBe(60);
    expect(SKIP_STORM_MIN).toBe(7.5);
  });

  it('a SURCHARGED rack sensor counts as backwater evidence (fusion regression)', () => {
    const L = interp();
    let st = L.evaluate(50, 0);
    expect(st.sensors.find((s) => s.id === 'EN-08')!.anomaly).toBe('SURCHARGED');
    expect(arbitrate(st).root_cause).toBe('DOWNSTREAM_ROCK_CHOKE_BACKWATER');
    st = L.evaluate(25, 78);
    expect(st.sensors.find((s) => s.id === 'EN-08')!.anomaly).toBe('SURCHARGED');
    expect(arbitrate(st).root_cause).toBe('CONFIRMED_TRASH_RACK_OCCLUSION');
  });

  it('YOLOv8 overlay labels follow the replay state', () => {
    const L = interp();
    const debris = detectionsFor(replayFrame(L, 'debris', 60));
    expect(debris.find((d) => d.key === 'debris')!.label).toBe('DEBRIS_CLUSTER');
    expect(debris.find((d) => d.key === 'debris')!.confidence).toBeGreaterThan(0.9);
    expect(debris.find((d) => d.key === 'rack')!.label).toBe('TRASH_RACK_OCCLUSION 78%');
    const back = detectionsFor(replayFrame(L, 'backwater', 60));
    expect(back.some((d) => d.key === 'debris')).toBe(false);
    expect(back.find((d) => d.key === 'weir')!.label).toBe('WEIR_SUBMERGED');
    expect(back.find((d) => d.key === 'gauge')!.label).toMatch(/^STAFF_GAUGE_LEVEL 4\.5m$/);
    expect(formatStormTime(32.5)).toBe('32:30');
    expect(osdTimestamp(new Date(2024, 8, 30, 10, 10, 8))).toBe('09-30-2024 Mon 10:10:08');
  });
});

describe('City Camp Lagoon intake compound builder', () => {
  const build = () =>
    buildIntakeCompound((_role, look) => new MeshBasicMaterial({ color: look.color, transparent: (look.opacity ?? 1) < 1, opacity: look.opacity ?? 1 }) as unknown as ColorMaterial);

  it('builds the channel, weir, sloped rack, truss cage, gauge and compound landmarks', () => {
    const c = build();
    const names = (g: typeof c.structure) => g.children.map((o) => o.name);
    const structure = names(c.structure);
    for (const role of ['channel', 'concrete', 'masonry', 'railing', 'bars', 'rust', 'cage', 'cageMesh', 'gaugeGreen', 'gaugeAmber', 'gaugeRed', 'portal'])
      expect(structure).toContain(`structure:${role}`);
    expect(structure).toEqual(expect.arrayContaining(['intake-water', 'intake-debris']));
    const landmarks = names(c.landmarks);
    for (const role of ['courtRoof', 'courtSteel', 'courtFloor', 'stationWall', 'stationRoof', 'shed', 'pipe', 'asphalt']) expect(landmarks).toContain(`landmarks:${role}`);
    expect(landmarks).toContain('intake-outfall-jet');
    c.group.traverse((o) => {
      const g = (o as Mesh).geometry as BufferGeometry | undefined;
      if (!g) return;
      const pos = g.getAttribute('position');
      expect(pos.count).toBeGreaterThan(0);
      for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
    });
  });

  it('draws the bar screen at the field-observed ~50° from the sill to the headwall', () => {
    expect(RACK_VISUAL_ANGLE_DEG).toBe(50);
    const top = onRack(0, RACK_SLOPE_LEN);
    expect(top.z).toBeCloseTo(INTAKE.rackRise, 6);
    expect(top.y).toBeCloseTo(0, 6);
    expect(onRack(0, 0).y).toBeCloseTo(-RACK_RUN, 6);
    expect(Math.atan2(INTAKE.rackRise, RACK_RUN) * (180 / Math.PI)).toBeCloseTo(50, 6);
  });

  it('debris, water and the outfall jet follow the hydrology state', () => {
    const c = build();
    const s = { waterElevM: 1430.5, occlusionPct: 0, rainMmHr: 0, regime: 'CALM' as const };
    c.update(0, s);
    expect(c.debrisShown()).toBe(0);
    c.update(0.1, { ...s, occlusionPct: 95, rainMmHr: 80, regime: 'BACKWATER' });
    expect(c.debrisShown()).toBe(INTAKE.debrisCount);
    c.update(0.2, { ...s, occlusionPct: 47.5 });
    expect(c.debrisShown()).toBe(INTAKE.debrisCount / 2);
    const water = c.structure.children.find((o) => o.name === 'intake-water')!;
    expect(water.position.z).toBeCloseTo(1430.5 - 1428.0, 6);
    const targets = c.detectionTargets();
    expect(targets.map((t) => t.key)).toEqual(['rack', 'debris', 'weir', 'gauge']);
    for (const t of targets) expect(t.box.isEmpty()).toBe(false);
  });

  it('maps edge anomalies to water looks and reads the staff gauge on the lagoon datum', () => {
    expect(regimeOf('FLASH_SURGE')).toBe('SURGE');
    expect(regimeOf('TRASH_BLOCKAGE')).toBe('BACKWATER');
    expect(regimeOf('SURCHARGED')).toBe('BACKWATER');
    expect(regimeOf('NORMAL')).toBe('CALM');
    expect(gaugeReadingM(1430.7)).toBeCloseTo(4.2, 6);
    expect(weirSubmerged(1428.0 + INTAKE.weirCrestZ + 0.1)).toBe(true);
    expect(weirSubmerged(1428.0 + INTAKE.weirCrestZ)).toBe(false);
  });
});
