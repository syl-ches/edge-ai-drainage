// Phase 8: official LGU analytics report (A4, multi-page) for the City Camp Lagoon twin.
// Typography rules, enforced by ReportSurface + tests/frontend/report.test.ts:
//   * one font family (Helvetica, normal) and one size (10 pt) for every glyph;
//   * zero colons, zero em dashes, zero double hyphens (sanitizePdfText on every string);
//   * hierarchy only from boxes, fills, rules, whitespace and emerald / slate accents.
// Charts and the four agency emblems are vector graphics (crisp at any zoom). The emblems are
// stylised procedural placeholders, not official seals.
import type { FusionVerdict } from '../types/live';
import type { ConduitStatus, NetworkFile, Sensor } from '../types/twin';
import type { Forecast } from '../forecast/stgnn';
import type { HardwarePacket } from '../live/hardwareSync';
import type { WeatherNow } from '../live/weather';
import { STATUSES, type TwinState } from './lutInterpolator';
import { ALARM_PCT, ELEVATED_PCT, nodeDepthM, nodeFullnessPct } from './fullness';
import type { TelemetrySnapshot } from './telemetryRecorder';
import {
  A4_H,
  A4_W,
  PdfSurface,
  fitText,
  sanitizePdfText,
  wrapText,
  type Align,
  type RGB,
  type ReportSurface,
} from './reportSurface';

export const REPORT_FILENAME = 'Baguio_City_Camp_Drainage_Analytics_Report.pdf';
export const REPORT_TITLE = 'City Camp Lagoon Drainage Analytics Report';

const M = 36; // page margin, pt
const CW = A4_W - 2 * M; // content width
const LH = 13; // line height for 10 pt text
const FOOTER_Y = A4_H - 30;
const C = {
  ink: [15, 23, 42] as RGB,
  slate: [71, 85, 105] as RGB,
  mist: [241, 245, 249] as RGB,
  rule: [203, 213, 225] as RGB,
  white: [255, 255, 255] as RGB,
  emerald: [5, 150, 105] as RGB,
  emeraldDeep: [6, 78, 59] as RGB,
  emeraldMist: [236, 253, 245] as RGB,
  amber: [217, 119, 6] as RGB,
  orange: [234, 88, 12] as RGB,
  crimson: [220, 38, 38] as RGB,
  sky: [2, 132, 199] as RGB,
  skyMist: [224, 242, 254] as RGB,
  navy: [30, 64, 175] as RGB,
};

// ---------------------------------------------------------------- data
export interface ReportSensorRow {
  id: string;
  name: string;
  structure: string;
  depthM: number;
  dhDtMmMin: number;
  pct: number;
  peakPct: number;
  anomaly: string;
  payloadHex: string;
}

export interface ConduitGroup {
  label: string;
  count: number;
  counts: Record<ConduitStatus, number>;
}

export interface ReportData {
  generatedAt: Date;
  modeLabel: string;
  driverLabel: string;
  weather: WeatherNow;
  rainMmHr: number;
  blockagePct: number;
  lagoon: { depthM: number; surfaceElevM: number; timeToOverflowMin: number | null; isOverflowing: boolean; control: string; headLossM: number; outflowCms: number };
  fusion: Pick<FusionVerdict, 'root_cause' | 'severity' | 'action' | 'confidence'>;
  visionBlockagePct: number;
  forecast: Forecast | null;
  sensors: ReportSensorRow[];
  conduitGroups: ConduitGroup[];
  history: TelemetrySnapshot[];
  hardware: { sensorId: string; pct: number; anomaly: string; origin: string } | null;
}

export interface ReportInputs {
  state: TwinState;
  network: NetworkFile;
  forecast: Forecast | null;
  fusion: FusionVerdict;
  weather: WeatherNow;
  modeLabel: string;
  driverLabel: string;
  history: TelemetrySnapshot[];
  peaks: Record<string, number>;
  hardware: HardwarePacket | null;
  now?: Date;
}

export function structureLabel(s: Sensor, network: NetworkFile): string {
  if (s.attached_kind === 'STORAGE') return `Lagoon ${network.lagoon.max_depth_m} m`;
  if (s.attached_kind === 'ORIFICE') {
    const r = network.orifices[0];
    return `Rack ${r.width_m.toFixed(1)}×${r.height_m.toFixed(1)} m`;
  }
  const c = network.conduits.find((x) => x.id === s.attached_to);
  if (!c) return s.attached_to;
  const g = c.geometry;
  if (c.shape === 'CIRCULAR') return `Pipe Ø${g.rise_m.toFixed(1)} m`;
  if (c.shape === 'ARCH') return `Arch ${g.span_m.toFixed(1)}×${g.rise_m.toFixed(1)} m`;
  return `Box ${g.span_m.toFixed(1)}×${g.rise_m.toFixed(1)} m`;
}

