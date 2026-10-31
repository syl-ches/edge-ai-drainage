// Phase 7B: Arduino / aquarium rig -> cross-tab sync -> 3D map override.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LutFile, NetworkFile } from '../../src/types/twin';
import { LutInterpolator } from '../../src/utils/lutInterpolator';
import { HardwareRig, lineSplitter, parseSerialLine, type RigConfig } from '../../src/live/serialRig';
import { applyHardwarePacket, ingestBody, invertRainForSensor, openSyncBus, wifiPacketFromFrame, type HardwarePacket, type SyncMessage } from '../../src/live/hardwareSync';
import type { LiveSensor } from '../../src/types/live';
import { alarmConduitId, markerTone } from '../../src/utils/fullness';
import { STATUSES } from '../../src/utils/lutInterpolator';
import { unpackTelemetryPayload } from '../../src/utils/payloadCodec';
import { hardwareBannerText, rigLabel } from '../../src/components/HardwareAlertBanner';
import { isHardwareSimRoute } from '../../src/main.route';

const network = JSON.parse(readFileSync('public/data/city_camp_network.json', 'utf8')) as NetworkFile;
const lut = JSON.parse(readFileSync('public/data/simulation_lut.json', 'utf8')) as LutFile;
const interp = LutInterpolator.fromFiles(network, lut);

const cfg = (over: Partial<RigConfig> = {}): RigConfig => ({
  sensorId: 'EN-08',
  deviceEui: '02BA6C1000000008',
  fullScaleM: 2.0,
  tankHeightMm: 400,
  scope: 'single_node',
  origin: 'AQUARIUM_SIM',
  ...over,
});

/** Drive the virtual rig at 5 Hz with deterministic chop. */
function drive(rig: HardwareRig, fills: number[], chopMm: number, t0 = 0): HardwarePacket[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 2;
  return fills.map((f, k) => {
    const d = rig.distanceForFill(f);
    const burst = Array.from({ length: 10 }, () => d + rnd() * chopMm * 1.7);
    return rig.ingestBurst(burst, t0 + k * 200);
  });
}

describe('serial line parser (any Arduino / ESP32 sketch)', () => {
  it('accepts tagged, unit-suffixed and plain readings', () => {
    expect(parseSerialLine('DIST_MM:240')).toEqual({ kind: 'distance', mm: 240 });
    expect(parseSerialLine('dist_cm = 24.5')).toEqual({ kind: 'distance', mm: 245 });
    expect(parseSerialLine('FILL_PCT:85')).toEqual({ kind: 'fill', pct: 85 });
    expect(parseSerialLine('TEMP_C:24.5')).toEqual({ kind: 'temp', c: 24.5 });
    expect(parseSerialLine('Distance: 24 cm')).toEqual({ kind: 'distance', mm: 240 });
    expect(parseSerialLine('distance=312mm')).toEqual({ kind: 'distance', mm: 312 });
    expect(parseSerialLine('312')).toEqual({ kind: 'distance', mm: 312 });
    expect(parseSerialLine('24.0')).toEqual({ kind: 'distance', mm: 240 });
    expect(parseSerialLine('24', 'mm')).toEqual({ kind: 'distance', mm: 24 });
    expect(parseSerialLine('A02YYUW ready')).toBeNull();
    expect(parseSerialLine('')).toBeNull();
  });
  it('decodes firmware [EDGE_TX] frames without re-filtering', () => {
    const line = '[EDGE_TX] {"device_eui":"EN-08","payload_hex":"0x591fec8c","kalman_filtered_depth_mm":1780.4,"h_over_d":0.89}';
    const r = parseSerialLine(line);
    expect(r).toMatchObject({ kind: 'edge_tx', deviceEui: 'EN-08', payloadHex: '0x591FEC8C' });
    const p = new HardwareRig(cfg()).ingestReading(r!, 0)!;
    const d = unpackTelemetryPayload(0x591fec8c);
    expect(p).toMatchObject({ payloadHex: '0x591FEC8C', capacityPct: d.capPct, depthMm: 1780.4 });
    expect(p.fillPct).toBeCloseTo(89, 6);
    expect(parseSerialLine('[EDGE_TX] {"payload_hex":"nope"}')).toBeNull();
  });
  it('re-assembles lines split across USB chunks', () => {
    const got: string[] = [];
    const feed = lineSplitter((l) => got.push(l));
    feed('DIST_M');
    feed('M:240\r\nDIST_MM:2');
    feed('41\n');
    expect(got).toEqual(['DIST_MM:240', 'DIST_MM:241']);
  });
});

