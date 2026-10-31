// Phase 9C: hybrid telemetry database (IndexedDB driver under fake-indexeddb), SD black-box
// recovery without hardware, and the Analytics Command Center builders.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LutFile, NetworkFile, PrecipLibrary } from '../../src/types/twin';
import { LutInterpolator } from '../../src/utils/lutInterpolator';
import { arbitrate } from '../../src/utils/fusion';
import { packTelemetryPayload, toHex } from '../../src/utils/payloadCodec';
import {
  crc32Frames,
  crc8Frame,
  frameRecord,
  IdbStore,
  MemoryStore,
  SEED_HOURS,
  SEED_STEP_MIN,
  seedIfEmpty,
  syntheticSeed,
  TelemetryDatabase,
} from '../../src/utils/telemetryDatabase';
import { assembleDump, bufferFrame, completeBackfill, initialRecovery, parseDumpLine, restoreLink, startBlackout, verifiedFrames } from '../../src/utils/sdRecovery';
import { agencyActions, buildHydrograph, conduitStressRows, sortStress, WEIR_CREST_ASL } from '../../src/utils/commandCenter';

const network = JSON.parse(readFileSync('public/data/city_camp_network.json', 'utf8')) as NetworkFile;
const lut = JSON.parse(readFileSync('public/data/simulation_lut.json', 'utf8')) as LutFile;
const library = JSON.parse(readFileSync('public/data/precip_library.json', 'utf8')) as PrecipLibrary;
const data = { network, lut, library };
const hex = (d: number, v: number, c: number, a = 0) => toHex(packTelemetryPayload(d, v, c, a, 3.9));
const ts = (m: number) => new Date(Date.UTC(2026, 9, 31, 4, m)).toISOString();

describe('frames and integrity (≡ backend/database.py)', () => {
  it('decodes the 32-bit payload into the persisted columns', () => {
    const r = frameRecord('EN-08', ts(0), '0x54c1672a', 'LIVE');
    expect(r).toMatchObject({ raw_hex_payload: '0x54C1672A', depth_cm: 169.5, dh_dt_cm_min: 0.5, capacity_pct: 78, anomaly_code: 2, battery_v: 3.8, sd_recovered_flag: false });
    expect(() => frameRecord('EN-08', ts(0), '0x123', 'LIVE')).toThrow();
  });
  it('CRC-32 matches zlib / the firmware dump trailer; CRC-8 tags each frame', () => {
    expect(crc32Frames(['0x12345678', '0xDEADBEEF', '0x54C1672A'])).toBe('669EBEEF');
    expect(['0x12345678', '0xDEADBEEF', '0x54C1672A'].map(crc8Frame)).toEqual([0x1c, 0xca, 0x0a]);
  });
});

describe('stores: memory + IndexedDB (BaguioFloodDB_v1)', () => {
  const drivers: [string, () => Promise<MemoryStore | IdbStore>][] = [
    ['memory', async () => new MemoryStore()],
    ['indexeddb', async () => IdbStore.open(indexedDB, 'test-store')],
  ];
  for (const [name, make] of drivers) {
    it(`stores, deduplicates and queries frames (${name})`, async () => {
      const store = await make();
      const rows = Array.from({ length: 6 }, (_, m) => frameRecord(m % 2 ? 'EN-03' : 'EN-08', ts(m), hex(800 + 10 * m, 2, 40 + m), 'LIVE'));
      expect(await store.putFrames(rows)).toBe(6);
      expect(await store.putFrames(rows.slice(0, 4))).toBe(0);
      expect(await store.count()).toBe(6);
      const en08 = await store.history('EN-08', 2);
      expect(en08.map((r) => r.timestamp_utc)).toEqual([ts(2), ts(4)]);
      await store.putBatch({ batch_id: 'B1', node_id: 'EN-08', uploaded_at: ts(9), frames_recovered: 3, start_timestamp: ts(0), end_timestamp: ts(2), integrity_crc_status: 'PASS' });
      await store.putIncident({ timestamp_utc: ts(9), node_id: 'EN-08', fusion_verdict: 'NOMINAL', trash_rack_occlusion_pct: 0, target_agency: 'CEPMO', action_summary: 'x' });
      expect((await store.batches())[0].batch_id).toBe('B1');
      expect((await store.incidents())[0].target_agency).toBe('CEPMO');
    });
  }
});

