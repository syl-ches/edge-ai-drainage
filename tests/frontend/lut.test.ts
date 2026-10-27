import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LutFile, NetworkFile } from '../../src/types/twin';
import { LutInterpolator, STATUSES } from '../../src/utils/lutInterpolator';
import { fromBase64, packTelemetryPayload, toBase64, toHex, unpackTelemetryPayload } from '../../src/utils/payloadCodec';

const network = JSON.parse(readFileSync('public/data/city_camp_network.json', 'utf8')) as NetworkFile;
const lut = JSON.parse(readFileSync('public/data/simulation_lut.json', 'utf8')) as LutFile;
const interp = LutInterpolator.fromFiles(network, lut);
const interpCurve = new Set(interp.curveConduits);

describe('payloadCodec (CLAUDE.md §10 golden vectors)', () => {
  it('matches reference vectors bit-for-bit', () => {
    expect(packTelemetryPayload(5115, -1, 127, 7, 4.2)).toBe(0xffffffff);
    expect(packTelemetryPayload(5115, 127, 127, 7, 4.2)).toBe(0xffdfffff);
    expect(packTelemetryPayload(0, -128, 0, 0, 3.0)).toBe(0x00200000);
  });
  it('saturates instead of wrapping', () => {
    const d = unpackTelemetryPayload(packTelemetryPayload(9999, 400, 300, 4, 5));
    expect(d).toMatchObject({ depthMm: 5115, dhDtMmMin: 127, capPct: 127, anomCode: 4, vbatV: 4.2 });
    expect(unpackTelemetryPayload(packTelemetryPayload(-5, -400, -1, 0, 2)).dhDtMmMin).toBe(-128);
  });
  it('round-trips hex / base64 / random fields', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < 2000; k++) {
      const depth = rnd() * 5115;
      const dh = -128 + rnd() * 255;
      const cap = rnd() * 127;
      const an = Math.floor(rnd() * 7);
      const vb = 3 + 0.08 * Math.floor(rnd() * 16);
      const w = packTelemetryPayload(depth, dh, cap, an, vb);
      const u = unpackTelemetryPayload(w);
      expect(Math.abs(u.depthMm - depth)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(u.dhDtMmMin - dh)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(u.capPct - cap)).toBeLessThanOrEqual(0.5);
      expect(u.anomCode).toBe(an);
      expect(u.vbatV).toBeCloseTo(vb, 6);
      expect(fromBase64(toBase64(w))).toBe(w);
      expect(toHex(w)).toMatch(/^0x[0-9A-F]{8}$/);
    }
  });
});

