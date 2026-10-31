// api/esp32.js: the Vercel function behind firmware/vercel_baseline_test.
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS function, outside the TypeScript project
import handler from '../../api/esp32.js';

function call(req: { method: string; body?: unknown }) {
  const out = { code: 0, json: null as Record<string, unknown> | null, headers: {} as Record<string, string> };
  const res = {
    status(c: number) {
      out.code = c;
      return res;
    },
    json(j: Record<string, unknown>) {
      out.json = j;
      return res;
    },
    setHeader(k: string, v: string) {
      out.headers[k] = v;
    },
  };
  handler(req, res);
  return out;
}

/** Exactly what the sketch's snprintf produces. */
const sketchBody = (s: string) => JSON.parse(s) as unknown;

describe('api/esp32.js', () => {
  it('answers GET so the deployment can be checked from a browser', () => {
    expect(call({ method: 'GET' })).toMatchObject({ code: 200, json: { ok: true, service: 'esp32-baseline' } });
  });
  it('echoes a sketch reading and logs it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const body = sketchBody('{"device":"EN-08","level":"NORMAL","dist_mm":141.2,"fill_pct":22.4,"seq":3,"rssi":-58,"uptime_s":42}');
    const r = call({ method: 'POST', body });
    expect(r.code).toBe(200);
    expect(r.json).toMatchObject({ ok: true, device: 'EN-08', level: 'NORMAL', dist_mm: 141.2, fill_pct: 22.4, seq: 3, rssi: -58, uptime_s: 42 });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][1]).toContain('"fill_pct":22.4');
    log.mockRestore();
  });
  it('flags an alarm in the log as a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = sketchBody('{"device":"EN-08","level":"ALARM","dist_mm":60.0,"fill_pct":87.2,"seq":4,"rssi":-58,"uptime_s":52}');
    expect(call({ method: 'POST', body }).code).toBe(200);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it('accepts a no-echo frame: a sensor fault must not look like a broken link', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const body = sketchBody('{"device":"EN-08","level":"NO_ECHO","dist_mm":null,"fill_pct":null,"seq":5,"rssi":-58,"uptime_s":62}');
    expect(call({ method: 'POST', body })).toMatchObject({ code: 200, json: { level: 'NO_ECHO', dist_mm: null, fill_pct: null } });
    log.mockRestore();
  });
  it('rejects bad requests without logging their content', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(call({ method: 'POST', body: { device: 'EN-08', level: 'PANIC' } }).code).toBe(422);
    expect(call({ method: 'POST', body: { device: 'bad device\n', level: 'ALARM' } }).code).toBe(422);
    expect(call({ method: 'POST', body: null }).code).toBe(422);
    const malformed = {
      method: 'POST',
      get body(): unknown {
        throw new SyntaxError('Invalid JSON');
      },
    };
    expect(call(malformed).code).toBe(400);
    const put = call({ method: 'PUT' });
    expect(put.code).toBe(405);
    expect(put.headers.Allow).toBe('GET, POST');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