export function buildReportData(i: ReportInputs): ReportData {
  const st = i.state;
  const groups: [string, string][] = [
    ['RECT_CLOSED', 'Box culverts'],
    ['CIRCULAR', 'Circular pipes'],
    ['ARCH', 'Rock tunnel chokes'],
  ];
  const conduitGroups = groups.map(([shape, label]) => {
    const counts: Record<ConduitStatus, number> = { NORMAL: 0, ELEVATED: 0, CRITICAL: 0, SURCHARGED: 0 };
    let count = 0;
    i.network.conduits.forEach((c, k) => {
      if (c.shape !== shape) return;
      count++;
      counts[STATUSES[st.conduits.status[k]]]++;
    });
    return { label, count, counts };
  });
  const vision = st.sensors.find((s) => s.sensor.hardware === 'JETSON_YOLO_TRASHRACK');
  return {
    generatedAt: i.now ?? new Date(),
    modeLabel: i.modeLabel,
    driverLabel: i.driverLabel,
    weather: i.weather,
    rainMmHr: st.rain,
    blockagePct: st.blockagePct,
    lagoon: {
      depthM: st.lagoon.depthM,
      surfaceElevM: st.lagoon.surfaceElevM,
      timeToOverflowMin: st.lagoon.timeToOverflowMin,
      isOverflowing: st.lagoon.isOverflowing,
      control: st.lagoon.control,
      headLossM: st.lagoon.headLossM,
      outflowCms: st.lagoon.orificeFlowCms,
    },
    fusion: { root_cause: i.fusion.root_cause, severity: i.fusion.severity, action: i.fusion.action, confidence: i.fusion.confidence },
    visionBlockagePct: vision ? vision.capacityPct : st.blockagePct,
    forecast: i.forecast,
    sensors: st.sensors.map((S) => {
      const pct = nodeFullnessPct(S);
      return {
        id: S.id,
        name: S.sensor.name,
        structure: structureLabel(S.sensor, i.network),
        depthM: nodeDepthM(S),
        dhDtMmMin: S.dhDtMmMin,
        pct,
        peakPct: Math.max(i.peaks[S.id] ?? 0, pct),
        anomaly: S.anomaly,
        payloadHex: S.payloadHex,
      };
    }),
    conduitGroups,
    history: i.history,
    hardware: i.hardware
      ? { sensorId: i.hardware.sensorId, pct: Math.min(i.hardware.capacityPct, 127), anomaly: i.hardware.anomaly, origin: i.hardware.origin === 'WIFI_NODE' ? 'Wi-Fi ESP32-S3 node' : i.hardware.origin === 'WEB_SERIAL' ? 'USB Arduino or ESP32 board' : 'aquarium simulator' }
      : null,
  };
}

// ---------------------------------------------------------------- text helpers
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const tone = (pct: number): RGB => (pct >= ALARM_PCT ? C.crimson : pct >= ELEVATED_PCT ? C.amber : C.emerald);

export function reportDateParts(d: Date): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return { date, time: `${hm.replace(/\D/g, '')} HRS PHT` };
}

function overflowSentence(d: ReportData): string {
  if (d.lagoon.isOverflowing) return 'The bowl is overtopping the rim now and street flooding around the lagoon is under way.';
  const t = d.forecast?.time_to_overflow_min ?? d.lagoon.timeToOverflowMin;
  if (t === null || t === undefined) return 'No overflow is expected within 12 hours if the current rainfall persists.';
  return `If the current rainfall persists the rim is reached in about ${t < 90 ? `${Math.round(t)} minutes` : `${f1(t / 60)} hours`}.`;
}

function fusionSentence(d: ReportData): string {
  const conf = `${Math.round(d.fusion.confidence * 100)} % confidence`;
  switch (d.fusion.root_cause) {
    case 'CONFIRMED_TRASH_RACK_OCCLUSION':
      return `Multi-sensor fusion confirms trash rack occlusion (${conf}). The EN-08 ultrasonic ponding signature is corroborated by EN-09 vision at ${Math.round(d.visionBlockagePct)} % blockage, so the intake rack should be cleared.`;
    case 'DOWNSTREAM_ROCK_CHOKE_BACKWATER':
      return `Multi-sensor fusion attributes the ponding at the intake to backwater from the downstream 1.5 m × 1.7 m unfinished rock tunnel choke, not to trash rack occlusion (${conf}). EN-09 vision shows a clear rack, so the rack clearing crew should not be dispatched.`;
    case 'INTAKE_SURCHARGE_OVERFLOW':
      return `Multi-sensor fusion reports an intake surcharge with the lagoon above its rim (${conf}). Activate the CDRRMO evacuation advisory for City Camp Proper and City Camp Central.`;
    case 'DEBRIS_ACCUMULATING_NO_BACKWATER':
      return `Multi-sensor fusion sees debris building on the trash rack (EN-09 at ${Math.round(d.visionBlockagePct)} %) without hydraulic backwater yet (${conf}). Schedule clearing before the next rain band.`;
    default:
      return `Multi-sensor fusion finds all intake sensors consistent with normal operation (${conf}).`;
  }
}

function controlSentence(d: ReportData): string {
  if (d.lagoon.control === 'TUNNEL_CHOKE')
    return `Lagoon outflow is ${f2(d.lagoon.outflowCms)} m³/s and is governed by the unfinished 1.5 m × 1.7 m rock choke, whose free-surface capacity is 4.44 m³/s.`;
  if (d.lagoon.control === 'TRASH_RACK')
    return `Lagoon outflow is ${f2(d.lagoon.outflowCms)} m³/s and is governed by the trash rack orifice, which at ${Math.round(d.blockagePct)} % blockage adds ${f2(d.lagoon.headLossM)} m of Kirschmer head loss.`;
  return 'The lagoon is at its permanent pool, below the trash rack sill, so there is no outflow through the tunnel.';
}

