// Phase 8: official LGU analytics PDF (strict typography) + telemetry recorder + rig alarm path.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LutFile, NetworkFile } from '../../src/types/twin';
import { LutInterpolator } from '../../src/utils/lutInterpolator';
import { arbitrate } from '../../src/utils/fusion';
import { STGNNForecaster, STEPS, type PrecipLibrary } from '../../src/forecast/stgnn';
import { TelemetryRecorder, RECORDER_CAPACITY } from '../../src/utils/telemetryRecorder';
import { REPORT_FONT_FAMILY, REPORT_FONT_PT, helveticaWidth, sanitizePdfText, wrapText } from '../../src/utils/reportSurface';
import { AGENCIES, REPORT_FILENAME, buildReportData, executiveSummary, generatePdfReport, reportDateParts, type ReportData } from '../../src/utils/pdfReportGenerator';
import { BASELINE_WEATHER } from '../../src/live/weather';
import { HardwareRig, parseSerialLine } from '../../src/live/serialRig';
import { applyHardwarePacket, openSyncBus, type HardwarePacket } from '../../src/live/hardwareSync';
import { alarmConduitId, markerTone } from '../../src/utils/fullness';

const read = <T,>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
const network = read<NetworkFile>('public/data/city_camp_network.json');
const lut = read<LutFile>('public/data/simulation_lut.json');
const library = read<PrecipLibrary>('public/data/precip_library.json');
const interp = LutInterpolator.fromFiles(network, lut);
const forecaster = new STGNNForecaster(network, library, lut.meta.tunnel_conveyance_limit_cms);

function rig(sensorId = 'EN-08', fullScaleM = 2.0) {
  return new HardwareRig({ sensorId, deviceEui: '02BA6C1000000008', fullScaleM, tankHeightMm: 300, scope: 'single_node', origin: 'WEB_SERIAL' });
}

function makeReport(rain: number, clog: number, hw: HardwarePacket | null = null): ReportData {
  const rec = new TelemetryRecorder();
  let st = interp.evaluate(rain, clog);
  for (let k = 0; k < 70; k++) {
    st = interp.evaluate(rain * (0.6 + (0.4 * k) / 69), clog);
    rec.record(st, network, 'EN-08', null, 1_700_000_000_000 + k * 2000);
  }
  st = interp.evaluate(rain, clog);
  const refPct = Object.fromEntries(st.sensors.map((S) => [S.id, S.capacityPct]));
  if (hw) applyHardwarePacket(st, interp, hw);
  const fc = forecaster.forecast({
    rain_mm_hr: Array(STEPS + 1).fill(rain),
    persist_rain_mm_hr: rain,
    blockage_pct: clog,
    lagoon_depth_m: st.lagoon.depthM,
    conduit_flow_cms: Array.from(st.conduits.flow),
    conduit_velocity_ms: Array.from(st.conduits.velocity),
    conduit_capacity: Array.from(st.conduits.capacity),
    sensor_capacity_pct: Object.fromEntries(st.sensors.map((S) => [S.id, S.capacityPct])),
    sensor_reference_pct: refPct,
    source: { kind: 'TWIN', label: 'test' },
  });
  return buildReportData({
    state: st,
    network,
    forecast: fc,
    fusion: arbitrate(st),
    weather: { ...BASELINE_WEATHER, rainMmHr: 12.4, temperatureC: 18.6, label: 'Heavy: Monsoon — Shower', source: 'OPEN_METEO' },
    modeLabel: 'Live Weather: and Telemetry',
    driverLabel: 'Pitch — Monsoon Surge -- test',
    history: rec.snapshots(),
    peaks: rec.peaks(),
    hardware: hw,
    now: new Date(Date.UTC(2026, 9, 29, 6, 30)),
  });
}

const latin1 = (b: Uint8Array) => Array.from(b, (x) => String.fromCharCode(x)).join('');

