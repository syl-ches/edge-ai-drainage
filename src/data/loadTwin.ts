import type { LutFile, NetworkFile, Scenario } from '../types/twin';
import type { PrecipLibrary } from '../forecast/stgnn';

export interface TwinData {
  network: NetworkFile;
  lut: LutFile;
  /** FEWS gauges + historical storm hyetographs (shared with backend/stgnn.py) */
  library: PrecipLibrary;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadTwin(): Promise<TwinData> {
  const [network, lut, library] = await Promise.all([
    getJson<NetworkFile>('data/city_camp_network.json'),
    getJson<LutFile>('data/simulation_lut.json'),
    getJson<PrecipLibrary>('data/precip_library.json'),
  ]);
  return {
    network: { ...network, nodes: network.nodes.filter((n) => n.is_active),
      conduits: network.conduits.filter((c) => c.is_active),
      buildings: network.buildings.filter((b) => b.is_active),
      sensors: network.sensors.filter((s) => s.is_active) },
    lut,
    library,
  };
}

/** Grid cells first (`index`), then off-grid `reference_scenarios` (e.g. R200_B85). */
export function findScenario(lut: LutFile, key: string): Scenario | undefined {
  const i = lut.index[key];
  if (i !== undefined) return lut.scenarios[i];
  return lut.reference_scenarios.find((s) => s.key === key);
}

export interface ScenarioPreset {
  key: string;
  label: string;
  hint: string;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  { key: 'R25_B0', label: '25 mm/hr · Clean rack', hint: 'Reference' },
  { key: 'R200_B85', label: '200 mm/hr · 85% clogged', hint: 'Reference (off-grid)' },
  { key: 'R0_B0', label: 'Dry weather', hint: 'Grid' },
  { key: 'R50_B95', label: '50 mm/hr · 95% clogged', hint: 'Grid' },
  { key: 'R100_B0', label: '100 mm/hr · Clean rack', hint: 'Grid' },
  { key: 'R250_B95', label: '250 mm/hr · 95% clogged', hint: 'Grid' },
];