export function executiveSummary(d: ReportData): string[] {
  const w = d.weather;
  const paras: string[] = [];
  paras.push(
    `Baguio City weather ${w.label}, ${f1(w.rainMmHr)} mm/h rainfall${w.temperatureC !== null ? ` and ${f1(w.temperatureC)} °C` : ''} (${w.source === 'OPEN_METEO' ? 'Open-Meteo live reading' : w.source === 'CACHED' ? 'last synced Open-Meteo reading' : 'offline baseline'}). The twin runs in ${d.modeLabel} mode, driven by ${d.driverLabel} at ${f1(d.rainMmHr)} mm/h with the trash rack ${Math.round(d.blockagePct)} % blocked.`,
  );
  paras.push(
    `City Camp Lagoon holds ${f2(d.lagoon.depthM)} m of water, a surface elevation of ${f2(d.lagoon.surfaceElevM)} m ASL against the 1433.0 m overflow rim (${Math.round((d.lagoon.depthM / 6.5) * 100)} % of the 6.5 m bowl). ${overflowSentence(d)} ${controlSentence(d)}`,
  );
  paras.push(fusionSentence(d));
  const fc = d.forecast;
  if (fc && fc.horizons.length === 3) {
    const [h15, h30, h60] = fc.horizons;
    paras.push(
      `The ST-GNN forecast, a physics informed graph model with no trained weights, projects a lagoon depth of ${f2(h15.lagoon_depth_m)} m at plus 15 minutes, ${f2(h30.lagoon_depth_m)} m at plus 30 minutes and ${f2(h60.lagoon_depth_m)} m at plus 60 minutes (90 % band ${f2(h60.lagoon_depth_p05_m)} to ${f2(h60.lagoon_depth_p95_m)} m). Surcharge probability at plus 60 minutes is ${Math.round(h60.surcharge_probability_pct)} % and the next critical bottleneck is ${h60.next_bottleneck.sensor_id} at ${Math.round(h60.next_bottleneck.capacity_pct)} % full.`,
    );
  }
  const alarmed = d.sensors.filter((s) => s.pct >= ALARM_PCT && s.id !== 'EN-09');
  const hw = d.hardware;
  paras.push(
    (hw
      ? `Live hardware sensor alert, ${hw.sensorId} reads ${Math.round(hw.pct)} % full from the ${hw.origin} (${hw.anomaly.replace(/_/g, ' ').toLowerCase()}). `
      : 'No live hardware sensor is connected for this report. ') +
      (alarmed.length
        ? `${alarmed.length} of 10 Edge-AI nodes are at or above the 80 % alarm threshold (${alarmed.map((s) => s.id).join(', ')}) and blink red on the 3D map.`
        : 'No Edge-AI node is at or above the 80 % alarm threshold.'),
  );
  paras.push(
    'These findings support the DPWH Baguio City District Engineering Office City Camp underdrainage rehabilitation project (PHP 180 million, as cited in the project brief). In this model the unfinished 1.5 m × 1.7 m rock tunnel section, not the trash rack, limits lagoon outflow until rack blockage passes about 90 %, which strengthens the case for completing that section.',
  );
  paras.push(
    'Network geometry in this twin is synthetic and not an as-built survey, and forecasts are model outputs rather than official warnings. Always follow PAGASA and Baguio CDRRMO advisories.',
  );
  return paras.map(sanitizePdfText);
}

// ---------------------------------------------------------------- emblems (procedural vectors)
type P = [number, number];

function shield(cx: number, cy: number, w: number, h: number): P[] {
  const pts: P[] = [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
  ];
  for (let k = 0; k <= 12; k++) {
    const t = k / 12;
    pts.push([cx + (w / 2) * (1 - t * t), cy - h / 2 + h * 0.45 + h * 0.55 * t]);
  }
  for (let k = 11; k >= 0; k--) {
    const t = k / 12;
    pts.push([cx - (w / 2) * (1 - t * t), cy - h / 2 + h * 0.45 + h * 0.55 * t]);
  }
  return pts;
}

function emblemCity(s: ReportSurface, cx: number, cy: number, r: number) {
  s.fill(C.emeraldDeep);
  s.circle(cx, cy, r, 'f');
  s.stroke(C.white);
  s.lineWidth(1.2);
  s.circle(cx, cy, r * 0.84, 's');
  s.fill(C.emeraldMist);
  s.circle(cx, cy, r * 0.74, 'f');
  s.fill([132, 204, 22]);
  s.polygon([[cx - r * 0.72, cy + r * 0.3], [cx - r * 0.3, cy - r * 0.15], [cx, cy + r * 0.1], [cx + r * 0.35, cy - r * 0.25], [cx + r * 0.72, cy + r * 0.3]], 'f');
  s.fill(C.emeraldDeep);
  for (const [k, wf] of [[0, 0.32], [1, 0.26], [2, 0.18]] as const) {
    const top = cy - r * 0.6 + k * r * 0.2;
    s.polygon([[cx, top], [cx - r * wf, top + r * 0.32], [cx + r * wf, top + r * 0.32]], 'f');
  }
  s.fill([120, 53, 15]);
  s.rect(cx - r * 0.05, cy + r * 0.24, r * 0.1, r * 0.16, 'f');
  s.fill(C.amber);
  s.circle(cx + r * 0.42, cy - r * 0.42, r * 0.1, 'f');
}

