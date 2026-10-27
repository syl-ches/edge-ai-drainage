// Phase 7B: TypeScript ports locked to the Python reference via golden fixtures
// (scripts/gen_frontend_goldens.py), plus the forecaster's physical invariants.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LutFile, NetworkFile } from '../../src/types/twin';
import { STGNNForecaster, fewsFactors, hyetographRate, type Forecast, type ForecastInput, type PrecipLibrary } from '../../src/forecast/stgnn';
import { newKalman, runCycle } from '../../src/edge/edgePipeline';
import { parseOpenMeteoTrajectory } from '../../src/live/weather';

const read = <T,>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
const network = read<NetworkFile>('public/data/city_camp_network.json');
const lut = read<LutFile>('public/data/simulation_lut.json');
const library = read<PrecipLibrary>('public/data/precip_library.json');
const stgnnGolden = read<{ cases: { name: string; input: ForecastInput; output: Forecast }[] }>('tests/frontend/fixtures/stgnn_golden.json');
const edgeGolden = read<{
  cases: { name: string; config: { full_scale_m: number; mount_mm: number; standpipe: boolean; pipe_height_mm: number; dt_min: number; temp_c: number; vbat_v: number }; steps: Record<string, unknown>[] }[];
}>('tests/frontend/fixtures/edge_golden.json');
const weatherGolden = read<{ cases: { name: string; payload: unknown; output: { trajectory_mm_hr: number[]; current_mm_hr: number } }[] }>(
  'tests/frontend/fixtures/weather_golden.json',
);
const forecaster = new STGNNForecaster(network, library, lut.meta.tunnel_conveyance_limit_cms);

describe('ST-GNN forecaster: TypeScript == backend/stgnn.py', () => {
  for (const c of stgnnGolden.cases) {
    it(`reproduces ${c.name}`, () => {
      const out = forecaster.forecast(c.input);
      const ref = c.output;
      expect(out.graph).toEqual(ref.graph);
      expect(out.members).toBe(ref.members);
      if (ref.time_to_overflow_min === null) expect(out.time_to_overflow_min).toBeNull();
      else expect(out.time_to_overflow_min).toBeCloseTo(ref.time_to_overflow_min, 0);
      out.horizons.forEach((h, i) => {
        const r = ref.horizons[i];
        expect(h.minutes).toBe(r.minutes);
        for (const k of ['lagoon_depth_m', 'lagoon_depth_p05_m', 'lagoon_depth_p95_m', 'surface_elev_m'] as const) expect(Math.abs(h[k] - r[k])).toBeLessThanOrEqual(0.002);
        expect(h.surcharge_probability_pct).toBe(r.surcharge_probability_pct);
        expect(Math.abs(h.conduits_over_capacity - r.conduits_over_capacity)).toBeLessThanOrEqual(1);
        expect(h.next_bottleneck.sensor_id).toBe(r.next_bottleneck.sensor_id);
        expect(h.next_bottleneck.minutes_to_critical).toBe(r.next_bottleneck.minutes_to_critical);
        for (const [sid, s] of Object.entries(r.sensors)) {
          expect(Math.abs(h.sensors[sid].capacity_pct - s.capacity_pct)).toBeLessThanOrEqual(0.2);
          expect(Math.abs(h.sensors[sid].p95 - s.p95)).toBeLessThanOrEqual(0.2);
          expect(h.sensors[sid].surcharge_probability_pct).toBe(s.surcharge_probability_pct);
        }
      });
    });
  }

  it('builds the 65 x 65 hydrological adjacency with one gate per conduit', () => {
    const v = network.conduits.filter((c) => c.is_active).map(() => 1);
    const a = forecaster.adjacency(v);
    expect(a.length).toBe(65);
    const nz = a.flatMap((row) => [...row]).filter((x) => x > 0);
    expect(nz.length).toBe(63);
    expect(nz.every((g) => g > 0 && g < 1)).toBe(true);
  });

  it('weights the FEWS gauges to a basin mean of 1 with uphill nodes wetter', () => {
    const nodes = network.nodes.filter((n) => n.is_active);
    const f = fewsFactors(nodes, library);
    let a = 0;
    let m = 0;
    nodes.forEach((n, i) => {
      if (n.type === 'STORAGE') return;
      a += n.catchment_area_ha;
      m += f[i] * n.catchment_area_ha;
    });
    expect(m / a).toBeCloseTo(1, 9);
    const hi = nodes.reduce((b, n, i) => (n.rim_elev_m > nodes[b].rim_elev_m ? i : b), 0);
    const lo = nodes.reduce((b, n, i) => (n.rim_elev_m < nodes[b].rim_elev_m && n.type !== 'STORAGE' ? i : b), 0);
    expect(f[hi]).toBeGreaterThan(f[lo]);
  });

  it('is monotone: heavier forecast rain never lowers the lagoon or any sensor', () => {
    const base = stgnnGolden.cases.find((c) => c.name === 'steady_R25_B0')!.input;
    const lo = forecaster.forecast(base);
    const hi = forecaster.forecast({ ...base, rain_mm_hr: base.rain_mm_hr.map((r) => r * 3), persist_rain_mm_hr: 75 });
    lo.horizons.forEach((h, i) => {
      expect(hi.horizons[i].lagoon_depth_m).toBeGreaterThanOrEqual(h.lagoon_depth_m);
      for (const sid of Object.keys(h.sensors)) expect(hi.horizons[i].sensors[sid].capacity_pct).toBeGreaterThanOrEqual(h.sensors[sid].capacity_pct - 1e-9);
      expect(h.lagoon_depth_p05_m).toBeLessThanOrEqual(h.lagoon_depth_m);
      expect(h.lagoon_depth_m).toBeLessThanOrEqual(h.lagoon_depth_p95_m);
    });
  });

  it('replays the historical storm library', () => {
    const ids = library.storms.map((s) => s.id);
    expect(ids).toEqual(['DESIGN_TYPHOON_12H', 'OMPONG_2018', 'KRISTINE_EGAY_OROGRAPHIC', 'AFTERNOON_CLOUDBURST', 'HABAGAT_MONSOON']);
    const burst = library.storms.find((s) => s.id === 'AFTERNOON_CLOUDBURST')!;
    expect(hyetographRate(burst, 35)).toBeGreaterThan(140);
    expect(hyetographRate(burst, 5)).toBeCloseTo((burst.rate_mm_hr[0] + burst.rate_mm_hr[1]) / 2, 9);
    expect(library.storms.every((s) => s.synthetic)).toBe(true);
  });
});