describe('aquarium rig -> edge pipeline', () => {
  it('maps fill to h/D with the bench-standpipe convention (100 % = 74 % of the sensor height)', () => {
    const rig = new HardwareRig(cfg());
    expect(rig.distanceForFill(0)).toBe(400);
    expect(rig.distanceForFill(100)).toBeCloseTo(400 - 296, 9);
    const p = drive(rig, Array(25).fill(60), 1.0).at(-1)!;
    expect(p.capacityPct).toBeGreaterThan(57);
    expect(p.capacityPct).toBeLessThan(63);
    expect(p.anomaly).toBe('NORMAL');
  });
  it('"Almost Full" (85 %) flat pool turns the marker red with a TRASH_BLOCKAGE signature', () => {
    const p = drive(new HardwareRig(cfg()), Array(30).fill(85), 0.6).at(-1)!;
    expect(p.capacityPct).toBeGreaterThan(80);
    expect(p.anomaly).toBe('TRASH_BLOCKAGE');
    const st = interp.evaluate(0, 0);
    applyHardwarePacket(st, interp, p);
    expect(markerTone(st.sensors[interp.sensorIndex.get('EN-08')!])).toBe('alarm');
  });
  it('a turbulent pour raises a FLASH_SURGE and full surcharge reports SURCHARGED', () => {
    const rig = new HardwareRig(cfg());
    drive(rig, Array(10).fill(20), 1);
    const pour = drive(rig, Array.from({ length: 8 }, (_, k) => 23 + 3 * k), 16, 2000);
    expect(pour.some((p) => p.anomaly === 'FLASH_SURGE')).toBe(true);
    const full = drive(rig, Array(25).fill(105), 1, 4000).at(-1)!;
    expect(full.anomaly).toBe('SURCHARGED');
    expect(full.payloadHex).toMatch(/^0x[0-9A-F]{8}$/);
  });
});