describe('dual-driver database (backend offline = IndexedDB only)', () => {
  it('ingests locally, backfills SD batches with CRC checks and reports the engine', async () => {
    const db = new TelemetryDatabase(await IdbStore.open(indexedDB, 'test-dual'), null);
    const live = [frameRecord('EN-07', ts(0), hex(1500, 0, 23), 'LIVE')];
    expect(await db.ingest(live)).toEqual({ inserted: 1, synced: false });
    const sd = Array.from({ length: 20 }, (_, m) => ({ timestamp_utc: ts(10 + m), payload_hex: hex(1500 + 20 * m, 2, 23 + m) }));
    const crc = crc32Frames(sd.map((f) => f.payload_hex));
    const ok = await db.sdBackfill('EN-07', sd, crc, 'B-ok');
    expect(ok).toMatchObject({ integrity_crc_status: 'PASS', frames_recovered: 20, duplicates: 0, synced: false });
    expect((await db.sdBackfill('EN-07', sd, crc, 'B-dup')).duplicates).toBe(20);
    expect((await db.sdBackfill('EN-07', sd, 'DEADBEEF', 'B-bad')).integrity_crc_status).toBe('FAIL');
    const { frames, from } = await db.history('EN-07', 100);
    expect(from).toBe('local');
    expect(frames.filter((f) => f.sd_recovered_flag)).toHaveLength(20);
    expect((await db.stats()).engine).toBe('IndexedDB (backend offline)');
    expect((await db.csv()).split('\n')[0]).toBe('node_id,timestamp_utc,raw_hex_payload,depth_cm,dh_dt_cm_min,capacity_pct,anomaly_code,battery_v,source_mode,sd_recovered_flag');
  });

  it('seeds 24 h of labelled synthetic storm telemetry once', async () => {
    const end = Date.UTC(2026, 9, 31, 6, 0);
    const seed = syntheticSeed(data, end);
    expect(seed).toHaveLength(((SEED_HOURS * 60) / SEED_STEP_MIN) * network.sensors.length);
    expect(seed.every((f) => f.source_mode === 'SYNTHETIC_SEED')).toBe(true);
    expect(syntheticSeed(data, end)).toEqual(seed);
    const peak = Math.max(...seed.filter((f) => f.node_id === 'EN-07').map((f) => f.depth_cm));
    expect(peak).toBeGreaterThan(300); // the design storm fills the lagoon
    const db = new TelemetryDatabase(new MemoryStore(), null);
    expect(await seedIfEmpty(db, data, end)).toBe(seed.length);
    expect(await seedIfEmpty(db, data, end)).toBe(0);
  });
});