describe('sanitizePdfText (zero colons, zero em dashes, zero double hyphens)', () => {
  it('rewrites the forbidden punctuation', () => {
    expect(sanitizePdfText('Water Depth: 2.73 m')).toBe('Water Depth 2.73 m');
    expect(sanitizePdfText('Time 14:30')).toBe('Time 1430');
    expect(sanitizePdfText('rack — choke')).toBe('rack choke');
    expect(sanitizePdfText('a--b---c')).toBe('a-b-c');
    expect(sanitizePdfText('₱180 Million')).toBe('PHP 180 Million');
    expect(sanitizePdfText('σ² ≥ 80 %')).toBe('sigma ² >= 80 %');
    for (const s of ['::', 'x:y', 'a—b', 'a —— b', '-- --', 'http://x']) {
      const t = sanitizePdfText(s);
      expect(t.includes(':') || t.includes('—') || t.includes('--')).toBe(false);
    }
  });
  it('formats report times as HHMM HRS', () => {
    expect(reportDateParts(new Date(Date.UTC(2026, 9, 29, 6, 30)))).toEqual({ date: '29 October 2026', time: '1430 HRS PHT' });
  });
  it('wraps at 10 pt Helvetica', () => {
    const lines = wrapText('City Camp Lagoon holds water against the 1433.0 m overflow rim '.repeat(6), 300);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(helveticaWidth(l)).toBeLessThanOrEqual(300);
  });
});