function emblemCdrrmo(s: ReportSurface, cx: number, cy: number, r: number) {
  s.fill(C.navy);
  s.circle(cx, cy, r, 'f');
  s.fill(C.orange);
  s.polygon(shield(cx, cy + r * 0.02, r * 1.2, r * 1.3), 'f');
  s.fill(C.white);
  s.polygon([[cx, cy - r * 0.42], [cx - r * 0.42, cy + r * 0.3], [cx + r * 0.42, cy + r * 0.3]], 'f');
  s.fill(C.orange);
  s.rect(cx - r * 0.05, cy - r * 0.18, r * 0.1, r * 0.28, 'f');
  s.circle(cx, cy + r * 0.2, r * 0.055, 'f');
  s.stroke(C.white);
  s.lineWidth(1);
  s.circle(cx, cy, r * 0.93, 's');
}

function emblemCepmo(s: ReportSurface, cx: number, cy: number, r: number) {
  const teeth = 12;
  const pts: P[] = [];
  for (let k = 0; k < teeth * 2; k++) {
    const a0 = (k / (teeth * 2)) * Math.PI * 2;
    const rr = k % 2 === 0 ? r : r * 0.84;
    pts.push([cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr]);
    const a1 = ((k + 0.5) / (teeth * 2)) * Math.PI * 2;
    pts.push([cx + Math.cos(a1) * rr, cy + Math.sin(a1) * rr]);
  }
  s.fill([51, 65, 85]);
  s.polygon(pts, 'f');
  s.fill(C.sky);
  s.circle(cx, cy, r * 0.68, 'f');
  s.fill(C.white);
  s.rect(cx - r * 0.38, cy - r * 0.3, r * 0.2, r * 0.38, 'f');
  s.rect(cx - r * 0.12, cy - r * 0.44, r * 0.22, r * 0.52, 'f');
  s.rect(cx + r * 0.16, cy - r * 0.22, r * 0.2, r * 0.3, 'f');
  s.stroke(C.white);
  s.lineWidth(1.4);
  for (const dy of [0.2, 0.36]) {
    const wave: P[] = [];
    for (let k = 0; k <= 16; k++) {
      const x = cx - r * 0.5 + (k / 16) * r;
      wave.push([x, cy + r * dy + Math.sin(k * 0.9) * r * 0.04]);
    }
    s.polygon(wave, 's', false);
  }
}

function emblemDpwh(s: ReportSurface, cx: number, cy: number, r: number) {
  s.fill(C.navy);
  s.polygon(shield(cx, cy, r * 1.7, r * 1.95), 'f');
  s.stroke(C.amber);
  s.lineWidth(1.4);
  s.polygon(shield(cx, cy, r * 1.5, r * 1.75), 's');
  s.stroke(C.white);
  s.lineWidth(1.6);
  const arch: P[] = [];
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    arch.push([cx - r * 0.55 + t * r * 1.1, cy + r * 0.12 - Math.sin(t * Math.PI) * r * 0.4]);
  }
  s.polygon(arch, 's', false);
  s.line(cx - r * 0.62, cy + r * 0.12, cx + r * 0.62, cy + r * 0.12);
  for (const fx of [-0.35, 0, 0.35]) s.line(cx + r * fx, cy + r * 0.12, cx + r * fx, cy - r * (0.12 + 0.28 * (1 - Math.abs(fx) * 1.6)));
  s.fill(C.white);
  s.rect(cx - r * 0.5, cy + r * 0.3, r, r * 0.08, 'f');
}

export const AGENCIES: { lines: string; draw: (s: ReportSurface, cx: number, cy: number, r: number) => void }[] = [
  { lines: 'Republic of the Philippines • City Government of Baguio', draw: emblemCity },
  { lines: 'Baguio CDRRMO • City Disaster Risk Reduction and Management Office', draw: emblemCdrrmo },
  { lines: 'Baguio CEPMO and City Engineering Office', draw: emblemCepmo },
  { lines: 'DPWH Baguio City District Engineering Office', draw: emblemDpwh },
];

// ---------------------------------------------------------------- layout primitives
class Layout {
  y = M;
  constructor(readonly s: ReportSurface) {}
  ensure(h: number) {
    if (this.y + h > FOOTER_Y - 14) {
      this.s.addPage();
      this.y = M;
    }
  }
  /** `keep` = height of the block that must stay on the same page as the heading */
  heading(t: string, keep = 40) {
    this.ensure(26 + keep);
    const s = this.s;
    s.fill(C.ink);
    s.rect(M, this.y, CW, 18, 'f');
    s.fill(C.emerald);
    s.rect(M, this.y, 4, 18, 'f');
    s.textColor(C.white);
    s.text(M + 12, this.y + 12.5, t);
    this.y += 26;
  }
  para(t: string, indent = 0, color: RGB = C.ink) {
    const lines = wrapText(t, CW - indent - 16);
    this.ensure(lines.length * LH + 4);
    this.s.textColor(color);
    for (const ln of lines) {
      this.s.text(M + 8 + indent, this.y + 9, ln);
      this.y += LH;
    }
    this.y += 4;
  }
}

function text(s: ReportSurface, x: number, y: number, t: string, color: RGB = C.ink, align: Align = 'left') {
  s.textColor(color);
  s.text(x, y, t, align);
}

