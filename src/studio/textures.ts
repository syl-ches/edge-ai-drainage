// Procedural canvas textures for the Ultra-HD Pitch Studio (no image assets): geological strata
// (colour + bump), asphalt, paving tiles, turf, slotted cast-iron grates, PCB silkscreens, labels
// and glow halos. Every texture is generated once at high resolution with anisotropic filtering.
import { CanvasTexture, ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace, NoColorSpace, type Texture } from 'three';

let seed = 20240917;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, color = true, repeat = false): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** Stratum boundaries (depth below the surface, m) of the cutaway block (9.5 m deep). */
export const STRATA = [
  { name: 'Road sub-base & concrete bedding', top: 0, bottom: 0.6, color: '#c9ced4', grain: '#aeb5bd' },
  { name: 'Compacted mountain topsoil', top: 0.6, bottom: 2.2, color: '#3b2a1e', grain: '#5b4331' },
  { name: 'Weathered clay-gravel regolith', top: 2.2, bottom: 5.0, color: '#7a6450', grain: '#9a8268' },
  { name: 'Mirador karst limestone bedrock', top: 5.0, bottom: 9.5, color: '#d9d6cc', grain: '#b9b4a6' },
] as const;
export const BLOCK_DEPTH_M = 9.5;

/** Strata colour + bump textures, v = 0 at the base, v = 1 at the surface. */
export function strataTextures(): { map: Texture; bump: Texture } {
  const W = 2048;
  const H = 1024;
  const [cc, c] = canvas(W, H);
  const [bc, b] = canvas(W, H);
  const yOf = (depth: number) => (depth / BLOCK_DEPTH_M) * H;
  for (const s of STRATA) {
    const y0 = yOf(s.top);
    const y1 = yOf(s.bottom);
    c.fillStyle = s.color;
    c.fillRect(0, y0, W, y1 - y0);
    b.fillStyle = '#808080';
    b.fillRect(0, y0, W, y1 - y0);
    const n = Math.round(((y1 - y0) * W) / 220);
    for (let k = 0; k < n; k++) {
      const x = rnd() * W;
      const y = y0 + rnd() * (y1 - y0);
      const r = s.name.startsWith('Weathered') ? 2 + rnd() * 9 : s.name.startsWith('Compacted') ? 1 + rnd() * 3 : 1 + rnd() * 2.5;
      c.fillStyle = rnd() < 0.5 ? s.grain : s.color;
      c.globalAlpha = 0.55 + rnd() * 0.45;
      c.beginPath();
      c.ellipse(x, y, r * (1 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
      b.fillStyle = rnd() < 0.5 ? '#b8b8b8' : '#4a4a4a';
      b.beginPath();
      b.ellipse(x, y, r * (1 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2);
      b.fill();
    }
    c.globalAlpha = 1;
    // stratum contact: crisp darker line with a little relief
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(0, y1 - 3, W, 3);
    b.fillStyle = '#2a2a2a';
    b.fillRect(0, y1 - 4, W, 4);
  }
  // chiselled limestone blocks (joints + bedding planes)
  const ly0 = yOf(5.0);
  c.strokeStyle = 'rgba(80,74,64,0.55)';
  b.strokeStyle = '#202020';
  c.lineWidth = b.lineWidth = 3;
  for (let y = ly0 + 60; y < H; y += 70 + rnd() * 40) {
    for (const ctx of [c, b]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= W; x += 64) ctx.lineTo(x, y + (rnd() - 0.5) * 8);
      ctx.stroke();
    }
  }
  for (let k = 0; k < 90; k++) {
    const x = rnd() * W;
    const y = ly0 + rnd() * (H - ly0);
    const h = 30 + rnd() * 60;
    for (const ctx of [c, b]) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rnd() - 0.5) * 14, y + h);
      ctx.stroke();
    }
  }
  // drawn top = surface; CanvasTexture's default flipY maps the canvas top to v = 1
  return { map: tex(cc, true), bump: tex(bc, false) };
}

function noisy(base: string, speck: string[], w: number, h: number, n: number, r: [number, number]): HTMLCanvasElement {
  const [cv, c] = canvas(w, h);
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);
  for (let k = 0; k < n; k++) {
    c.fillStyle = speck[Math.floor(rnd() * speck.length)];
    c.globalAlpha = 0.25 + rnd() * 0.5;
    c.fillRect(rnd() * w, rnd() * h, r[0] + rnd() * (r[1] - r[0]), r[0] + rnd() * (r[1] - r[0]));
  }
  c.globalAlpha = 1;
  return cv;
}

