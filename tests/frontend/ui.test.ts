// UI conventions: no native OS emoji anywhere in rendered components (icons are SVG only).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|html)$/.test(f) ? [p] : [];
  });
}

/**
 * Emoji = Extended_Pictographic code points (incl. arrows with an emoji variant such as U+2197),
 * except the typographic marks © ® ™ that map attributions legally require.
 */
const EMOJI = /(?![©®™])\p{Extended_Pictographic}/u;
// The PDF sanitizer's lookup table maps such input characters to plain text on purpose.
const ALLOW = new Set([join('src', 'utils', 'reportSurface.ts')]);

describe('iconography', () => {
  it('ships zero native OS emoji in the UI source', () => {
    const hits: string[] = [];
    for (const f of [...files('src'), 'index.html']) {
      if (ALLOW.has(f)) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          if (EMOJI.test(line)) hits.push(`${f}:${i + 1}: ${t.slice(0, 80)}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
