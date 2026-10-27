// Canvas renderers for the Cross-Section Simulator (pure functions of a per-frame model).
//   drawNodeCutaway  — Mode A: street, grate, soil, manhole shaft, true-shape pipe/culvert (or
//                      lagoon bowl / intake rack), ESP32-S3 + A02YYUW with acoustic pings,
//                      3 cm blind zone, Blockage Surge line, LoRaWAN gateway, live water.
//   drawCatchmentProfile — Mode B: hillside catchment -> Edge-AI node callout -> lagoon bowl ->
//                      trash rack -> 2.3 km tunnel (2.5×2.7 m concrete / 1.5×1.7 m rock choke).
import type { Theme } from '../../three/theme';

export interface Palette {
  sky0: string;
  sky1: string;
  ground: string;
  soil: string;
  hatch: string;
  street: string;
  casing: string;
  rock: string;
  rockHatch: string;
  wall: string;
  glass: string;
  water0: string;
  water1: string;
  text: string;
  dim: string;
  accent: string;
  danger: string;
  rain: string;
  park: string;
  building: string;
  panel: string;
}

export const PALETTES: Record<Theme, Palette> = {
  daylight: {
    sky0: '#E3F2F9',
    sky1: '#FAFDFB',
    ground: '#F3F4EE',
    soil: '#EBE5D7',
    hatch: 'rgba(140,120,85,0.22)',
    street: '#D9DDD2',
    casing: '#FFFFFF',
    rock: '#DEDAD1',
    rockHatch: 'rgba(110,100,85,0.28)',
    wall: '#64748B',
    glass: 'rgba(226,248,240,0.65)',
    water0: '#38BDF8',
    water1: '#0E7490',
    text: '#0F172A',
    dim: '#64748B',
    accent: '#059669',
    danger: '#DC2626',
    rain: '#0284C7',
    park: '#A3D98B',
    building: '#10B981',
    panel: 'rgba(255,255,255,0.88)',
  },
  xray: {
    sky0: '#0B1220',
    sky1: '#121D31',
    ground: '#1E293B',
    soil: '#141E30',
    hatch: 'rgba(148,163,184,0.12)',
    street: '#334155',
    casing: '#475569',
    rock: '#172133',
    rockHatch: 'rgba(148,163,184,0.16)',
    wall: '#94A3B8',
    glass: 'rgba(56,189,248,0.10)',
    water0: '#22D3EE',
    water1: '#0E7490',
    text: '#E2E8F0',
    dim: '#94A3B8',
    accent: '#38BDF8',
    danger: '#F43F5E',
    rain: '#93C5FD',
    park: '#14532D',
    building: '#38BDF8',
    panel: 'rgba(9,13,22,0.85)',
  },
};

export type StructureKind = 'CIRCULAR' | 'RECT_CLOSED' | 'ARCH' | 'STORAGE' | 'ORIFICE';

export interface NodeModel {
  id: string;
  title: string;          // e.g. "Underground Main Box Culvert 3.5m × 2.0m (EN-03)"
  kind: StructureKind;
  rise: number;           // m (D for h/D)
  span: number;           // m
  lidDepth: number;       // m from street to datum (pipe invert / bowl invert / rack sill)
  mount: number;          // m from datum to the transducer face
  crownMounted: boolean;
  depth: number;          // m water above datum (smoothed; may exceed rise -> shaft / street)
  fullPct: number;        // smoothed
  velocity: number;       // m/s
  anomaly: string;
  turbulence: number;     // 0..1
  rain: number;           // mm/hr
  blockagePct: number;
  draining: boolean;
  isVision: boolean;
}

export interface ProfileModel {
  rain: number;
  hillFill: number;       // 0..1.27 hillside conduit fullness
  arterialFill: number;
  lagoonDepth: number;    // m
  lagoonMax: number;
  blockagePct: number;
  tunnelFill: number;     // 0..1 concreted reach
  chokeFill: number;      // 0..1 rock choke
  downstreamFill: number;
  tunnelVelocity: number;
  hillAnomaly: string;
  draining: boolean;
}

const TAU = Math.PI * 2;