describe('official LGU analytics PDF', () => {
  const hw = (() => {
    const r = rig();
    let p: HardwarePacket | null = null;
    for (let k = 0; k < 40; k++) p = r.ingestReading(parseSerialLine('FILL_PCT:86')!, k * 100);
    return p!;
  })();
  const data = makeReport(100, 50, hw);
  const rep = generatePdfReport(data);
  const pdf = latin1(rep.bytes);

  it('is a valid multi-page A4 PDF with a correct xref', () => {
    expect(pdf.startsWith('%PDF-1.')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(rep.pages).toBeGreaterThanOrEqual(2);
    expect((pdf.match(/\/Type \/Page /g) ?? []).length).toBe(rep.pages);
    const startxref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    expect(pdf).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(REPORT_FILENAME).toBe('Baguio_City_Camp_Drainage_Analytics_Report.pdf');
  });

  it('uses exactly one font family and one font size for every glyph', () => {
    expect(rep.fontOps.length).toBe(rep.textLog.length);
    expect(new Set(rep.fontOps)).toEqual(new Set([`/F1 ${REPORT_FONT_PT} Tf`]));
    const tf = [...pdf.matchAll(/\/(\w+) ([\d.]+) Tf/g)];
    expect(tf.length).toBe(rep.textLog.length);
    expect(new Set(tf.map((m) => `${m[1]} ${m[2]}`))).toEqual(new Set(['F1 10']));
    const fonts = [...pdf.matchAll(/\/BaseFont \/(\w+)/g)].map((m) => m[1]);
    expect(fonts).toEqual([REPORT_FONT_FAMILY]);
    expect((pdf.match(/\/Type \/Font/g) ?? []).length).toBe(1);
  });

  it('contains zero colons, zero em dashes and zero double hyphens anywhere', () => {
    for (const t of rep.textLog) expect(!t.includes(':') && !t.includes('—') && !t.includes('--'), t).toBe(true);
    expect(pdf.includes(':')).toBe(false);
    expect(pdf.includes('—')).toBe(false);
    expect(pdf.includes('--')).toBe(false);
    // the inputs deliberately carried colons and dashes; they were rewritten, not dropped
    expect(rep.textLog.some((t) => t.includes('Heavy Monsoon Shower'))).toBe(true);
  });

  it('carries the agency header, summary, four charts and the 10-node audit table', () => {
    const all = rep.textLog.join(' ');
    expect(AGENCIES).toHaveLength(4);
    for (const s of ['City Government of Baguio', 'CDRRMO', 'CEPMO', 'DPWH Baguio City District Engineering Office']) expect(all).toContain(s);
    expect(all).toContain('Executive Summary');
    for (const k of [1, 2, 3, 4]) expect(all).toContain(`Chart ${k}`);
    for (let i = 1; i <= 10; i++) expect(all).toContain(`EN-${String(i).padStart(2, '0')}`);
    for (const r of data.sensors) expect(rep.textLog).toContain(r.payloadHex);
    expect(all).toContain('Overflow rim 1433.0 m');
    expect(all).toContain('Basin floor 1426.5 m');
    expect(all).toContain('PHP 180 million');
    expect(all).toContain('Live hardware sensor alert, EN-08 reads');
    expect(all).toContain('1430 HRS PHT');
    expect(data.conduitGroups.map((g) => g.count)).toEqual([35, 25, 3]);
  });

  it('distinguishes rack occlusion from rock-choke backwater in the summary', () => {
    const choke = executiveSummary(makeReport(25, 0)).join(' ');
    expect(choke).toContain('unfinished rock tunnel choke');
    expect(choke).toContain('rack clearing crew should not be dispatched');
    const rack = makeReport(150, 95);
    expect(executiveSummary(rack).join(' ')).toMatch(/trash rack|lagoon above its rim/);
  });
});

describe('telemetry recorder', () => {
  it('keeps the last 60 snapshots and session peaks', () => {
    const rec = new TelemetryRecorder();
    for (let k = 0; k < 75; k++) rec.record(interp.evaluate(k < 10 ? 200 : 25, 0), network, 'EN-08', null, k * 1000);
    const snaps = rec.snapshots();
    expect(snaps).toHaveLength(RECORDER_CAPACITY);
    expect(snaps[0].t).toBe(15_000);
    expect(rec.peaks()['EN-03']).toBeGreaterThan(snaps.at(-1)!.capacities['EN-03']);
    expect(snaps.every((s) => s.edgeSource === 'VIRTUAL_PROBE')).toBe(true);
    // in the steady stretch after the 200 -> 25 mm/h step the Kalman output is far smoother than
    // the splashy raw signal
    const steady = snaps.slice(-30);
    const diffs = (xs: number[]) => xs.slice(1).reduce((a, x, i) => a + Math.abs(x - xs[i]), 0);
    expect(diffs(steady.map((s) => s.kalmanDepthMm))).toBeLessThan(diffs(steady.map((s) => s.rawDepthMm)) / 2);
  });
  it('prefers a live edge source over the virtual probe', () => {
    const rec = new TelemetryRecorder();
    const s = rec.record(interp.evaluate(25, 0), network, 'EN-08', { sensor: 'EN-08', source: 'HARDWARE_RIG', rawDepthMm: 1200, kalmanDepthMm: 1180 });
    expect(s).toMatchObject({ edgeSource: 'HARDWARE_RIG', rawDepthMm: 1200, kalmanDepthMm: 1180 });
  });
});

describe('USB serial lines -> BroadcastChannel -> 3 Hz red alarm on the targeted sensor', () => {
  const deliver = async (lines: string[]) => {
    const r = rig();
    const a = openSyncBus();
    const b = openSyncBus();
    const got: HardwarePacket[] = [];
    b.subscribe((m) => m.type === 'telemetry' && got.push(m));
    lines.forEach((l, k) => {
      const reading = parseSerialLine(l);
      const p = reading && r.ingestReading(reading, k * 100);
      if (p) a.publish(p);
    });
    await new Promise((res) => setTimeout(res, 30));
    a.close();
    b.close();
    return got;
  };
  const alarmed = (p: HardwarePacket) => {
    const st = interp.evaluate(0, 0);
    applyHardwarePacket(st, interp, p);
    const S = st.sensors[interp.sensorIndex.get(p.sensorId)!];
    return { tone: markerTone(S), conduit: alarmConduitId(S.sensor) };
  };

  it('FILL_PCT lines at 88 % turn EN-08 red', async () => {
    const got = await deliver(Array(30).fill('FILL_PCT:88'));
    expect(got.length).toBe(30);
    expect(alarmed(got.at(-1)!)).toEqual({ tone: 'alarm', conduit: 'TUN-C01' });
  });
  it('DIST_MM lines from a 300 mm tank (40 mm air gap) turn EN-08 red', async () => {
    const got = await deliver(Array(30).fill('DIST_MM:40'));
    expect(got.at(-1)!.capacityPct).toBeGreaterThan(100);
    expect(alarmed(got.at(-1)!).tone).toBe('alarm');
  });
  it('universal-sketch [EDGE_TX] frames win over their duplicate DIST_MM lines', async () => {
    const frame = '[EDGE_TX] {"device_eui":"EN-08","dist_mm":95,"fill_pct":92.3,"payload_hex":"0x4A3E2E0D","anomaly_class":"NORMAL"}';
    const got = await deliver([frame, 'DIST_MM:95', frame, 'DIST_MM:95']);
    expect(got).toHaveLength(2);
    expect(got.every((p) => p.payloadHex === '0x4A3E2E0D' && Math.abs(p.fillPct - 92.3) < 1e-9)).toBe(true);
    expect(alarmed(got[1]).tone).toBe('alarm');
  });
  it('stays green below 45 %', async () => {
    const got = await deliver(Array(30).fill('FILL_PCT:30'));
    expect(alarmed(got.at(-1)!).tone).toBe('normal');
  });
});
