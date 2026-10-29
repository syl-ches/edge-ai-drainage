// Phase 8: one drawing interface, two backends, so the Analytics modal preview and the
// downloadable PDF are the same layout.
//   PdfSurface    a dependency-free PDF 1.4 writer (vector graphics + the standard Helvetica
//                 font, WinAnsiEncoding, uncompressed streams).
//   CanvasSurface Canvas 2D, for the on-screen preview.
// Typography is enforced structurally: `text()` has no size or font parameter. Every glyph in
// the document is Helvetica (normal) at REPORT_FONT_PT, and every string goes through
// sanitizePdfText (no colons, no em dashes, no double hyphens).

export const REPORT_FONT_FAMILY = 'Helvetica';
export const REPORT_FONT_PT = 10;
export const A4_W = 595.28;
export const A4_H = 841.89;

export type RGB = readonly [number, number, number]; // 0..255
export type Align = 'left' | 'center' | 'right';

export interface ReportSurface {
  /** Start a new page (the first page exists implicitly). */
  addPage(): void;
  readonly pageCount: number;
  fill(c: RGB): void;
  stroke(c: RGB): void;
  textColor(c: RGB): void;
  lineWidth(w: number): void;
  /** mode: f fill, s stroke, b fill + stroke */
  rect(x: number, y: number, w: number, h: number, mode: 'f' | 's' | 'b'): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  polygon(pts: readonly (readonly [number, number])[], mode: 'f' | 's' | 'b', close?: boolean): void;
  circle(cx: number, cy: number, r: number, mode: 'f' | 's' | 'b'): void;
  dash(on: number, off: number): void;
  noDash(): void;
  /** y is the text baseline (top-left page origin, points). Always Helvetica 10 pt. */
  text(x: number, y: number, s: string, align?: Align): void;
  textWidth(s: string): number;
}

// ---------------------------------------------------------------- punctuation rules
const CHAR_MAP: Record<string, string> = {
  '₱': 'PHP ',
  '≥': '>=',
  '≤': '<=',
  '→': ' to ',
  '←': ' from ',
  'σ': 'sigma ',
  'ξ': 'xi',
  'Δ': 'delta ',
  '−': '-',
  '–': '-',
  '‐': '-',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '✓': 'ok',
};

/**
 * Strict report text rule: zero colons, zero em dashes, zero double hyphens.
 * `14:30` -> `1430`; any other colon becomes a space; em / en dashes become a space or hyphen;
 * runs of hyphens collapse to one; characters outside WinAnsi are spelled out or dropped.
 */
export function sanitizePdfText(input: string): string {
  let s = String(input);
  s = s.replace(/(\d):(\d)/g, '$1$2');
  s = s.replace(/\s*:\s*/g, ' ');
  s = s.replace(/\s*[—―]\s*/g, ' ');
  for (const [k, v] of Object.entries(CHAR_MAP)) s = s.split(k).join(v);
  s = s.replace(/-{2,}/g, '-');
  s = [...s].filter((ch) => winAnsiByte(ch) !== null).join('');
  s = s.replace(/[ \t]{2,}/g, ' ');
  // a stray colon can never survive, whatever the input
  return s.split(':').join(' ').split('—').join(' ').trim();
}

// ---------------------------------------------------------------- Helvetica metrics + WinAnsi
// Standard Helvetica advance widths (1/1000 em) for 0x20..0x7E (Adobe core-14 AFM).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const WIN_ANSI_HIGH: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89, '‹': 0x8b, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '•': 0x95, '–': 0x96, '™': 0x99, '›': 0x9b,
};

export function winAnsiByte(ch: string): number | null {
  const c = ch.codePointAt(0)!;
  if (c >= 0x20 && c <= 0x7e) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return WIN_ANSI_HIGH[ch] ?? null;
}

export function helveticaWidth(s: string, pt = REPORT_FONT_PT): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c >= 0x20 && c <= 0x7e ? HELV[c - 0x20] : 556;
  }
  return (w * pt) / 1000;
}