function legend(s: ReportSurface, x: number, y: number, items: [RGB, string, 'box' | 'line' | 'dash'][]) {
  let cx = x;
  for (const [c, label, kind] of items) {
    if (kind === 'box') {
      s.fill(c);
      s.rect(cx, y - 7, 10, 8, 'f');
    } else {
      s.stroke(c);
      s.lineWidth(2);
      if (kind === 'dash') s.dash(3, 2);
      s.line(cx, y - 3, cx + 12, y - 3);
      s.noDash();
    }
    text(s, cx + 15, y, label, C.slate);
    cx += 22 + s.textWidth(label) + 10;
  }
}

/** Text on a white plate so it stays legible over chart lines. */
function plateText(s: ReportSurface, x: number, y: number, t: string, color: RGB) {
  const w = s.textWidth(t);
  s.fill(C.white);
  s.rect(x - 2, y - 9, w + 4, 12, 'f');
  text(s, x, y, t, color);
}

function frame(s: ReportSurface, x: number, y: number, w: number, h: number) {
  s.fill(C.white);
  s.stroke(C.rule);
  s.lineWidth(0.8);
  s.rect(x, y, w, h, 'b');
}

// ---------------------------------------------------------------- page sections
function header(L: Layout, d: ReportData) {
  const s = L.s;
  const h = 128;
  s.fill(C.emeraldMist);
  s.rect(M, L.y, CW, h, 'f');
  s.fill(C.emerald);
  s.rect(M, L.y, CW, 3, 'f');
  const colW = CW / 4;
  AGENCIES.forEach((a, k) => {
    const cx = M + colW * k + colW / 2;
    a.draw(s, cx, L.y + 34, 22);
    const lines = wrapText(a.lines, colW - 12);
    lines.slice(0, 5).forEach((ln, i) => text(s, cx, L.y + 72 + i * 11.5, ln, C.ink, 'center'));
  });
  L.y += h + 8;
  s.fill(C.emeraldDeep);
  s.rect(M, L.y, CW, 22, 'f');
  text(s, M + 10, L.y + 14.5, REPORT_TITLE, C.white);
  text(s, M + CW - 10, L.y + 14.5, 'Baguio City Edge-AI Digital Twin', C.white, 'right');
  L.y += 30;
  const { date, time } = reportDateParts(d.generatedAt);
  const meta = [
    ['Report date', date],
    ['Time', time],
    ['Mode', d.modeLabel],
    ['Rainfall driver', d.driverLabel],
  ];
  const mw = CW / meta.length;
  s.fill(C.mist);
  s.rect(M, L.y, CW, 30, 'f');
  meta.forEach(([k, v], i) => {
    text(s, M + 8 + i * mw, L.y + 12, k, C.slate);
    text(s, M + 8 + i * mw, L.y + 25, fitText(v, mw - 14), C.ink);
  });
  L.y += 40;
}

function chartSensors(L: Layout, d: ReportData) {
  const s = L.s;
  const h = 210;
  L.ensure(h + 10);
  const x0 = M;
  const y0 = L.y;
  frame(s, x0, y0, CW, h);
  const px = x0 + 40;
  const py = y0 + 14;
  const pw = CW - 54;
  const ph = h - 64;
  const yOf = (v: number) => py + ph - (Math.min(v, 127) / 127) * ph;
  s.lineWidth(0.5);
  for (const v of [0, 25, 50, 75, 100, 125]) {
    s.stroke(C.rule);
    s.line(px, yOf(v), px + pw, yOf(v));
    text(s, px - 6, yOf(v) + 3.5, String(v), C.slate, 'right');
  }
  for (const [v, c] of [
    [ELEVATED_PCT, C.amber],
    [ALARM_PCT, C.crimson],
  ] as const) {
    s.stroke(c);
    s.lineWidth(1);
    s.dash(4, 3);
    s.line(px, yOf(v), px + pw, yOf(v));
    s.noDash();
  }
  const slot = pw / d.sensors.length;
  d.sensors.forEach((r, k) => {
    const cx = px + slot * k + slot / 2;
    const bw = slot * 0.3;
    s.fill(tone(r.pct));
    s.rect(cx - bw - 1, yOf(r.pct), bw, py + ph - yOf(r.pct), 'f');
    s.fill(C.white);
    s.stroke(tone(r.peakPct));
    s.lineWidth(1.2);
    s.rect(cx + 1, yOf(r.peakPct), bw, py + ph - yOf(r.peakPct), 'b');
    text(s, cx, yOf(Math.max(r.pct, r.peakPct)) - 4, String(Math.round(r.pct)), C.ink, 'center');
    text(s, cx, py + ph + 13, r.id, C.ink, 'center');
  });
  legend(s, px - 30, y0 + h - 12, [
    [C.emerald, 'Current fullness %', 'box'],
    [C.slate, 'Session peak % (outline)', 'line'],
    [C.amber, 'Elevated 45 %', 'dash'],
    [C.crimson, 'Alarm 80 % (blinks red)', 'dash'],
  ]);
  L.y += h + 10;
}

/** 1, 2, 2.5 or 5 x 10^k: round axis steps. */
export function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

function linePath(s: ReportSurface, pts: P[], c: RGB, w: number, dashed = false) {
  if (pts.length < 2) return;
  s.stroke(c);
  s.lineWidth(w);
  if (dashed) s.dash(4, 3);
  s.polygon(pts, 's', false);
  s.noDash();
}

