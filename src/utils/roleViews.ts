// View models for the role-based banners (Phase 9D), pure.
import type { NetworkFile } from '../types/twin';
import type { TwinState } from './lutInterpolator';
import { rainfallClass } from './lutInterpolator';

const R_EARTH = 6371008.8;
const metres = (a: [number, number], b: [number, number]) => {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * R_EARTH;
};

/**
 * Barangays exposed if the lagoon overflows: those with buildings inside the flood reach
 * (the lagoon's live inundation radius, or rim radius + 150 m when an overflow is forecast).
 * Returns 0 / [] when no overflow is expected within the horizon.
 */
export function affectedBarangays(net: NetworkFile, st: TwinState, etaMin: number | null, horizonMin = 60): string[] {
  if (!(st.lagoon.isOverflowing || (etaMin !== null && etaMin <= horizonMin))) return [];
  const a = net.meta.anchor;
  const rimR = Math.max(...net.lagoon.polygon[0].map(([lon, lat]) => metres([a.lon, a.lat], [lon, lat])));
  const reach = Math.max(st.lagoon.inundationRadiusM, rimR + 150);
  const out = new Set<string>();
  for (const b of net.buildings) {
    if (!b.is_active) continue;
    const [lon, lat] = b.coordinates[0][0];
    if (metres([a.lon, a.lat], [lon, lat]) <= reach) out.add(b.barangay);
  }
  return [...out].sort();
}

export type CorridorStatus = 'SAFE' | 'CAUTION' | 'FLOODING';

const CORRIDORS: { code: string; name: string }[] = [
  { code: 'LGD', name: 'Legarda Rd' },
  { code: 'DHR', name: 'Dominican Hill Rd' },
  { code: 'KSD', name: 'Kisad Rd' },
  { code: 'QOP', name: 'Queen of Peace Rd' },
  { code: 'GSF', name: 'Guisad Surong' },
  { code: 'CCP', name: 'City Camp Proper' },
];

/** Street-corridor advisory from the worst conduit under each corridor (public QR view). */
export function corridorAdvisory(net: NetworkFile, st: TwinState): { name: string; status: CorridorStatus; pct: number }[] {
  return CORRIDORS.map(({ code, name }) => {
    let worst = 0;
    net.conduits.forEach((c, i) => {
      if (c.id.startsWith(`${code}-`)) worst = Math.max(worst, st.conduits.capacity[i]);
    });
    const pct = worst * 100;
    return { name, pct, status: (pct >= 94 ? 'FLOODING' : pct >= 75 ? 'CAUTION' : 'SAFE') as CorridorStatus };
  });
}

export function rainfallAdvisory(mmHr: number): string {
  const c = rainfallClass(mmHr);
  return `${c.label} rain, ${mmHr.toFixed(mmHr < 10 ? 1 : 0)} mm/h`;
}

export const PUBLIC_SAFETY_GUIDANCE = [
  'Follow official CDRRMO and PAGASA advisories; this map is decision support, not a warning service.',
  'Do not walk or drive through flowing water near the lagoon, culvert outlets or open drains.',
  'Keep away from the City Camp Lagoon rim and the tunnel intake during heavy rain.',
  'Move valuables and vehicles to higher ground if your street shows CAUTION or FLOODING.',
];
