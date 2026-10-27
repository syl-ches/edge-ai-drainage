// Client-side multi-sensor fusion arbitrator — same decision table as backend/intelligence.py
// (used when no backend is connected). Resolves the Phase 1 backwater paradox: a flat,
// deep, quiet pool at the intake (EN-08 TRASH_BLOCKAGE signature) can be caused either by a
// clogged rack or by backwater from the 1.5 m × 1.7 m rock choke downstream.

import type { FusionVerdict } from '../types/live';
import type { TwinState } from './lutInterpolator';

export const VISION_CONFIRM_PCT = 35;
const CHOKE_ELEVATED_PCT = 50;

export function arbitrate(st: TwinState): FusionVerdict {
  const by = (id: string) => st.sensors.find((s) => s.id === id);
  const en08 = by('EN-08');
  const en09 = by('EN-09');
  const en10 = by('EN-10');
  const visionPct = en09?.capacityPct ?? st.blockagePct;
  const ponding = en08?.anomaly === 'TRASH_BLOCKAGE';
  const evidence = [
    `EN-08 ultrasonic: ${en08?.anomaly ?? '—'} (h/D ${(en08?.hRatio ?? 0).toFixed(2)}, σ̃² ${(en08?.turbulence ?? 0).toFixed(3)})`,
    `EN-09 YOLOv8 vision: ${visionPct.toFixed(0)} % occluded`,
    `EN-10 choke transition: ${en10?.anomaly ?? '—'} (${(en10?.capacityPct ?? 0).toFixed(0)} % capacity)`,
    `Governing bottleneck: ${st.lagoon.bottleneck}`,
  ];
  if (st.lagoon.isOverflowing) {
    return {
      root_cause: 'INTAKE_SURCHARGE_OVERFLOW',
      severity: 'CRITICAL',
      action: 'Lagoon above 1433.0 m rim — activate CDRRMO evacuation advisory for City Camp Proper/Central.',
      confidence: 0.97,
      evidence,
      suppressed_false_alarm: false,
    };
  }
  if (ponding && visionPct >= VISION_CONFIRM_PCT) {
    return {
      root_cause: 'CONFIRMED_TRASH_RACK_OCCLUSION',
      severity: 'CRITICAL',
      action: 'Dispatch CEO manual clearing crew to the City Camp Lagoon tunnel intake trash rack.',
      confidence: Math.min(0.6 + visionPct / 250, 0.98),
      evidence,
      suppressed_false_alarm: false,
    };
  }
  if (ponding && (en10?.capacityPct ?? 0) >= CHOKE_ELEVATED_PCT) {
    return {
      root_cause: 'DOWNSTREAM_ROCK_CHOKE_BACKWATER',
      severity: 'WARNING',
      action: 'Trash rack is clear — bottleneck is the unlined 1.5 m × 1.7 m bedrock tunnel section. Do not dispatch rack crew.',
      confidence: 0.86,
      evidence,
      suppressed_false_alarm: true,
    };
  }
  if (visionPct >= VISION_CONFIRM_PCT) {
    return {
      root_cause: 'DEBRIS_ACCUMULATING_NO_BACKWATER',
      severity: 'INFO',
      action: 'Debris building on the rack; no hydraulic backwater yet. Schedule clearing before next rain band.',
      confidence: 0.7,
      evidence,
      suppressed_false_alarm: false,
    };
  }
  return { root_cause: 'NOMINAL', severity: 'INFO', action: 'All intake sensors consistent. No action.', confidence: 0.9, evidence, suppressed_false_alarm: false };
}