function chartKalman(L: Layout, d: ReportData) {
  const s = L.s;
  const h = 200;
  L.ensure(h + 10);
  const y0 = L.y;
  frame(s, M, y0, CW, h);
  const hist = d.history;
  const px = M + 52;
  const py = y0 + 16;
  const pw = CW - 66;
  const ph = h - 64;
  if (hist.length < 2) {
    text(s, M + CW / 2, y0 + h / 2, 'Collecting session data, open the report again after a few seconds', C.slate, 'center');
    L.y += h + 10;
    return;
  }
  const vals = hist.flatMap((p) => [p.rawDepthMm, p.kalmanDepthMm]);
  const span = Math.max(Math.max(...vals) - Math.min(...vals), 20);
  const step = niceStep(span / 4);
  const lo = Math.max(Math.floor((Math.min(...vals) - span * 0.08) / step) * step, 0);
  const hi = Math.ceil((Math.max(...vals) + span * 0.08) / step) * step;
  const xOf = (k: number) => px + (k / (hist.length - 1)) * pw;
  const yOf = (v: number) => py + ph - ((v - lo) / (hi - lo)) * ph;
  s.lineWidth(0.5);
  for (let v = lo; v <= hi + 1e-9; v += step) {
    s.stroke(C.rule);
    s.line(px, yOf(v), px + pw, yOf(v));
    text(s, px - 6, yOf(v) + 3.5, String(Math.round(v)), C.slate, 'right');
  }
  linePath(s, hist.map((p, k) => [xOf(k), yOf(p.rawDepthMm)] as P), [148, 163, 184], 0.9);
  s.fill(C.orange);
  hist.forEach((p, k) => s.circle(xOf(k), yOf(p.rawDepthMm), 1.4, 'f'));
  linePath(s, hist.map((p, k) => [xOf(k), yOf(p.kalmanDepthMm)] as P), C.emerald, 2.2);
  const spanS = Math.round((hist[hist.length - 1].t - hist[0].t) / 1000);
  text(s, px, py + ph + 13, `${spanS} s ago`, C.slate);
  text(s, px + pw, py + ph + 13, 'Now', C.slate, 'right');
  text(s, px + pw / 2, py + ph + 13, 'Depth mm, last 60 snapshots', C.slate, 'center');
  const last = hist[hist.length - 1];
  const src = last.edgeSource === 'HARDWARE_RIG' ? 'live hardware rig' : last.edgeSource === 'BACKEND_EDGE' ? 'backend edge fleet' : 'in-browser virtual edge probe';
  legend(s, px, y0 + h - 12, [
    [C.orange, `Raw ultrasonic ${last.edgeSensor} (${src})`, 'line'],
    [C.emerald, 'On-device Kalman depth', 'line'],
  ]);
  L.y += h + 10;
}

function chartHydrograph(L: Layout, d: ReportData) {
  const s = L.s;
  const h = 214;
  L.ensure(h + 10);
  const y0 = L.y;
  frame(s, M, y0, CW, h);
  const px = M + 58;
  const py = y0 + 14;
  const pw = CW - 72;
  const ph = h - 66;
  const floor = 1426.5;
  const rim = 1433.0;
  const fc = d.forecast;
  const hist = d.history;
  const elevs = [d.lagoon.surfaceElevM, ...hist.map((p) => p.surfaceElevM), ...(fc ? fc.horizons.map((x) => x.surface_elev_p95_m) : [])];
  const top = Math.max(rim + 0.5, Math.max(...elevs) + 0.3);
  const yOf = (e: number) => py + ph - ((e - floor) / (top - floor)) * ph;
  const split = px + pw * 0.38; // history | forecast
  const xHist = (k: number) => px + (hist.length > 1 ? (k / (hist.length - 1)) * (split - px) : split - px);
  const xFc = (m: number) => split + (m / 60) * (px + pw - split);
  s.lineWidth(0.5);
  for (let e = Math.ceil(floor); e <= top; e += 1) {
    s.stroke(C.rule);
    s.line(px, yOf(e), px + pw, yOf(e));
    text(s, px - 6, yOf(e) + 3.5, `${e.toFixed(0)} m`, C.slate, 'right');
  }
  s.stroke(C.ink);
  s.lineWidth(1.2);
  s.line(px, yOf(floor), px + pw, yOf(floor));
  plateText(s, px + 4, yOf(floor) - 4, 'Basin floor 1426.5 m', C.slate);
  s.stroke(C.crimson);
  s.dash(5, 3);
  s.line(px, yOf(rim), px + pw, yOf(rim));
  s.noDash();
  // drawn after the curves (below) so it sits on top of them
  const rimLabel = () => plateText(s, split - s.textWidth('Overflow rim 1433.0 m (6.5 m depth)') - 8, yOf(rim) + 12, 'Overflow rim 1433.0 m (6.5 m depth)', C.crimson);
  s.stroke(C.slate);
  s.dash(2, 2);
  s.lineWidth(0.8);
  s.line(split, py, split, py + ph);
  s.noDash();
  if (hist.length) linePath(s, hist.map((p, k) => [xHist(k), yOf(p.surfaceElevM)] as P), C.sky, 2);
  if (fc) {
    const pts = [{ m: 0, c: d.lagoon.surfaceElevM, lo: d.lagoon.surfaceElevM, hi: d.lagoon.surfaceElevM }, ...fc.horizons.map((x) => ({ m: x.minutes, c: x.surface_elev_m, lo: x.surface_elev_p05_m, hi: x.surface_elev_p95_m }))];
    s.fill(C.skyMist);
    s.polygon([...pts.map((p) => [xFc(p.m), yOf(p.hi)] as P), ...pts.slice().reverse().map((p) => [xFc(p.m), yOf(p.lo)] as P)], 'f');
    linePath(s, pts.map((p) => [xFc(p.m), yOf(p.c)] as P), C.navy, 2, true);
    s.fill(C.navy);
    for (const p of pts) s.circle(xFc(p.m), yOf(p.c), 2.4, 'f');
    for (const p of pts.slice(1)) text(s, xFc(p.m), yOf(p.hi) - 6, p.c.toFixed(2), C.navy, 'center');
  } else {
    text(s, (split + px + pw) / 2, py + ph / 2, 'Forecast warming up', C.slate, 'center');
  }
  rimLabel();
  text(s, px, py + ph + 13, 'Session history', C.slate);
  for (const [m, lab] of [
    [0, 'Now'],
    [15, '+15m'],
    [30, '+30m'],
    [60, '+60m'],
  ] as const)
    text(s, xFc(m), py + ph + 13, lab, C.ink, m === 60 ? 'right' : 'center');
  legend(s, px, y0 + h - 12, [
    [C.sky, 'Recorded water surface', 'line'],
    [C.navy, 'ST-GNN forecast', 'dash'],
    [C.skyMist, '90 % band', 'box'],
  ]);
  L.y += h + 10;
}