describe('cross-tab sync + map override', () => {
  it('delivers packets between tabs over BroadcastChannel', async () => {
    const a = openSyncBus();
    const b = openSyncBus();
    expect(a.transport).toBe('broadcast-channel');
    const got = new Promise<SyncMessage>((resolve) => b.subscribe(resolve));
    const p = drive(new HardwareRig(cfg()), [50], 1)[0];
    const t0 = performance.now();
    a.publish(p);
    const m = await got;
    expect(performance.now() - t0).toBeLessThan(500); // delivery check; wall-clock latency is load-dependent under vitest
    expect(m).toMatchObject({ type: 'telemetry', sensorId: 'EN-08', payloadHex: p.payloadHex });
    a.close();
    b.close();
  });
  it('targeted mode drives one sensor and its conduit (red blink >= 80 %)', () => {
    const p = drive(new HardwareRig(cfg({ sensorId: 'EN-03', fullScaleM: 2.0 })), Array(30).fill(88), 1).at(-1)!;
    const st = interp.evaluate(10, 0);
    const before = { ...st.statusCounts };
    applyHardwarePacket(st, interp, p);
    const S = st.sensors[interp.sensorIndex.get('EN-03')!];
    expect(S.capacityPct).toBeCloseTo(p.capacityPct, 9);
    expect(markerTone(S)).toBe('alarm');
    const ci = interp.conduitIndex.get(alarmConduitId(S.sensor)!)!;
    expect(st.conduits.capacity[ci]).toBeCloseTo(p.capacityPct / 100, 9);
    expect(STATUSES[st.conduits.status[ci]]).toBe('CRITICAL');
    expect(Object.values(st.statusCounts).reduce((a, b) => a + b)).toBe(Object.values(before).reduce((a, b) => a + b));
    expect(st.sensors[interp.sensorIndex.get('EN-04')!].capacityPct).toBeLessThan(50);       // rest of the map untouched
  });
  it('full-catchment mode inverts the fullness to a catchment rainfall', () => {
    const lo = invertRainForSensor(interp, 'EN-01', 30, 0);
    const hi = invertRainForSensor(interp, 'EN-01', 90, 0);
    expect(hi).toBeGreaterThan(lo);
    expect(Math.abs(interp.evaluate(hi, 0).sensors[interp.sensorIndex.get('EN-01')!].capacityPct - 90)).toBeLessThan(4);
  });
  it('posts the serial-bridge JSON shape with scope to /api/v1/ingest/lorawan', () => {
    const p = drive(new HardwareRig(cfg({ scope: 'full_catchment' })), [40, 41], 1)[1];
    expect(ingestBody(p)).toMatchObject({ device_eui: 'EN-08', payload_hex: p.payloadHex, scope: 'full_catchment', bench_demo: true });
  });
  it('turns a Wi-Fi uplink in a backend frame into a rig packet, and only that', () => {
    const sensor = { sensor_id: 'EN-08', device_eui: '02BA6C1000000008', origin: 'HARDWARE', transport: 'WIFI', dist_mm: 90, h_over_d: 0.91,
      kalman_filtered_depth_mm: 1820, raw_unfiltered_depth_mm: 1830, dh_dt_mm_min: 2, sigma_d2_mm2: 1.5, turbulence_index: 0.9, capacity_pct: 91,
      anomaly_class: 'TRASH_BLOCKAGE', anomaly_code: 2, payload_hex: '0x5B0088AC', payload_uint32: 0x5b0088ac, vbat_v: 4.04, temperature_c: 20, raw_burst_mm: [90] } as unknown as LiveSensor;
    const frame = { sensors: { 'EN-08': sensor }, hardware_override: { sensor_id: 'EN-08', age_s: 1.5, scope: 'single_node' as const } };
    const p = wifiPacketFromFrame(frame, 10_000)!;
    expect(p).toMatchObject({ origin: 'WIFI_NODE', sensorId: 'EN-08', ts: 8_500, capacityPct: 91, distanceMm: 90, scope: 'single_node' });
    expect(p.fillPct).toBeCloseTo(91, 9);
    expect(rigLabel(p)).toBe('Wi-Fi ESP32-S3 node');
    // the aquarium simulator also posts to the backend: its echo must not pose as a physical board
    expect(wifiPacketFromFrame({ ...frame, sensors: { 'EN-08': { ...sensor, transport: null } } }, 10_000)).toBeNull();
    expect(wifiPacketFromFrame({ ...frame, hardware_override: null }, 10_000)).toBeNull();
  });
  it('status lines from the sketch never parse as distances', () => {
    for (const line of ['LINK_STATUS:WIFI_UP ip=192.168.0.77 rssi=-55 http=200 ok=120 fail=0', 'LINK_STATUS:WIFI_DOWN wifi_status=1 ssid=Lab',
      'SENSOR_FAULT:NO_ECHO check TRIG, ECHO and HC-SR04 power', '# PC unreachable: check SERVER_IP, that npm start is running, and that both are on one network']) {
      expect(parseSerialLine(line)).toBeNull();
    }
  });
  it('raises the map banner at >= 80 % full', () => {
    const p = drive(new HardwareRig(cfg()), Array(30).fill(85), 0.6).at(-1)!;
    expect(hardwareBannerText(p)).toEqual({ alarm: true, text: `LIVE SENSOR ALERT — EN-08 AT ${Math.round(p.capacityPct)}% CAPACITY` });
    expect(hardwareBannerText({ ...p, capacityPct: 40, anomaly: 'NORMAL' }).alarm).toBe(false);
  });
  it('routes /?view=hardware-sim and /hardware-sim to the companion page', () => {
    expect(isHardwareSimRoute({ search: '?view=hardware-sim&sensor=EN-04', pathname: '/' })).toBe(true);
    expect(isHardwareSimRoute({ search: '', pathname: '/hardware-sim' })).toBe(true);
    expect(isHardwareSimRoute({ search: '?mode=sim', pathname: '/' })).toBe(false);
  });
});
