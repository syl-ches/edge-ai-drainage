// Phase 9A workspace shell: surface-first boot, the SOLID / X-RAY switch shared by the header pill
// and the dock tile, collapsible panels, the phone breakpoint + bottom sheet, sidebar figures.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LutFile, NetworkFile, PrecipLibrary } from '../../src/types/twin';
import { LutInterpolator } from '../../src/utils/lutInterpolator';
import { arbitrate } from '../../src/utils/fusion';
import { DEFAULT_URL_STATE } from '../../src/utils/urlState';
import { BASELINE_WEATHER } from '../../src/live/weather';
import {
  DOCK_TILES,
  dms,
  initialShell,
  liveBadge,
  MOBILE_MAX_PX,
  shaderOf,
  shellReducer,
  STORM_SIM_PRESETS,
  surfaceOf,
  tileActive,
  type ShellAction,
  type ShellState,
} from '../../src/ui/shell';
import { catchmentStats } from '../../src/components/shell/LeftSidebar';
import { SECTION_LEGEND } from '../../src/components/shell/SectionPanel';

const network = JSON.parse(readFileSync('public/data/city_camp_network.json', 'utf8')) as NetworkFile;
const lut = JSON.parse(readFileSync('public/data/simulation_lut.json', 'utf8')) as LutFile;
const library = JSON.parse(readFileSync('public/data/precip_library.json', 'utf8')) as PrecipLibrary;
const run = (s: ShellState, ...as: ShellAction[]) => as.reduce(shellReducer, s);

describe('surface-first boot and the SOLID / X-RAY switch', () => {
  it('boots in Solid Concrete with the subsurface network hidden', () => {
    const s = initialShell(1440, DEFAULT_URL_STATE.shader);
    expect(s.surface).toBe('solid');
    expect(shaderOf(s.surface)).toBe('solid');
    expect(DEFAULT_URL_STATE.layers.network).toBe(false);
    expect(tileActive(s, 'xray')).toBe(false);
    expect(s.panel).toBe('section'); // SECTION tile active by default
    expect(tileActive(s, 'section')).toBe(true);
  });

  it('the header pill and the dock X-RAY tile drive the same state', () => {
    const s0 = initialShell(1440);
    const viaPill = shellReducer(s0, { type: 'surface', mode: 'fresnel' });
    const viaTile = shellReducer(s0, { type: 'tile', tile: 'xray' });
    expect(viaPill.surface).toBe('fresnel');
    expect(viaTile.surface).toBe('fresnel');
    expect(shaderOf(viaTile.surface)).toBe('glass');
    expect(tileActive(viaPill, 'xray')).toBe(true);
    // the tile toggles back; the pill selects explicitly
    expect(shellReducer(viaTile, { type: 'tile', tile: 'xray' }).surface).toBe('solid');
    expect(shellReducer(viaPill, { type: 'surface', mode: 'solid' }).surface).toBe('solid');
    // X-RAY is an action: the active dock panel does not change
    expect(viaTile.panel).toBe(s0.panel);
    expect(surfaceOf('glass')).toBe('fresnel');
    expect(surfaceOf('wire')).toBe('wire');
  });

  it('tiles switch the dock panel; CCTV is an action', () => {
    const s = initialShell(1440);
    expect(DOCK_TILES.map((t) => t.id)).toEqual(['network', 'xray', 'capacity', 'cctv', 'section', 'report']);
    expect(shellReducer(s, { type: 'tile', tile: 'capacity' }).panel).toBe('capacity');
    expect(shellReducer(s, { type: 'tile', tile: 'cctv' })).toBe(s);
    expect(run(s, { type: 'right', open: false }, { type: 'tile', tile: 'report' }).rightOpen).toBe(true);
  });
});