const STATUS_COLORS: Record<ConduitStatus, RGB> = { NORMAL: C.emerald, ELEVATED: C.amber, CRITICAL: C.orange, SURCHARGED: C.crimson };

function chartConduits(L: Layout, d: ReportData) {
  const s = L.s;
  const h = 170;
  L.ensure(h + 10);
  const y0 = L.y;
  frame(s, M, y0, CW, h);
  const labelW = 150;
  const bx = M + labelW;
  const bw = CW * 0.62 - labelW;
  d.conduitGroups.forEach((g, k) => {
    const y = y0 + 18 + k * 34;
    text(s, M + 10, y + 13, `${g.label} (${g.count})`, C.ink);
    let x = bx;
    for (const st of STATUSES) {
      const n = g.counts[st];
      if (!n || !g.count) continue;
      const w = (n / g.count) * bw;
      s.fill(STATUS_COLORS[st]);
      s.rect(x, y, w, 18, 'f');
      const pct = `${Math.round((n / g.count) * 100)} %`;
      if (w > s.textWidth(pct) + 6) text(s, x + w / 2, y + 12.5, pct, C.white, 'center');
      x += w;
    }
  });
  const kx = M + CW * 0.66;
  s.fill(C.mist);
  s.rect(kx, y0 + 12, CW * 0.32, 104, 'f');
  const kv: [string, string][] = [
    ['Kirschmer rack head loss', `${d.lagoon.headLossM.toFixed(3)} m`],
    ['Trash rack blockage', `${Math.round(d.blockagePct)} %`],
    ['Lagoon outflow', `${f2(d.lagoon.outflowCms)} m³/s`],
    ['Governing bottleneck', d.lagoon.control === 'TUNNEL_CHOKE' ? 'Rock choke' : d.lagoon.control === 'TRASH_RACK' ? 'Trash rack' : 'None'],
  ];
  kv.forEach(([k, v], i) => {
    text(s, kx + 8, y0 + 28 + i * 24, k, C.slate);
    text(s, kx + 8, y0 + 40 + i * 24, v, C.ink);
  });
  legend(s, M + 10, y0 + h - 12, STATUSES.map((st) => [STATUS_COLORS[st], st.charAt(0) + st.slice(1).toLowerCase(), 'box'] as [RGB, string, 'box']));
  L.y += h + 10;
}

const COLS: { k: string; w: number; align?: Align }[] = [
  { k: 'Node', w: 40 },
  { k: 'Location', w: 84 },
  { k: 'Structure', w: 84 },
  { k: 'Depth m', w: 44, align: 'right' },
  { k: 'Rise mm/min', w: 60, align: 'right' },
  { k: 'Full %', w: 36, align: 'right' },
  { k: 'Status', w: 104 },
  { k: 'Payload', w: 71 },
];

function table(L: Layout, d: ReportData) {
  const s = L.s;
  const rowH = 18;
  L.ensure(rowH * (d.sensors.length + 1) + 10);
  let y = L.y;
  s.fill(C.ink);
  s.rect(M, y, CW, rowH, 'f');
  let x = M;
  for (const c of COLS) {
    text(s, c.align === 'right' ? x + c.w - 4 : x + 4, y + 12.5, c.k, C.white, c.align ?? 'left');
    x += c.w;
  }
  y += rowH;
  d.sensors.forEach((r, i) => {
    s.fill(i % 2 ? C.white : C.mist);
    s.rect(M, y, CW, rowH, 'f');
    const cells = [r.id, r.name, r.structure, f2(r.depthM), f1(r.dhDtMmMin), String(Math.round(r.pct)), r.anomaly.replace(/_/g, ' '), r.payloadHex];
    x = M;
    cells.forEach((v, k) => {
      const c = COLS[k];
      const color = k === 5 ? tone(r.pct) : k === 6 && r.anomaly !== 'NORMAL' ? C.crimson : C.ink;
      text(s, c.align === 'right' ? x + c.w - 4 : x + 4, y + 12.5, fitText(v, c.w - 8), color, c.align ?? 'left');
      x += c.w;
    });
    y += rowH;
  });
  s.stroke(C.rule);
  s.lineWidth(0.8);
  s.rect(M, L.y, CW, y - L.y, 's');
  L.y = y + 10;
  L.para('Payload is the 32-bit big-endian LoRaWAN uplink (depth 10 bits, rise rate 8 bits, fullness 7 bits, anomaly 3 bits, battery 4 bits). EN-09 reports visual trash rack blockage in its fullness field.', 0, C.slate);
}