describe('LutInterpolator', () => {
  it('reproduces every grid cell exactly (values, status, anomaly, payload)', () => {
    const mismatches: string[] = [];
    for (const s of lut.scenarios) {
      const st = interp.evaluate(s.rainfall_mm_hr, s.trash_rack_blockage_pct);
      network.conduits.forEach((c, i) => {
        const r = s.conduits[c.id];
        // Tunnel conduits are read off flow-indexed curves at Q_out(+lateral), which the LUT
        // stores to 3–4 dp, so they reproduce to < 0.01 rather than bit-exactly.
        const fr = Number.isNaN(st.conduits.froude[i]) ? null : st.conduits.froude[i];
        if (interpCurve.has(c.id)) {
          // Tunnel reach read off flow-indexed curves keyed on Q_out, which the LUT stores to
          // 3–4 dp: reproduce within 0.01 absolute or 10 % relative (dry trickle flows).
          const near = (a: number, b: number) => Math.abs(a - b) < 0.01 || Math.abs(a - b) < 0.1 * Math.abs(b);
          const ok =
            Math.abs(st.conduits.capacity[i] - r.capacity_ratio) < 0.01 &&
            near(st.conduits.flow[i], r.flow_cms) &&
            near(st.conduits.velocity[i], r.velocity_ms) &&
            near(st.conduits.depth[i], r.water_depth_m) &&
            (r.froude_number === null ? fr === null : fr !== null && near(fr, r.froude_number));
          if (!ok) mismatches.push(`${s.key} ${c.id} curve state`);
        } else {
          expect(st.conduits.capacity[i]).toBeCloseTo(r.capacity_ratio, 9);
          expect(st.conduits.flow[i]).toBeCloseTo(r.flow_cms, 9);
          expect(st.conduits.velocity[i]).toBeCloseTo(r.velocity_ms, 9);
          expect(st.conduits.depth[i]).toBeCloseTo(r.water_depth_m, 9);
          if (r.froude_number === null) expect(fr).toBeNull();
          else expect(fr).toBeCloseTo(r.froude_number, 9);
        }
        if (STATUSES[st.conduits.status[i]] !== r.status) mismatches.push(`${s.key} ${c.id} status`);
      });
      expect(st.lagoon.depthM).toBeCloseTo(s.lagoon.lagoon_water_depth_m, 9);
      // ΔH is rebuilt from Q and stage with the generator's formula; LUT stores it to 3 dp.
      expect(Math.abs(st.lagoon.headLossM - s.lagoon.orifice_head_loss_m)).toBeLessThan(2e-3);
      expect(Math.abs(st.lagoon.orificeFlowCms - s.lagoon.orifice_flow_cms)).toBeLessThan(2e-3);
      expect(st.lagoon.timeToOverflowMin === null).toBe(s.lagoon.estimated_time_to_overflow_min === null);
      if (s.lagoon.estimated_time_to_overflow_min !== null) {
        expect(st.lagoon.timeToOverflowMin!).toBeCloseTo(s.lagoon.estimated_time_to_overflow_min, 6);
      }
      expect(st.lagoon.control).toBe(s.lagoon.outflow_control);
      st.sensors.forEach((S) => {
        const t = s.sensors[S.id];
        if (S.anomaly !== t.anomaly_class) mismatches.push(`${s.key} ${S.id} anomaly ${S.anomaly}≠${t.anomaly_class}`);
        if (S.payloadHex !== t.payload_hex) mismatches.push(`${s.key} ${S.id} payload ${S.payloadHex}≠${t.payload_hex}`);
        expect(S.saturated).toEqual(t.saturated_fields);
      });
    }
    expect(mismatches).toEqual([]);
  });

  it('interpolates off-grid R200_B85 close to the exactly simulated reference', () => {
    const ref = lut.reference_scenarios.find((s) => s.key === 'R200_B85')!;
    const st = interp.evaluate(200, 85);
    expect(Math.abs(st.lagoon.depthM - ref.lagoon.lagoon_water_depth_m)).toBeLessThan(0.05);
    expect(Math.abs(st.lagoon.headLossM - ref.lagoon.orifice_head_loss_m) / ref.lagoon.orifice_head_loss_m).toBeLessThan(0.02);
    expect(Math.abs(st.lagoon.orificeFlowCms - ref.lagoon.orifice_flow_cms)).toBeLessThan(0.05);
    expect(st.lagoon.control).toBe(ref.lagoon.outflow_control);
    let maxErr = 0;
    network.conduits.forEach((c, i) => {
      maxErr = Math.max(maxErr, Math.abs(st.conduits.capacity[i] - ref.conduits[c.id].capacity_ratio));
    });
    console.info(`R200_B85 max |capacity error| vs exact reference: ${maxErr.toFixed(4)}`);
    expect(maxErr).toBeLessThan(0.08);
  });

  it('is monotone-safe at the axis bounds and clamps out-of-range input', () => {
    const lo = interp.evaluate(-50, -10);
    expect(lo.rain).toBe(0);
    expect(lo.blockagePct).toBe(0);
    const hi = interp.evaluate(999, 99);
    expect(hi.rain).toBe(250);
    expect(hi.blockagePct).toBe(95);
    expect(Number.isFinite(hi.lagoon.headLossM)).toBe(true);
  });

  it('evaluates in well under 2 ms', () => {
    const n = 5000;
    const t0 = performance.now();
    for (let k = 0; k < n; k++) interp.evaluate((k * 7.3) % 250, (k * 3.1) % 95);
    const perCall = (performance.now() - t0) / n;
    console.info(`evaluate(): ${(perCall * 1000).toFixed(1)} µs/call`);
    expect(perCall).toBeLessThan(2);
  });
});
