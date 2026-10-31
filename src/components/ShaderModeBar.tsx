import { Box, Gem, Grid3x3 } from 'lucide-react';
import { SHADING_MODES, type ShadingMode } from '../three/materials/buildingMaterials';

const ICONS: Record<ShadingMode, typeof Box> = { solid: Box, wire: Grid3x3, glass: Gem };

export function ShaderSegments({ mode, onMode, compact = false }: { mode: ShadingMode; onMode(m: ShadingMode): void; compact?: boolean }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Surface building shader">
      {SHADING_MODES.map(({ id, label }) => {
        const Icon = ICONS[id];
        const on = id === mode;
        return (
          <button
            key={id}
            role="radio"
            aria-checked={on}
            onClick={() => onMode(id)}
            className={`flex items-center gap-1.5 rounded-full ${compact ? 'px-2.5 py-1' : 'px-3.5 py-1.5'} text-[11px] ${on ? 'btn-active' : 'btn-idle'}`}
          >
            <Icon size={13} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