/** Greedy word wrap at REPORT_FONT_PT. */
export function wrapText(s: string, maxW: number): string[] {
  const words = sanitizePdfText(s).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (helveticaWidth(next) <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Truncate with an ellipsis so a table cell never overflows. */
export function fitText(s: string, maxW: number): string {
  const t = sanitizePdfText(s);
  if (helveticaWidth(t) <= maxW) return t;
  let out = t;
  while (out.length > 1 && helveticaWidth(`${out}…`) > maxW) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();
const col = (c: RGB) => `${n(c[0] / 255)} ${n(c[1] / 255)} ${n(c[2] / 255)}`;

// ---------------------------------------------------------------- PDF backend
export class PdfSurface implements ReportSurface {
  private pages: string[][] = [[]];
  private tc: RGB = [15, 23, 42];
  /** every string actually drawn (post-sanitisation), for tests and auditing */
  readonly textLog: string[] = [];
  /** every font-selection operator emitted */
  readonly fontOps: string[] = [];

  constructor(
    readonly width = A4_W,
    readonly height = A4_H,
  ) {}

  get pageCount() {
    return this.pages.length;
  }
  private get ops() {
    return this.pages[this.pages.length - 1];
  }
  addPage() {
    this.pages.push([]);
  }
  fill(c: RGB) {
    this.ops.push(`${col(c)} rg`);
  }
  stroke(c: RGB) {
    this.ops.push(`${col(c)} RG`);
  }
  textColor(c: RGB) {
    this.tc = c;
  }
  lineWidth(w: number) {
    this.ops.push(`${n(w)} w`);
  }
  dash(on: number, off: number) {
    this.ops.push(`[${n(on)} ${n(off)}] 0 d`);
  }
  noDash() {
    this.ops.push('[] 0 d');
  }
  private paint(mode: 'f' | 's' | 'b') {
    return mode === 'f' ? 'f' : mode === 's' ? 'S' : 'B';
  }
  rect(x: number, y: number, w: number, h: number, mode: 'f' | 's' | 'b') {
    this.ops.push(`${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re ${this.paint(mode)}`);
  }
  line(x1: number, y1: number, x2: number, y2: number) {
    this.ops.push(`${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S`);
  }
  polygon(pts: readonly (readonly [number, number])[], mode: 'f' | 's' | 'b', close = true) {
    if (pts.length < 2) return;
    const p = pts.map(([x, y], i) => `${n(x)} ${n(this.height - y)} ${i ? 'l' : 'm'}`).join(' ');
    const op = mode === 's' && !close ? 'S' : `h ${this.paint(mode)}`;
    this.ops.push(`${p} ${op}`);
  }
  circle(cx: number, cy: number, r: number, mode: 'f' | 's' | 'b') {
    const k = 0.5523 * r;
    const y = this.height - cy;
    this.ops.push(
      `${n(cx + r)} ${n(y)} m ${n(cx + r)} ${n(y + k)} ${n(cx + k)} ${n(y + r)} ${n(cx)} ${n(y + r)} c ` +
        `${n(cx - k)} ${n(y + r)} ${n(cx - r)} ${n(y + k)} ${n(cx - r)} ${n(y)} c ` +
        `${n(cx - r)} ${n(y - k)} ${n(cx - k)} ${n(y - r)} ${n(cx)} ${n(y - r)} c ` +
        `${n(cx + k)} ${n(y - r)} ${n(cx + r)} ${n(y - k)} ${n(cx + r)} ${n(y)} c h ${this.paint(mode)}`,
    );
  }
  textWidth(s: string) {
    return helveticaWidth(sanitizePdfText(s));
  }
  text(x: number, y: number, s: string, align: Align = 'left') {
    const t = sanitizePdfText(s);
    if (!t) return;
    const w = helveticaWidth(t);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const font = `/F1 ${REPORT_FONT_PT} Tf`;
    this.fontOps.push(font);
    this.textLog.push(t);
    this.ops.push(`BT ${font} ${col(this.tc)} rg ${n(x0)} ${n(this.height - y)} Td (${pdfString(t)}) Tj ET`);
  }

  /** Serialise to PDF 1.4 bytes. No /Info dictionary (no dates), so the file has no colons. */
  toBytes(title: string): Uint8Array {
    const objs: string[] = [];
    const add = (body: string) => {
      objs.push(body);
      return objs.length;
    };
    const catalog = add('');
    const pagesObj = add('');
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /ViewerPreferences << /DisplayDocTitle false >> >>`;
    let out = `%PDF-1.4\n%âãÏÓ\n% ${sanitizePdfText(title)}\n`;
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${o.toString().padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

/** WinAnsi-encode and escape a (sanitised) string for a PDF literal. */
export function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const b = winAnsiByte(ch);
    if (b === null) continue;
    const c = String.fromCharCode(b);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
  }
  return out;
}

// ---------------------------------------------------------------- Canvas backend (preview)
export class CanvasSurface implements ReportSurface {
  private n = 1;
  private tc: RGB = [15, 23, 42];

  /** `pageCanvas(i)` returns the canvas for page i (created on demand by the caller). */
  constructor(
    private readonly pageCanvas: (index: number) => CanvasRenderingContext2D,
    private readonly scale: number,
  ) {
    this.begin(this.pageCanvas(0));
  }
  private ctx!: CanvasRenderingContext2D;
  private begin(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, A4_W, A4_H);
    ctx.font = `${REPORT_FONT_PT}px ${REPORT_FONT_FAMILY}, Arial, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
  }
  get pageCount() {
    return this.n;
  }
  addPage() {
    this.begin(this.pageCanvas(this.n++));
  }
  fill(c: RGB) {
    this.ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  stroke(c: RGB) {
    this.ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  textColor(c: RGB) {
    this.tc = c;
  }
  lineWidth(w: number) {
    this.ctx.lineWidth = w;
  }
  dash(on: number, off: number) {
    this.ctx.setLineDash([on, off]);
  }
  noDash() {
    this.ctx.setLineDash([]);
  }
  private paint(mode: 'f' | 's' | 'b') {
    if (mode !== 's') this.ctx.fill();
    if (mode !== 'f') this.ctx.stroke();
  }
  rect(x: number, y: number, w: number, h: number, mode: 'f' | 's' | 'b') {
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.paint(mode);
  }
  line(x1: number, y1: number, x2: number, y2: number) {
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
  }
  polygon(pts: readonly (readonly [number, number])[], mode: 'f' | 's' | 'b', close = true) {
    if (pts.length < 2) return;
    this.ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? this.ctx.lineTo(x, y) : this.ctx.moveTo(x, y)));
    if (close) this.ctx.closePath();
    this.paint(mode);
  }
  circle(cx: number, cy: number, r: number, mode: 'f' | 's' | 'b') {
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.paint(mode);
  }
  textWidth(s: string) {
    return helveticaWidth(sanitizePdfText(s));
  }
  text(x: number, y: number, s: string, align: Align = 'left') {
    const t = sanitizePdfText(s);
    if (!t) return;
    const w = helveticaWidth(t);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    this.ctx.fillStyle = `rgb(${this.tc[0]},${this.tc[1]},${this.tc[2]})`;
    this.ctx.fillText(t, x0, y);
  }
}