describe('triple-redundant SD recovery without a USB board', () => {
  it('Blackout -> burst hex sync -> hydrograph backfill loses no frame', async () => {
    const db = new TelemetryDatabase(new MemoryStore(), null);
    let s = initialRecovery('EN-07');
    s = startBlackout(s, ts(0));
    expect(s.phase).toBe('BLACKOUT');
    for (let m = 0; m < 30; m++) s = bufferFrame(s, { timestamp_utc: ts(m), payload_hex: hex(1500 + 10 * m, 3, 23 + m) });
    expect(s.buffered).toHaveLength(30);
    s = restoreLink(s, ts(31), null);
    expect(s).toMatchObject({ phase: 'SYNCING', source: 'SOFTWARE', tier: 'SOFTWARE_FAILSAFE' });
    expect(s.crc32).toBe(crc32Frames(s.syncFrames.map((f) => f.payload_hex)));
    expect(verifiedFrames(s.syncFrames)).toBe(30);
    const res = await db.sdBackfill(s.node, s.syncFrames, s.crc32, 'B1');
    s = completeBackfill(s, { inserted: res.frames_recovered, duplicates: res.duplicates, status: res.integrity_crc_status, synced: res.synced });
    expect(s.phase).toBe('BACKFILLED');
    expect(s.result).toMatchObject({ inserted: 30, duplicates: 0, status: 'PASS' });
    const interp = new LutInterpolator(data);
    const h = buildHydrograph('EN-07', (await db.history('EN-07', 500)).frames, network, interp.evaluate(25, 0), null, Date.UTC(2026, 9, 31, 5, 0));
    expect(h.recoveredWindows).toEqual([[Date.parse(ts(0)), Date.parse(ts(29))]]);
    expect(h.points.filter((p) => p.recovered)).toHaveLength(30);
  });

  it('parses the firmware DUMP_SD_LOG burst and prefers it over the browser copy', () => {
    const lines = [
      'SD_STATUS:OK_FLASH_FAILSAFE',
      '[SD_DUMP] {"i":0,"seq":40,"t_ms":5000,"hex":"0x12345678"}',
      '[SD_DUMP] {"i":1,"seq":45,"t_ms":6000,"hex":"0xDEADBEEF"}',
      '[SD_DUMP] {"i":2,"seq":50,"t_ms":7000,"hex":"0x54C1672A"}',
      '[SD_DUMP_END] {"frames":3,"crc32":"669EBEEF","tier":"FLASH_FAILSAFE"}',
      '[EDGE_TX] {"device_eui":"EN-08"}',
    ].map(parseDumpLine);
    expect(lines[0]).toEqual({ kind: 'status', tier: 'FLASH_FAILSAFE' });
    expect(lines[5]).toBeNull();
    const dump = assembleDump(lines.filter((l) => l !== null), Date.UTC(2026, 9, 31, 4, 0, 10))!;
    expect(dump.crc32).toBe(crc32Frames(dump.frames.map((f) => f.payload_hex)));
    expect(dump.frames.map((f) => f.timestamp_utc)).toEqual(['2026-10-31T04:00:08.000Z', '2026-10-31T04:00:09.000Z', '2026-10-31T04:00:10.000Z']);
    let s = startBlackout(initialRecovery('EN-08'), ts(0));
    s = bufferFrame(s, { timestamp_utc: ts(0), payload_hex: '0x00000001' });
    s = restoreLink(s, ts(1), dump);
    expect(s).toMatchObject({ source: 'SERIAL', tier: 'FLASH_FAILSAFE', crc32: '669EBEEF' });
    expect(s.syncFrames).toHaveLength(3);
  });
});

describe('Analytics Command Center builders', () => {
  const interp = new LutInterpolator(data);
  it('hydrograph: lagoon stage in m ASL against the weir crest and the 80 % spill threshold', () => {
    const st = interp.evaluate(25, 0);
    const h = buildHydrograph('EN-07', [frameRecord('EN-07', ts(0), hex(1500, 0, 23), 'LIVE')], network, st, null, Date.UTC(2026, 9, 31, 5));
    expect(h.unit).toBe('m ASL');
    expect(h.points[0].value).toBeCloseTo(1428.0, 6);
    expect(h.references.map((r) => r.value)).toEqual([WEIR_CREST_ASL, 1426.5 + 0.8 * 6.5, 1433]);
    expect(buildHydrograph('EN-03', [], network, st, null, 0).unit).toBe('%');
  });
  it('conduit stress ranking covers all 63 conduits and sorts', () => {
    const st = interp.evaluate(100, 50);
    const rows = conduitStressRows(network, st, arbitrate(st), null);
    expect(rows).toHaveLength(63);
    const byFill = sortStress(rows, 'fillPct', true);
    expect(byFill[0].fillPct).toBeGreaterThanOrEqual(byFill[1].fillPct);
    expect(rows.find((r) => r.id === 'LGD-C07')!.dhDtCmMin).not.toBeNull();
    expect(rows.find((r) => r.id === 'TUN-C03')!.dims).toMatch(/arch/);
  });
  it('agency action matrix follows the fusion verdict', () => {
    const at = (r: number, b: number) => {
      const st = interp.evaluate(r, b);
      return agencyActions(network, st, arbitrate(st), null);
    };
    expect(at(25, 78)[1]).toMatchObject({ agency: 'CEPMO / City Engineering', level: 'ACTION' });
    expect(at(25, 0)[1].headline).toBe('Do not dispatch: rack is clear');
    expect(at(200, 30)[0]).toMatchObject({ agency: 'CDRRMO', level: 'ACTION' });
    expect(at(0, 0)[0].level).toBe('NOMINAL');
    expect(at(25, 0)[2].headline).toMatch(/rock choke governs outflow/i);
  });
});