function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, step = 10, cross = false) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -h; i < w + h; i += step) {
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
    if (cross) {
      ctx.moveTo(x + i + h, y);
      ctx.lineTo(x + i, y + h);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, opts: { size?: number; weight?: number; align?: CanvasTextAlign; bg?: string; mono?: boolean } = {}) {
  ctx.save();
  ctx.font = `${opts.weight ?? 600} ${opts.size ?? 11}px ${opts.mono ? 'ui-monospace, Consolas, monospace' : 'ui-sans-serif, system-ui, Segoe UI, sans-serif'}`;
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = 'middle';
  if (opts.bg) {
    const w = ctx.measureText(text).width + 10;
    const bx = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x - 5;
    ctx.fillStyle = opts.bg;
    roundRect(ctx, bx, y - 9, w, 18, 6);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rainStreaks(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, rain: number, t: number, color: string) {
  if (rain <= 0.05) return;
  const n = Math.round(30 + (rain / 250) * 220);
  const speed = 260 + rain * 1.6;
  const slant = 0.18 + rain / 900;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const rx = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const ry = (Math.sin(i * 78.233) * 12345.678) % 1;
    const fx = (Math.abs(rx) * w + t * speed * slant) % (w + 40) - 20;
    const fy = (Math.abs(ry) * h + t * speed) % h;
    const len = 8 + (rain / 250) * 12;
    ctx.moveTo(x0 + fx, y0 + fy);
    ctx.lineTo(x0 + fx - len * slant, y0 + fy - len);
  }
  ctx.stroke();
  ctx.restore();
}

function waterGradient(ctx: CanvasRenderingContext2D, yTop: number, yBot: number, p: Palette, alarm: number) {
  const g = ctx.createLinearGradient(0, yTop, 0, yBot);
  g.addColorStop(0, alarm > 0 ? `rgba(239,68,68,${0.55 + 0.3 * alarm})` : p.water0);
  g.addColorStop(1, p.water1);
  return g;
}

function waveAmplitude(m: { anomaly: string; turbulence: number; velocity: number }): number {
  if (m.anomaly === 'TRASH_BLOCKAGE') return 0.4;                      // stagnant backwater: glass-flat
  if (m.anomaly === 'FLASH_SURGE') return 7 + m.turbulence * 6;         // turbulent surge
  return 1.2 + Math.min(m.turbulence * 6 + m.velocity * 0.6, 5);
}

/** Wavy free-surface path from x0..x1 at height y (closes down to yBottom). */
function waterPath(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, yBottom: number, amp: number, t: number, speed: number) {
  ctx.beginPath();
  ctx.moveTo(x0, yBottom);
  ctx.lineTo(x0, y);
  for (let x = x0; x <= x1; x += 6) {
    const yy = y + amp * Math.sin(x * 0.045 - t * speed) + amp * 0.45 * Math.sin(x * 0.11 + t * speed * 1.7);
    ctx.lineTo(x, yy);
  }
  ctx.lineTo(x1, y);
  ctx.lineTo(x1, yBottom);
  ctx.closePath();
}

function gateway(ctx: CanvasRenderingContext2D, x: number, groundY: number, t: number, p: Palette, scale = 1) {
  const h = 74 * scale;
  ctx.save();
  ctx.strokeStyle = p.wall;
  ctx.lineWidth = 3 * scale;
  ctx.beginPath();
  ctx.moveTo(x, groundY);
  ctx.lineTo(x, groundY - h);
  ctx.stroke();
  ctx.fillStyle = p.accent;
  roundRect(ctx, x - 9 * scale, groundY - h * 0.55, 18 * scale, 14 * scale, 3);
  ctx.fill();
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.moveTo(x, groundY - h);
  ctx.lineTo(x, groundY - h - 16 * scale);
  ctx.stroke();
  for (let k = 0; k < 3; k++) {
    const ph = (t * 0.8 + k / 3) % 1;
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 1 - ph;
    ctx.lineWidth = 1.6;
    const r = (10 + ph * 34) * scale;
    ctx.beginPath();
    ctx.arc(x, groundY - h - 16 * scale, r, -Math.PI * 0.85, -Math.PI * 0.15);
    ctx.stroke();
  }
  ctx.restore();
}

function mcuAndSensor(ctx: CanvasRenderingContext2D, cx: number, sensorY: number, mcuY: number, mcuX: number, t: number, p: Palette, s = 1, labels = true) {
  // ESP32-S3 enclosure + cable + A02YYUW transducer pointing down.
  ctx.save();
  ctx.strokeStyle = p.dim;
  ctx.lineWidth = 1.4 * s;
  ctx.setLineDash([4 * s, 3 * s]);
  ctx.beginPath();
  ctx.moveTo(mcuX, mcuY + 9 * s);
  ctx.lineTo(mcuX, sensorY - 10 * s);
  ctx.lineTo(cx, sensorY - 10 * s);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = p.panel;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 1.5 * s;
  roundRect(ctx, mcuX - 26 * s, mcuY - 11 * s, 52 * s, 22 * s, 4 * s);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = (Math.floor(t * 2) % 2 === 0) ? '#22C55E' : '#15803D';
  ctx.beginPath();
  ctx.arc(mcuX + 18 * s, mcuY - 4 * s, 2.4 * s, 0, TAU);
  ctx.fill();
  if (s >= 0.8) label(ctx, 'ESP32-S3', mcuX - 3 * s, mcuY + 1, p.text, { size: 9 * s, weight: 700, align: 'center', mono: true });
  // sensor body + cone
  ctx.fillStyle = '#334155';
  roundRect(ctx, cx - 11 * s, sensorY - 14 * s, 22 * s, 10 * s, 2);
  ctx.fill();
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(cx - 9 * s, sensorY - 4 * s);
  ctx.lineTo(cx + 9 * s, sensorY - 4 * s);
  ctx.lineTo(cx + 5 * s, sensorY);
  ctx.lineTo(cx - 5 * s, sensorY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (labels) {
    label(ctx, 'ESP32-S3 MCU', mcuX + 32 * s, mcuY, p.text, { size: 10, align: 'left', bg: p.panel });
  }
}

function acousticPings(ctx: CanvasRenderingContext2D, cx: number, y0: number, y1: number, t: number, p: Palette, width: number) {
  if (y1 - y0 < 6) return;
  ctx.save();
  for (let k = 0; k < 4; k++) {
    const down = (t * 0.9 + k / 4) % 1;
    const yd = y0 + down * (y1 - y0);
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 0.85 * (1 - down * 0.6);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(cx, yd, 6 + down * width * 0.5, 3 + down * 4, 0, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    const up = (t * 0.9 + k / 4 + 0.5) % 1;
    const yu = y1 - up * (y1 - y0);
    ctx.strokeStyle = '#06B6D4';
    ctx.globalAlpha = 0.55 * (1 - up);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(cx, yu, 4 + (1 - up) * width * 0.45, 2 + (1 - up) * 3, 0, 1.15 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}

function flowChevrons(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, t: number, velocity: number, color: string, size = 6) {
  if (velocity < 0.02) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.85;
  const spacing = 42;
  const off = (t * (18 + velocity * 26)) % spacing;
  for (let x = x0 + off; x < x1 - size; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x - size, y - size * 0.7);
    ctx.lineTo(x, y);
    ctx.lineTo(x - size, y + size * 0.7);
    ctx.stroke();
  }
  ctx.restore();
}

function endView(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, m: NodeModel, p: Palette, fill: string) {
  // True cross-section icon (end view) filled to h/D.
  const H = size;
  const W = Math.min((m.span / m.rise) * H, size * 1.6);
  const left = x - W / 2;
  const top = y - H / 2;
  const shapePath = () => {
    ctx.beginPath();
    if (m.kind === 'CIRCULAR') ctx.ellipse(x, y, H / 2, H / 2, 0, 0, TAU);
    else if (m.kind === 'ARCH') {
      const r = W / 2;
      ctx.moveTo(left, top + H);
      ctx.lineTo(left, top + r);
      ctx.arc(x, top + r, r, Math.PI, 0);
      ctx.lineTo(left + W, top + H);
      ctx.closePath();
    } else {
      const k = Math.min(W, H) * 0.12;
      ctx.moveTo(left + k, top);
      ctx.lineTo(left + W - k, top);
      ctx.lineTo(left + W, top + k);
      ctx.lineTo(left + W, top + H - k);
      ctx.lineTo(left + W - k, top + H);
      ctx.lineTo(left + k, top + H);
      ctx.lineTo(left, top + H - k);
      ctx.lineTo(left, top + k);
      ctx.closePath();
    }
  };
  ctx.save();
  ctx.fillStyle = p.panel;
  roundRect(ctx, x - W / 2 - 12, y - H / 2 - 22, W + 24, H + 34, 8);
  ctx.fill();
  shapePath();
  ctx.fillStyle = p.glass;
  ctx.fill();
  ctx.save();
  shapePath();
  ctx.clip();
  const lvl = Math.min(m.depth / m.rise, 1);
  ctx.fillStyle = fill;
  ctx.fillRect(left - 2, top + H * (1 - lvl), W + 4, H * lvl + 2);
  ctx.restore();
  shapePath();
  ctx.strokeStyle = p.wall;
  ctx.lineWidth = 2;
  ctx.stroke();
  label(ctx, 'END VIEW', x, top - 11, p.dim, { size: 8, weight: 700, align: 'center' });
  ctx.restore();
}

// ============================================================== Mode A
export function drawNodeCutaway(ctx: CanvasRenderingContext2D, W: number, H: number, m: NodeModel, t: number, p: Palette, fillColor: string) {
  ctx.clearRect(0, 0, W, H);
  const streetY = Math.round(H * 0.27);
  const sky = ctx.createLinearGradient(0, 0, 0, streetY);
  sky.addColorStop(0, p.sky0);
  sky.addColorStop(1, p.sky1);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, streetY);
  rainStreaks(ctx, 0, 0, W, streetY, m.rain, t, p.rain);

  // soil + street slab
  ctx.fillStyle = p.soil;
  ctx.fillRect(0, streetY, W, H - streetY);
  hatch(ctx, 0, streetY + 12, W, H - streetY - 12, p.hatch, 12);
  ctx.fillStyle = p.casing;
  ctx.fillRect(0, streetY - 2, W, 4);
  ctx.fillStyle = p.street;
  ctx.fillRect(0, streetY + 2, W, 10);
  label(ctx, 'Street Level', 12, streetY - 12, p.text, { size: 11, weight: 700, bg: p.panel });

  const alarm = m.fullPct > 94 ? 0.5 + 0.5 * Math.sin(t * 6) : 0;
  const amp = waveAmplitude(m);
  const cx = W * 0.5;
  const basin = m.kind === 'STORAGE' || m.kind === 'ORIFICE';

  if (!basin) {
    // ---- manhole shaft + longitudinal pipe/culvert
    const shaftReal = Math.max(m.lidDepth - m.rise, 0.3);
    const shaftVis = Math.min(shaftReal, 3.2);
    const broken = shaftReal > shaftVis + 0.05;
    const pxPerM = Math.min((H - streetY - 40) / (shaftVis + m.rise + 0.5), (H * 0.36) / m.rise);
    const shaftTop = streetY + 12;
    const pipeTop = shaftTop + shaftVis * pxPerM;
    const invertY = pipeTop + m.rise * pxPerM;
    const x0 = W * 0.04;
    const x1 = W * 0.96;
    const shaftW = Math.max(1.2 * pxPerM, 30);

    // pipe body (glass) + walls
    ctx.fillStyle = p.glass;
    ctx.fillRect(x0, pipeTop, x1 - x0, invertY - pipeTop);
    // water in pipe
    const inPipe = Math.min(m.depth, m.rise);
    if (inPipe > 0.002) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, pipeTop, x1 - x0, invertY - pipeTop);
      ctx.clip();
      const wy = invertY - inPipe * pxPerM;
      waterPath(ctx, x0, x1, wy, invertY, m.depth >= m.rise ? 0 : amp, t, 2 + m.velocity);
      ctx.fillStyle = waterGradient(ctx, wy, invertY, p, alarm);
      ctx.fill();
      flowChevrons(ctx, x0, x1, (wy + invertY) / 2, t, m.velocity, 'rgba(255,255,255,0.85)');
      ctx.restore();
    }
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, pipeTop);
    ctx.lineTo(cx - shaftW / 2, pipeTop);
    ctx.moveTo(cx + shaftW / 2, pipeTop);
    ctx.lineTo(x1, pipeTop);
    ctx.moveTo(x0, invertY);
    ctx.lineTo(x1, invertY);
    ctx.stroke();

    // shaft
    ctx.fillStyle = p.glass;
    ctx.fillRect(cx - shaftW / 2, shaftTop, shaftW, pipeTop - shaftTop);
    if (m.depth > m.rise) {
      const above = m.depth - m.rise;
      const visAbove = broken ? (above / shaftReal) * shaftVis : above;
      const wy = Math.max(pipeTop - visAbove * pxPerM, shaftTop);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - shaftW / 2, shaftTop, shaftW, pipeTop - shaftTop + 2);
      ctx.clip();
      waterPath(ctx, cx - shaftW / 2, cx + shaftW / 2, wy, pipeTop + 2, 1.5, t, 3);
      ctx.fillStyle = waterGradient(ctx, wy, pipeTop, p, alarm);
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - shaftW / 2, shaftTop);
    ctx.lineTo(cx - shaftW / 2, pipeTop);
    ctx.moveTo(cx + shaftW / 2, shaftTop);
    ctx.lineTo(cx + shaftW / 2, pipeTop);
    ctx.stroke();
    if (broken) {
      const by = shaftTop + (pipeTop - shaftTop) * 0.5;
      ctx.fillStyle = p.soil;
      ctx.fillRect(cx - shaftW / 2 - 14, by - 5, shaftW + 28, 10);
      ctx.strokeStyle = p.dim;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const dy of [-5, 5]) {
        ctx.moveTo(cx - shaftW / 2 - 14, by + dy);
        for (let k = 0; k <= 6; k++) ctx.lineTo(cx - shaftW / 2 - 14 + ((shaftW + 28) * k) / 6, by + dy + (k % 2 ? -3 : 3));
      }
      ctx.stroke();
      label(ctx, `≈ ${shaftReal.toFixed(1)} m shaft`, cx + shaftW / 2 + 18, by, p.dim, { size: 10, bg: p.panel });
    }

    // street pooling when the node surcharges past the lid
    if (m.depth > m.lidDepth) {
      const pool = Math.min((m.depth - m.lidDepth) * pxPerM, 20) + 3;
      const spread = Math.min(80 + (m.depth - m.lidDepth) * 260, W * 0.45);
      ctx.save();
      ctx.fillStyle = `rgba(239,68,68,${0.35 + 0.25 * Math.sin(t * 5)})`;
      ctx.beginPath();
      ctx.ellipse(cx, streetY, spread, pool, 0, Math.PI, 0);
      ctx.fill();
      ctx.restore();
      label(ctx, 'SURCHARGE — water pooling above street', cx, streetY - pool - 14, p.danger, { size: 11, weight: 800, align: 'center', bg: p.panel });
    }

    // grate
    ctx.fillStyle = '#475569';
    ctx.fillRect(cx - shaftW / 2 - 6, streetY - 3, shaftW + 12, 6);
    ctx.fillStyle = p.sky1;
    for (let k = 0; k < 6; k++) ctx.fillRect(cx - shaftW / 2 + 2 + (k * (shaftW - 4)) / 6, streetY - 1.5, (shaftW - 4) / 6 - 3, 3);

    // blockage surge threshold (h/D 0.60)
    const surgeY = invertY - 0.6 * m.rise * pxPerM;
    ctx.save();
    ctx.strokeStyle = p.danger;
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(x0, surgeY);
    ctx.lineTo(x1, surgeY);
    ctx.stroke();
    ctx.restore();
    label(ctx, 'Blockage Surge (h/D 0.60)', x0 + 8, surgeY - 11, p.danger, { size: 10, weight: 700, bg: p.panel });

    // sensor + MCU
    const sensorY = m.crownMounted ? pipeTop - 0.12 * pxPerM - 4 : shaftTop + 22;
    const waterY = m.depth > m.rise ? Math.max(pipeTop - (m.depth - m.rise) * pxPerM, shaftTop) : invertY - Math.min(m.depth, m.rise) * pxPerM;
    mcuAndSensor(ctx, cx, sensorY, shaftTop + 14, cx + shaftW / 2 + 40, t, p);
    const blind = Math.max(0.03 * pxPerM, 5);
    ctx.fillStyle = 'rgba(239,68,68,0.18)';
    ctx.fillRect(cx - shaftW / 2 + 3, sensorY, shaftW - 6, blind);
    label(ctx, '3 cm Blind Zone', cx - shaftW / 2 - 8, sensorY + blind / 2, p.danger, { size: 9, align: 'right', bg: p.panel });
    label(ctx, 'A02YYUW Ultrasonic Sensor', cx - shaftW / 2 - 8, sensorY - 16, p.text, { size: 10, align: 'right', bg: p.panel });
    acousticPings(ctx, cx, sensorY + blind, waterY, t, p, shaftW * 0.8);

    // pipe labels + end view
    label(ctx, m.title, x0 + 6, invertY + 18, p.text, { size: 12, weight: 800, bg: p.panel });
    endView(ctx, x1 - 70, pipeTop - 46 < shaftTop + 50 ? invertY - (invertY - pipeTop) / 2 : pipeTop - 40, Math.min(46, (invertY - pipeTop) * 0.9 + 18), m, p, fillColor);
    if (m.draining) {
      label(ctx, 'DRAINING ⟶', x1 - 8, (pipeTop + invertY) / 2, p.accent, { size: 12, weight: 800, align: 'right', bg: p.panel });
    }
  } else {
    // ---- lagoon bowl (EN-07) or intake chamber with trash rack (EN-08 / EN-09)
    const pxPerM = (H - streetY - 34) / (m.lidDepth + 0.3);
    const floorY = streetY + 12 + m.lidDepth * pxPerM;
    const top = streetY + 12;
    const xl = W * 0.12;
    const xr = W * 0.88;
    const inset = m.kind === 'STORAGE' ? W * 0.12 : W * 0.02;
    const poly = (y: number) => {
      const f = (y - top) / (floorY - top);
      return [xl + inset * f, xr - inset * f] as const;
    };
    ctx.fillStyle = p.glass;
    ctx.beginPath();
    ctx.moveTo(xl, top);
    ctx.lineTo(xl + inset, floorY);
    ctx.lineTo(xr - inset, floorY);
    ctx.lineTo(xr, top);
    ctx.closePath();
    ctx.fill();
    const wy = floorY - Math.min(m.depth, m.lidDepth) * pxPerM;
    if (m.depth > 0.01) {
      const [a, b] = poly(Math.max(wy, top));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(xl, top);
      ctx.lineTo(xl + inset, floorY);
      ctx.lineTo(xr - inset, floorY);
      ctx.lineTo(xr, top);
      ctx.closePath();
      ctx.clip();
      waterPath(ctx, a - 4, b + 4, Math.max(wy, top), floorY + 2, amp * 0.6, t, 1.4);
      ctx.fillStyle = waterGradient(ctx, wy, floorY, p, alarm);
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(xl, top);
    ctx.lineTo(xl + inset, floorY);
    ctx.lineTo(xr - inset, floorY);
    ctx.lineTo(xr, top);
    ctx.stroke();
    if (m.depth > m.lidDepth) {
      ctx.fillStyle = `rgba(239,68,68,${0.35 + 0.25 * Math.sin(t * 5)})`;
      ctx.fillRect(0, streetY - 6, W, 8);
      // inside the bowl, right of centre: the mast/sensor labels own the space above the rim
      label(ctx, 'OVERFLOW — lagoon above the 1433.0 m rim', W * 0.6, streetY + 20, p.danger, { size: 11, weight: 800, align: 'center', bg: p.panel });
    }
    if (m.kind === 'ORIFICE') {
      // inclined trash rack at the downstream wall + debris
      const rx = xr - inset - 46;
      const glow = Math.min(m.blockagePct / 95, 1);
      ctx.save();
      ctx.strokeStyle = glow > 0.6 ? '#EF4444' : glow > 0.25 ? '#F59E0B' : p.wall;
      ctx.shadowColor = '#F97316';
      ctx.shadowBlur = 18 * glow;
      ctx.lineWidth = 3;
      for (let k = 0; k < 8; k++) {
        ctx.beginPath();
        ctx.moveTo(rx + k * 6, floorY);
        ctx.lineTo(rx + k * 6 + 22, floorY - 2.0 * pxPerM);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = '#7C5A2E';
      for (let k = 0; k < Math.round(glow * 16); k++) {
        ctx.beginPath();
        ctx.arc(rx + 4 + (k % 8) * 6 + 6, floorY - 6 - Math.floor(k / 8) * 10, 5, 0, TAU);
        ctx.fill();
      }
      label(ctx, `Trash rack ${m.blockagePct.toFixed(0)}% occluded`, rx + 20, floorY - 2.0 * pxPerM - 14, p.text, { size: 10, align: 'center', bg: p.panel });
    }
    const surgeY = floorY - 0.6 * m.rise * pxPerM;
    ctx.save();
    ctx.strokeStyle = p.danger;
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(xl, surgeY);
    ctx.lineTo(xr, surgeY);
    ctx.stroke();
    ctx.restore();
    label(ctx, `Blockage Surge (h/D 0.60 of ${m.rise} m)`, xl + 8, surgeY - 11, p.danger, { size: 10, weight: 700, bg: p.panel });
    // mast-mounted sensor over the water
    const mastX = xl + 34;
    const sensorY = floorY - m.mount * pxPerM;
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(xl + 6, streetY);
    ctx.lineTo(xl + 6, sensorY - 18);
    ctx.lineTo(mastX + 30, sensorY - 18);
    ctx.stroke();
    mcuAndSensor(ctx, mastX + 30, sensorY, sensorY - 30, xl + 6, t, p, 1, false);
    label(ctx, 'ESP32-S3 MCU', xl + 40, sensorY - 34, p.text, { size: 10, bg: p.panel });
    label(ctx, m.isVision ? 'YOLOv8 camera + staff gauge' : 'A02YYUW Ultrasonic Sensor', mastX + 50, sensorY - 6, p.text, { size: 10, bg: p.panel });
    const blind = Math.max(0.03 * pxPerM, 5);
    ctx.fillStyle = 'rgba(239,68,68,0.18)';
    ctx.fillRect(mastX + 20, sensorY, 20, blind);
    label(ctx, '3 cm Blind Zone', mastX + 46, sensorY + blind + 8, p.danger, { size: 9, bg: p.panel });
    acousticPings(ctx, mastX + 30, sensorY + blind, Math.max(wy, sensorY + 8), t, p, 40);
    label(ctx, m.title, W / 2, floorY + 16, p.text, { size: 12, weight: 800, align: 'center', bg: p.panel });
  }

  gateway(ctx, W * 0.9, streetY, t, p);
  label(ctx, 'AS923-3 LoRaWAN Gateway', W * 0.9, streetY - 104, p.text, { size: 10, weight: 700, align: 'center', bg: p.panel });
  // uplink arc from the node to the gateway
  ctx.save();
  ctx.strokeStyle = p.accent;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([3, 5]);
  ctx.lineDashOffset = -t * 30;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W * 0.5, streetY - 6);
  ctx.quadraticCurveTo(W * 0.7, streetY - 90, W * 0.9, streetY - 90);
  ctx.stroke();
  ctx.restore();
}