function footer(s: ReportSurface, page: number, total: number) {
  s.stroke(C.rule);
  s.lineWidth(0.6);
  s.line(M, FOOTER_Y - 6, M + CW, FOOTER_Y - 6);
  text(s, M, FOOTER_Y + 6, 'City Camp Lagoon Edge-AI Digital Twin', C.slate);
  text(s, M + CW, FOOTER_Y + 6, `Page ${page} of ${total}`, C.slate, 'right');
  text(s, M, FOOTER_Y + 18, 'Synthetic network geometry. Emblems are stylised placeholders, not official agency seals.', C.slate);
}

/** Counts pages without drawing. */
class CountingSurface implements ReportSurface {
  pageCount = 1;
  addPage() {
    this.pageCount++;
  }
  fill() {}
  stroke() {}
  textColor() {}
  lineWidth() {}
  rect() {}
  line() {}
  polygon() {}
  circle() {}
  dash() {}
  noDash() {}
  text() {}
  textWidth(t: string) {
    return new PdfSurface().textWidth(t);
  }
}

export function countPages(d: ReportData): number {
  const c = new CountingSurface();
  renderReportBody(c, d);
  return c.pageCount;
}

/** Wraps a surface so a footer is drawn on each page as it is completed. */
class FooterSurface implements ReportSurface {
  private page = 1;
  constructor(
    private readonly inner: ReportSurface,
    private readonly total: number,
  ) {}
  get pageCount() {
    return this.inner.pageCount;
  }
  addPage() {
    footer(this.inner, this.page, this.total);
    this.inner.addPage();
    this.page++;
  }
  finish() {
    footer(this.inner, this.page, this.total);
  }
  fill(c: RGB) {
    this.inner.fill(c);
  }
  stroke(c: RGB) {
    this.inner.stroke(c);
  }
  textColor(c: RGB) {
    this.inner.textColor(c);
  }
  lineWidth(w: number) {
    this.inner.lineWidth(w);
  }
  rect(x: number, y: number, w: number, h: number, m: 'f' | 's' | 'b') {
    this.inner.rect(x, y, w, h, m);
  }
  line(a: number, b: number, c: number, e: number) {
    this.inner.line(a, b, c, e);
  }
  polygon(p: readonly (readonly [number, number])[], m: 'f' | 's' | 'b', close?: boolean) {
    this.inner.polygon(p, m, close);
  }
  circle(x: number, y: number, r: number, m: 'f' | 's' | 'b') {
    this.inner.circle(x, y, r, m);
  }
  dash(a: number, b: number) {
    this.inner.dash(a, b);
  }
  noDash() {
    this.inner.noDash();
  }
  text(x: number, y: number, t: string, a?: Align) {
    this.inner.text(x, y, t, a);
  }
  textWidth(t: string) {
    return this.inner.textWidth(t);
  }
}

/** Draw the full report (with page footers) onto a surface; returns the page count. */
export function drawReport(target: ReportSurface, d: ReportData): number {
  const total = countPages(d);
  const s = new FooterSurface(target, total);
  renderReportBody(s, d);
  s.finish();
  return total;
}

function renderReportBody(s: ReportSurface, d: ReportData) {
  const L = new Layout(s);
  header(L, d);
  L.heading('Executive Summary', 60);
  for (const p of executiveSummary(d)) L.para(p);
  L.heading('Chart 1 • Edge-AI sensor network fullness and anomaly state, EN-01 to EN-10', 220);
  chartSensors(L, d);
  L.heading('Chart 2 • On-device Kalman filter signal cleaning', 210);
  chartKalman(L, d);
  L.heading('Chart 3 • ST-GNN lagoon hydrograph and forecast trajectory', 224);
  chartHydrograph(L, d);
  L.heading('Chart 4 • Subsurface conduit capacity distribution and bottleneck breakdown', 180);
  chartConduits(L, d);
  L.heading('10-node telemetry and 32-bit payload audit', 210);
  table(L, d);
}

export interface PdfReport {
  bytes: Uint8Array;
  pages: number;
  /** every string drawn, post-sanitisation */
  textLog: string[];
  /** every font-selection operator */
  fontOps: string[];
}

export function generatePdfReport(d: ReportData): PdfReport {
  const pdf = new PdfSurface();
  const pages = drawReport(pdf, d);
  return { bytes: pdf.toBytes(REPORT_TITLE), pages, textLog: pdf.textLog, fontOps: pdf.fontOps };
}

/** Build the PDF in the browser and save it (no server involved). */
export function downloadPdfReport(d: ReportData): PdfReport {
  const rep = generatePdfReport(d);
  const blob = new Blob([rep.bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = REPORT_FILENAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return rep;
}