describe('collapsible panels and the phone layout', () => {
  it('left sidebar and right dock collapse and expand', () => {
    const s = initialShell(1440);
    expect(s.leftOpen && s.rightOpen).toBe(true);
    const closed = run(s, { type: 'left' }, { type: 'right' });
    expect(closed.leftOpen || closed.rightOpen).toBe(false);
    const reopened = run(closed, { type: 'left', open: true }, { type: 'right', open: true });
    expect(reopened.leftOpen && reopened.rightOpen).toBe(true);
  });

  it('below 768 px both panels collapse and the bottom sheet takes over', () => {
    const phone = initialShell(390);
    expect(MOBILE_MAX_PX).toBe(768);
    expect(phone).toMatchObject({ mobile: true, leftOpen: false, rightOpen: false, sheetOpen: false });
    const narrowed = shellReducer(initialShell(1440), { type: 'viewport', width: 700 });
    expect(narrowed).toMatchObject({ mobile: true, leftOpen: false, rightOpen: false });
    // widening restores the panels the breakpoint closed
    expect(shellReducer(narrowed, { type: 'viewport', width: 1280 })).toMatchObject({ mobile: false, leftOpen: true, rightOpen: true });
    // tabs raise the sheet; the same tab lowers it
    const nodes = shellReducer(phone, { type: 'sheet', tab: 'nodes' });
    expect(nodes).toMatchObject({ sheetOpen: true, sheetTab: 'nodes' });
    expect(shellReducer(nodes, { type: 'sheet', tab: 'forecast' })).toMatchObject({ sheetOpen: true, sheetTab: 'forecast' });
    expect(shellReducer(nodes, { type: 'sheet', open: false }).sheetOpen).toBe(false);
  });
});

describe('sidebar content', () => {
  it('labels the basin centroid in degrees-minutes-seconds', () => {
    expect(dms(network.meta.anchor.lat, network.meta.anchor.lon)).toBe(`16°24'33"N 120°35'11"E`);
    expect(dms(-0.5, -0.5)).toBe(`0°30'00"S 0°30'00"W`);
  });

  it('derives the catchment figures from the network file', () => {
    const c = catchmentStats(network);
    expect(c.conduits).toBe(63);
    expect(c.edgeNodes).toBe(10);
    expect(c.nodes).toBe(65);
    expect(c.invertM).toBe(1426.5);
    expect(c.rimM).toBe(1433);
    expect(c.areaHa).toBeGreaterThan(50);
    expect(c.tunnelKm).toBeCloseTo(2.4, 1);
  });

  it('Storm Sim presets land on their intended fusion verdicts', () => {
    const interp = new LutInterpolator({ network, lut, library });
    const verdict = (id: string) => {
      const p = STORM_SIM_PRESETS.find((x) => x.id === id)!;
      return arbitrate(interp.evaluate(p.rain, p.clog)).root_cause;
    };
    expect(STORM_SIM_PRESETS.map((p) => p.label)).toEqual(['Normal', 'Typhoon Surge', 'Trash Clog', 'Rock Choke Backwater']);
    expect(verdict('normal')).toBe('NOMINAL');
    expect(verdict('typhoon')).toBe('INTAKE_SURCHARGE_OVERFLOW');
    expect(verdict('clog')).toBe('CONFIRMED_TRASH_RACK_OCCLUSION');
    expect(verdict('choke')).toBe('DOWNSTREAM_ROCK_CHOKE_BACKWATER');
  });

  it('the live badge names only connected sources', () => {
    const off = liveBadge(BASELINE_WEATHER, null);
    expect(off.source).toBe('Weather offline · Backend offline');
    expect(off.color).toBe('#94a3b8');
    const on = liveBadge({ ...BASELINE_WEATHER, source: 'OPEN_METEO' }, { source: 'BACKEND_WS', rain: 0, clog: 0, clockS: 0, periodS: 1, frame: null, wsUrl: 'ws://x' });
    expect(on.source).toBe('Open-Meteo · Edge backend');
    expect(on.color).toBe('#10b981');
    expect(JSON.stringify([off, on])).not.toMatch(/PAGASA/);
  });

  it('section legend carries the fullness bands', () => {
    expect(SECTION_LEGEND.map((l) => l.label)).toEqual(['Terrain', 'Culvert', 'Normal (<45%)', 'Warning (45-79%)', 'Critical (>=80% 3 Hz)']);
  });
});