// ============================================================== Mode B
export function drawCatchmentProfile(ctx: CanvasRenderingContext2D, W: number, H: number, m: ProfileModel, t: number, p: Palette, rampColor: (r: number) => string) {
  ctx.clearRect(0, 0, W, H);
  const rimY = H * 0.5;
  const hillTopY = H * 0.14;
  const floorY = H * 0.86;
  const xHill1 = W * 0.34;
  const xRimL = W * 0.37;
  const xRimR = W * 0.63;
  const xFloorL = W * 0.42;
  const xFloorR = W * 0.58;
  const slopeY = (x: number) => hillTopY + ((rimY - hillTopY) * x) / xHill1;

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, rimY);
  sky.addColorStop(0, p.sky0);
  sky.addColorStop(1, p.sky1);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  rainStreaks(ctx, 0, 0, W, rimY + 10, m.rain, t, p.rain);

  // ground mass: hillside + lagoon rim plain + bedrock on the right
  ctx.fillStyle = p.soil;
  ctx.beginPath();
  ctx.moveTo(0, hillTopY);
  ctx.lineTo(xHill1, rimY);
  ctx.lineTo(xRimL, rimY);
  ctx.lineTo(xFloorL, floorY);
  ctx.lineTo(xFloorR, floorY);
  ctx.lineTo(xRimR, rimY);
  ctx.lineTo(W, rimY);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.clip();
  hatch(ctx, 0, 0, xRimR + 10, H, p.hatch, 12);
  ctx.restore();
  // limestone bedrock block (right)
  ctx.fillStyle = p.rock;
  ctx.fillRect(xRimR - 6, rimY + 18, W - xRimR + 6, H - rimY - 18);
  hatch(ctx, xRimR - 6, rimY + 18, W - xRimR + 6, H - rimY - 18, p.rockHatch, 14, true);
  label(ctx, 'Mirador limestone bedrock', W * 0.93, H - 14, p.dim, { size: 10, align: 'right' });
  // green surface strip
  ctx.strokeStyle = p.park;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(0, hillTopY);
  ctx.lineTo(xHill1, rimY);
  ctx.lineTo(xRimL, rimY);
  ctx.moveTo(xRimR, rimY);
  ctx.lineTo(W, rimY);
  ctx.stroke();

  // hillside wireframe buildings (isometric prisms)
  const bxs = [0.04, 0.09, 0.15, 0.2, 0.27];
  bxs.forEach((fx, i) => {
    const x = W * fx;
    const base = slopeY(x);
    const w = 24 + (i % 2) * 8;
    const h = 34 + ((i * 37) % 28);
    const d = 9;
    ctx.save();
    ctx.strokeStyle = p.building;
    ctx.fillStyle = p.glass;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.rect(x, base - h, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, base - h);
    ctx.lineTo(x + d, base - h - d);
    ctx.lineTo(x + w + d, base - h - d);
    ctx.lineTo(x + w, base - h);
    ctx.moveTo(x + w + d, base - h - d);
    ctx.lineTo(x + w + d, base - d);
    ctx.lineTo(x + w, base);
    ctx.stroke();
    ctx.restore();
  });
  label(ctx, 'Steep Baguio Hillside Catchment', W * 0.02, hillTopY - 20, p.text, { size: 12, weight: 800, bg: p.panel });

  // gravity conduit under the slope into the lagoon wall
  const off = 34;
  const cA = { x: W * 0.02, y: hillTopY + off };
  const cB = { x: xRimL + 6, y: rimY + off * 0.9 };
  const thick = 16;
  const ang = Math.atan2(cB.y - cA.y, cB.x - cA.x);
  const len = Math.hypot(cB.x - cA.x, cB.y - cA.y);
  ctx.save();
  ctx.translate(cA.x, cA.y);
  ctx.rotate(ang);
  ctx.fillStyle = p.glass;
  ctx.fillRect(0, -thick / 2, len, thick);
  const fillH = Math.min(m.hillFill, 1) * thick;
  ctx.fillStyle = rampColor(m.hillFill);
  ctx.fillRect(0, thick / 2 - fillH, len, fillH);
  flowChevrons(ctx, 0, len, thick / 2 - fillH / 2, t, 1 + m.hillFill * 3, 'rgba(255,255,255,0.9)', 4);
  ctx.strokeStyle = p.wall;
  ctx.lineWidth = 2;
  ctx.strokeRect(0, -thick / 2, len, thick);
  ctx.restore();
  label(ctx, 'Synthetic Gravity Conduit', W * 0.17, slopeY(W * 0.17) + off + 22, p.text, { size: 10, weight: 700, align: 'center', bg: p.panel });

  // drop shafts + runoff arrows
  for (const fx of [0.12, 0.24]) {
    const x = W * fx;
    const sTop = slopeY(x);
    const sBot = sTop + off - thick / 2;
    ctx.fillStyle = p.glass;
    ctx.fillRect(x - 5, sTop, 10, sBot - sTop);
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 5, sTop, 10, sBot - sTop);
  }
  if (m.rain > 0.05) {
    ctx.save();
    ctx.strokeStyle = p.rain;
    ctx.lineWidth = 2;
    const n = 4 + Math.round(m.rain / 40);
    for (let k = 0; k < n; k++) {
      const f = ((t * 0.18 + k / n) % 1) * 0.3;
      const x = W * f;
      const y = slopeY(x) - 5;
      const dx = 10 * Math.cos(Math.atan2(rimY - hillTopY, xHill1));
      const dy = 10 * Math.sin(Math.atan2(rimY - hillTopY, xHill1));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);
      ctx.lineTo(x + dx - 4, y + dy - 4);
      ctx.moveTo(x + dx, y + dy);
      ctx.lineTo(x + dx - 5, y + dy + 1);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- lagoon bowl
  const lag = Math.max(m.lagoonDepth, 0);
  const frac = Math.min(lag / m.lagoonMax, 1);
  const wY = floorY - frac * (floorY - rimY);
  const overflow = lag > m.lagoonMax;
  const xAt = (y: number, left: boolean) => {
    const f = (y - rimY) / (floorY - rimY);
    return left ? xRimL + (xFloorL - xRimL) * f : xRimR + (xFloorR - xRimR) * f;
  };
  if (lag > 0.02) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xRimL, rimY);
    ctx.lineTo(xFloorL, floorY);
    ctx.lineTo(xFloorR, floorY);
    ctx.lineTo(xRimR, rimY);
    ctx.closePath();
    ctx.clip();
    waterPath(ctx, xAt(wY, true) - 4, xAt(wY, false) + 4, wY, floorY + 2, m.rain > 0 ? 1.5 + m.rain / 80 : 0.8, t, 1.3);
    ctx.fillStyle = waterGradient(ctx, wY, floorY, p, overflow ? 0.5 + 0.5 * Math.sin(t * 5) : 0);
    ctx.fill();
    ctx.restore();
  }
  if (overflow) {
    ctx.fillStyle = `rgba(239,68,68,${0.4 + 0.25 * Math.sin(t * 5)})`;
    ctx.fillRect(xRimL - 60, rimY - 5, xRimR - xRimL + 120, 6);
  }
  ctx.strokeStyle = p.wall;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(xRimL, rimY);
  ctx.lineTo(xFloorL, floorY);
  ctx.lineTo(xFloorR, floorY);
  ctx.lineTo(xRimR, rimY);
  ctx.stroke();
  label(ctx, 'City Camp Lagoon Catchment', (xRimL + xRimR) / 2, rimY - 22, p.text, { size: 12, weight: 800, align: 'center', bg: p.panel });
  label(ctx, `${lag.toFixed(2)} m / ${m.lagoonMax} m`, (xRimL + xRimR) / 2, Math.min(wY + 16, floorY - 14), overflow ? p.danger : p.text, { size: 11, weight: 800, align: 'center', mono: true, bg: p.panel });

  // ---- trash rack at the bottom-right of the bowl
  const rackX = xFloorR - 30;
  const glow = Math.min(m.blockagePct / 95, 1);
  ctx.save();
  if (glow > 0.05) {
    const g = ctx.createRadialGradient(rackX + 14, floorY - 18, 2, rackX + 14, floorY - 18, 40);
    g.addColorStop(0, `rgba(249,115,22,${0.55 * glow})`);
    g.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.fillStyle = g;
    ctx.fillRect(rackX - 30, floorY - 60, 90, 70);
  }
  ctx.strokeStyle = glow > 0.6 ? '#EF4444' : glow > 0.25 ? '#F59E0B' : p.wall;
  ctx.lineWidth = 2.5;
  for (let k = 0; k < 7; k++) {
    ctx.beginPath();
    ctx.moveTo(rackX + k * 4, floorY);
    ctx.lineTo(rackX + k * 4 + 10, floorY - 34);
    ctx.stroke();
  }
  ctx.fillStyle = '#7C5A2E';
  for (let k = 0; k < Math.round(glow * 12); k++) {
    ctx.beginPath();
    ctx.arc(rackX + 2 + (k % 6) * 5, floorY - 4 - Math.floor(k / 6) * 7, 3.6, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  label(ctx, `Trash Rack Intake · ${m.blockagePct.toFixed(0)}%`, rackX + 8, floorY + 14, p.text, { size: 10, weight: 700, align: 'center', bg: p.panel });

  // ---- tunnel: concreted 2.5×2.7 -> rock choke 1.5×1.7 -> concreted -> Crystal Cave
  const ty = (x: number) => floorY - 22 + ((x - xFloorR) / (W - xFloorR)) * 26;
  const segs = [
    { x0: xFloorR, x1: W * 0.73, h: 26, fill: m.tunnelFill, label: '2.5 m × 2.7 m concreted' },
    { x0: W * 0.73, x1: W * 0.82, h: 15, fill: m.chokeFill, label: '1.5 m × 1.7 m rock choke' },
    { x0: W * 0.82, x1: W * 0.975, h: 26, fill: m.downstreamFill, label: '' },
  ];
  segs.forEach((s, i) => {
    const yc = (ty(s.x0) + ty(s.x1)) / 2;
    ctx.fillStyle = i === 1 ? p.rock : p.glass;
    ctx.fillRect(s.x0, yc - s.h / 2, s.x1 - s.x0, s.h);
    const fh = Math.min(s.fill, 1) * s.h;
    ctx.fillStyle = waterGradient(ctx, yc + s.h / 2 - fh, yc + s.h / 2, p, s.fill > 0.94 ? 0.5 + 0.5 * Math.sin(t * 6) : 0);
    ctx.fillRect(s.x0, yc + s.h / 2 - fh, s.x1 - s.x0, fh);
    flowChevrons(ctx, s.x0, s.x1, yc + s.h / 2 - fh / 2, t, m.tunnelVelocity, 'rgba(255,255,255,0.9)', 4);
    ctx.strokeStyle = i === 1 ? '#B45309' : p.wall;
    ctx.lineWidth = 2;
    ctx.strokeRect(s.x0, yc - s.h / 2, s.x1 - s.x0, s.h);
    if (s.label) label(ctx, s.label, (s.x0 + s.x1) / 2, yc - s.h / 2 - 12, i === 1 ? '#B45309' : p.text, { size: 10, weight: 700, align: 'center', bg: p.panel });
  });
  const portalX = W * 0.975;
  ctx.fillStyle = p.text;
  ctx.beginPath();
  ctx.arc(portalX + 6, ty(portalX) - 2, 12, Math.PI * 0.5, Math.PI * 1.5);
  ctx.fill();
  label(ctx, '2.3 km Drain Tunnel to Crystal Cave ⟶', W * 0.8, H - 36, p.text, { size: 12, weight: 800, align: 'center', bg: p.panel });

  // ---- Edge-AI manhole node zoom callout (magnifying glass on the hillside shaft)
  const tx = W * 0.24;
  const ttop = slopeY(tx);
  const R = Math.min(H * 0.2, W * 0.1, 95);
  const cx = W * 0.15;
  const cy = Math.min(H - R - 18, rimY + R * 0.65 + 20);
  ctx.save();
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(tx, ttop + 10);
  ctx.lineTo(cx + R * 0.7, cy - R * 0.7);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fillStyle = p.sky1;
  ctx.fill();
  ctx.clip();
  // mini scene inside the lens
  const sY = cy - R * 0.45;
  ctx.fillStyle = p.soil;
  ctx.fillRect(cx - R, sY, 2 * R, 2 * R);
  hatch(ctx, cx - R, sY + 6, 2 * R, 2 * R, p.hatch, 9);
  ctx.fillStyle = p.street;
  ctx.fillRect(cx - R, sY, 2 * R, 6);
  rainStreaks(ctx, cx - R, cy - R, 2 * R, sY - (cy - R), m.rain, t, p.rain);
  const shW = R * 0.36;
  const pTop = cy + R * 0.32;
  const pBot = cy + R * 0.62;
  ctx.fillStyle = p.glass;
  ctx.fillRect(cx - shW / 2, sY + 6, shW, pTop - sY - 6);
  ctx.fillRect(cx - R, pTop, 2 * R, pBot - pTop);
  const lvl = Math.min(m.hillFill, 1.27);
  const pipeLvl = Math.min(lvl, 1);
  ctx.fillStyle = waterGradient(ctx, pBot - pipeLvl * (pBot - pTop), pBot, p, m.hillFill > 0.94 ? 0.6 : 0);
  ctx.fillRect(cx - R, pBot - pipeLvl * (pBot - pTop), 2 * R, pipeLvl * (pBot - pTop));
  if (lvl > 1) ctx.fillRect(cx - shW / 2, pTop - (lvl - 1) * (pTop - sY), shW, (lvl - 1) * (pTop - sY));
  ctx.strokeStyle = p.wall;
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - shW / 2, sY + 6, shW, pTop - sY - 6);
  ctx.beginPath();
  ctx.moveTo(cx - R, pTop);
  ctx.lineTo(cx - shW / 2, pTop);
  ctx.moveTo(cx + shW / 2, pTop);
  ctx.lineTo(cx + R, pTop);
  ctx.moveTo(cx - R, pBot);
  ctx.lineTo(cx + R, pBot);
  ctx.stroke();
  const surgeY = pBot - 0.6 * (pBot - pTop);
  ctx.strokeStyle = p.danger;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(cx - R, surgeY);
  ctx.lineTo(cx + R, surgeY);
  ctx.stroke();
  ctx.setLineDash([]);
  const sensY = sY + 18;
  mcuAndSensor(ctx, cx, sensY, sY + 12, cx + shW / 2 + 18, t, p, 0.62, false);
  acousticPings(ctx, cx, sensY + 3, pBot - pipeLvl * (pBot - pTop), t, p, shW * 0.8);
  gateway(ctx, cx + R * 0.62, sY, t, p, 0.45);
  ctx.restore();
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.stroke();
  // magnifier handle
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - R * 0.72, cy + R * 0.72);
  ctx.lineTo(cx - R * 1.05, cy + R * 1.05);
  ctx.stroke();
  ctx.lineCap = 'butt';
  label(ctx, 'Edge-AI Manhole Node', cx, cy - R - 12, p.text, { size: 11, weight: 800, align: 'center', bg: p.panel });
  label(ctx, 'AS923-3 LoRaWAN Gateway', cx + R + 8, cy - R * 0.55, p.dim, { size: 9, bg: p.panel });
  label(ctx, 'ESP32-S3 MCU', cx + R + 8, cy - R * 0.25, p.dim, { size: 9, bg: p.panel });
  label(ctx, 'A02YYUW Ultrasonic Sensor', cx + R + 8, cy + R * 0.05, p.dim, { size: 9, bg: p.panel });
  label(ctx, 'Blockage Surge', cx + R + 8, cy + R * 0.35, p.danger, { size: 9, bg: p.panel });
  label(ctx, m.hillAnomaly, cx, cy + R + 14, p.accent, { size: 10, weight: 800, align: 'center', mono: true, bg: p.panel });
  if (m.draining) label(ctx, 'DRAINING NETWORK…', W / 2, 18, p.accent, { size: 12, weight: 800, align: 'center', bg: p.panel });
}