export function asphaltTexture(): Texture {
  const t = tex(noisy('#2b313a', ['#3a414c', '#1f242b', '#4a515c', '#262b33'], 1024, 1024, 26000, [1, 3]), true, true);
  t.repeat.set(4, 4);
  return t;
}

export function pavingTexture(): Texture {
  const [cv, c] = canvas(1024, 1024);
  c.drawImage(noisy('#cfd4d8', ['#bfc5ca', '#dde1e4'], 1024, 1024, 9000, [1, 3]), 0, 0);
  c.strokeStyle = '#9aa3ab';
  c.lineWidth = 4;
  for (let i = 0; i <= 1024; i += 128) {
    c.beginPath();
    c.moveTo(i, 0);
    c.lineTo(i, 1024);
    c.stroke();
    c.beginPath();
    c.moveTo(0, i);
    c.lineTo(1024, i);
    c.stroke();
  }
  const t = tex(cv, true, true);
  t.repeat.set(3, 3);
  return t;
}

export function turfTexture(): Texture {
  const t = tex(noisy('#3f8f3a', ['#4ca646', '#2f7a2c', '#5cb85a', '#357f30'], 1024, 1024, 40000, [1, 4]), true, true);
  t.repeat.set(3, 3);
  return t;
}

/** Slotted cast-iron grate (alpha map: slots are transparent so the shaft shows through). */
export function grateTextures(): { map: Texture; alpha: Texture } {
  const S = 1024;
  const [cv, c] = canvas(S, S);
  const [av, a] = canvas(S, S);
  c.drawImage(noisy('#3b3f45', ['#4b5058', '#2c2f34', '#5a5f66'], S, S, 12000, [1, 3]), 0, 0);
  a.fillStyle = '#ffffff';
  a.fillRect(0, 0, S, S);
  a.fillStyle = '#000000';
  c.strokeStyle = '#6b7079';
  c.lineWidth = 10;
  c.beginPath();
  c.arc(S / 2, S / 2, S / 2 - 12, 0, Math.PI * 2);
  c.stroke();
  for (let k = -5; k <= 5; k++) {
    const x = S / 2 + k * 70;
    const half = Math.sqrt(Math.max((S / 2 - 70) ** 2 - (x - S / 2) ** 2, 0));
    a.fillRect(x - 18, S / 2 - half, 36, 2 * half);
    c.fillStyle = '#0b0d10';
    c.fillRect(x - 18, S / 2 - half, 36, 2 * half);
  }
  return { map: tex(cv, true), alpha: tex(av, false) };
}

/** Silkscreen / label texture for PCBs, enclosures and tank etchings. */
export function labelTexture(lines: string[], opts: { w?: number; h?: number; bg?: string; fg?: string; font?: string; align?: CanvasTextAlign } = {}): Texture {
  const w = opts.w ?? 1024;
  const h = opts.h ?? 256;
  const [cv, c] = canvas(w, h);
  if (opts.bg) {
    c.fillStyle = opts.bg;
    c.fillRect(0, 0, w, h);
  }
  c.fillStyle = opts.fg ?? '#ffffff';
  c.font = opts.font ?? `700 ${Math.round(h / (lines.length + 1))}px Inter, "Segoe UI", Arial, sans-serif`;
  c.textAlign = opts.align ?? 'center';
  c.textBaseline = 'middle';
  const x = c.textAlign === 'left' ? w * 0.04 : w / 2;
  lines.forEach((ln, i) => c.fillText(ln, x, ((i + 1) * h) / (lines.length + 1)));
  return tex(cv, true);
}

export function haloTexture(): Texture {
  const [cv, c] = canvas(256, 256);
  const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 256, 256);
  return tex(cv, true);
}

/** Vertical streaks for the falling waterfall / pour stream (scrolled via offset). */
export function streamTexture(): Texture {
  const [cv, c] = canvas(256, 1024);
  c.fillStyle = 'rgba(186,230,253,0.55)';
  c.fillRect(0, 0, 256, 1024);
  for (let k = 0; k < 220; k++) {
    c.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.6})`;
    c.fillRect(rnd() * 256, rnd() * 1024, 2 + rnd() * 5, 30 + rnd() * 120);
  }
  const t = tex(cv, true, true);
  return t;
}