describe('edge pipeline: TypeScript == backend/edge_dsp.py::run_cycle', () => {
  for (const c of edgeGolden.cases) {
    it(`reproduces ${c.name}`, () => {
      const cfg = { fullScaleM: c.config.full_scale_m, mountMm: c.config.mount_mm, standpipe: c.config.standpipe, pipeHeightMm: c.config.pipe_height_mm, vbatV: c.config.vbat_v };
      const kal = newKalman();
      for (const s of c.steps) {
        const r = runCycle(cfg, kal, s.raw_mm as number[], c.config.temp_c, c.config.dt_min);
        expect(r.d_med_mm).toBeCloseTo(s.d_med_mm as number, 6);
        expect(r.sigma_d2).toBeCloseTo(s.sigma_d2 as number, 6);
        expect(r.depth_mm).toBeCloseTo(s.depth_mm as number, 6);
        expect(r.dh_dt_mm_min).toBeCloseTo(s.dh_dt_mm_min as number, 6);
        expect(r.cap_pct).toBeCloseTo(s.cap_pct as number, 6);
        expect(r.anomaly_code).toBe(s.anomaly_code);
        expect(r.fsm_state).toBe(s.fsm_state);
        expect(r.payload_hex).toBe(s.payload_hex);
        expect(r.saturated).toEqual(s.saturated);
      }
    });
  }
  it('covers flash surge, trash-clog ponding and surcharge in the aquarium fixtures', () => {
    const codes = new Set(edgeGolden.cases.flatMap((c) => c.steps.map((s) => s.anomaly_code)));
    for (const k of [0, 1, 2, 4]) expect(codes.has(k)).toBe(true);
  });
});

describe('Open-Meteo trajectory: TypeScript == backend/weather_feed.py', () => {
  for (const c of weatherGolden.cases) {
    it(`parses ${c.name}`, () => {
      const t = parseOpenMeteoTrajectory(c.payload as Parameters<typeof parseOpenMeteoTrajectory>[0]);
      expect(t.length).toBe(61);
      t.forEach((x, i) => expect(x).toBeCloseTo(c.output.trajectory_mm_hr[i], 6));
    });
  }
});
