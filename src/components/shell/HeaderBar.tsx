// 48 px top utility bar of the Baguio Flood Intelligence workspace (Phase 9A).
// Left -> right: brand, NETWORK / SIMULATION / HARDWARE / CCTV VMS menus, the SOLID | X-RAY
// render pill (the primary X-ray switch), the 2D | 3D camera pill, theme, EXPORT and the live
// telemetry badge. On phones it collapses to brand + rainfall + a thumb-size SOLID | X-RAY pill.
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Cctv, ChevronDown, Clapperboard, Cpu, Crosshair, FileJson, FileText, HardDrive, LayoutDashboard, Moon, QrCode, Sun, Usb, Waypoints } from 'lucide-react';
import type { CameraPreset, CameraPresetId } from '../../three/TwinEngine';
import type { Theme } from '../../three/theme';
import type { HudMode } from '../../utils/urlState';
import type { WeatherNow } from '../../live/weather';
import type { LiveSnapshot } from '../../live/telemetry';
import type { UsbRig } from '../../live/useUsbRig';
import type { Dimension, SurfaceMode } from '../../ui/shell';
import { liveBadge } from '../../ui/shell';

/** Flood-wave over contour lines, 1.5 px strokes. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
      <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="4" />
      <path d="M6 9.5c2-1.6 4-1.6 6 0s4 1.6 6 0" />
      <path d="M6 13.5c2-1.6 4-1.6 6 0s4 1.6 6 0" />
      <path d="M8 17.5h8" />
    </svg>
  );
}

function Menu({ label, children, testId }: { label: string; children: (close: () => void) => ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button className="sh-nav flex items-center gap-1 px-2 py-1" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid={testId}>
        {label}
        <ChevronDown size={12} strokeWidth={1.5} />
      </button>
      {open && (
        <div role="menu" className="sh-menu absolute left-0 top-[calc(100%+6px)] z-[60] min-w-[248px] rounded-md py-1">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Item({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick(): void }) {
  return (
    <button role="menuitem" onClick={onClick} className="sh-menu-item flex w-full items-start gap-2 px-3 py-2 text-left text-[12px]">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {hint && <span className="sh-muted block text-[10.5px]">{hint}</span>}
      </span>
    </button>
  );
}

export function SurfacePill({ surface, onSurface, large = false }: { surface: SurfaceMode; onSurface(m: SurfaceMode): void; large?: boolean }) {
  return (
    <div className="sh-seg" role="radiogroup" aria-label="Render mode">
      {(
        [
          ['solid', 'SOLID'],
          ['fresnel', 'X-RAY'],
        ] as const
      ).map(([m, label]) => (
        <button key={m} role="radio" aria-checked={surface === m} onClick={() => onSurface(m)} className={large ? '!px-5 !py-2 !text-[13px]' : ''} data-testid={`surface-${m}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

interface Props {
  mobile: boolean;
  surface: SurfaceMode;
  onSurface(m: SurfaceMode): void;
  dimension: Dimension;
  onDimension(d: Dimension): void;
  theme: Theme;
  onTheme(t: Theme): void;
  mode: HudMode;
  onMode(m: HudMode): void;
  rain: number;
  weather: WeatherNow;
  live: LiveSnapshot | null;
  cameras: CameraPreset[];
  onCamera(id: CameraPresetId): void;
  onUpperBasin(): void;
  onSimulator(): void;
  onInspector(): void;
  onHardwareSim(): void;
  onStudio(): void;
  usb: UsbRig;
  usbSensorId: string;
  onCctv(): void;
  onReport(): void;
  onExportJson(): void;
  onAnalytics(): void;
  onShare(): void;
}

function HeaderBarImpl(p: Props) {
  const badge = liveBadge(p.weather, p.live);
  if (p.mobile) {
    return (
      <header className="sh-surface sh-hair-b z-50 flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="sh-ink">
          <BrandMark size={20} />
        </span>
        <span className="sh-ink truncate text-[13px] font-bold tracking-tight">Baguio Flood Intelligence</span>
        <span className="sh-mono sh-card ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{p.rain.toFixed(p.rain < 10 ? 1 : 0)} mm/h</span>
        <SurfacePill surface={p.surface} onSurface={p.onSurface} />
      </header>
    );
  }
  const quick = p.cameras.filter((c) => c.id !== 'overview');
  return (
    <header className="sh-surface sh-hair-b relative z-50 flex h-12 shrink-0 items-center gap-1 px-3">
      <div className="mr-3 flex min-w-0 items-center gap-2">
        <span className="sh-ink">
          <BrandMark />
        </span>
        <span className="sh-ink whitespace-nowrap text-[15px] font-extrabold tracking-tight">
          baguio<span className="font-medium">Flood</span>
        </span>
        <span className="sh-card sh-label hidden whitespace-nowrap rounded px-1.5 py-0.5 !text-[9.5px] xl:inline">City Camp Catchment</span>
      </div>

      <nav className="flex items-center" aria-label="Workspace">
        <Menu label="Network" testId="menu-network">
          {(close) => (
            <>
              {quick.map((c) => (
                <Item
                  key={c.id}
                  icon={<Crosshair size={14} strokeWidth={1.5} />}
                  label={c.id === 'intake' ? 'Lagoon Intake EN-08' : c.id === 'choke' ? 'Rock Choke Tunnel' : c.label}
                  hint={c.label}
                  onClick={() => {
                    p.onCamera(c.id);
                    close();
                  }}
                />
              ))}
              <Item icon={<Crosshair size={14} strokeWidth={1.5} />} label="Upper Basin Conduits" hint="Hillside feeders EN-01 / EN-02 / EN-05" onClick={() => (p.onUpperBasin(), close())} />
              <div className="sh-hair-t my-1" />
              <Item icon={<Waypoints size={14} strokeWidth={1.5} />} label="Cross-Section Simulator" hint="Full-screen node cutaway and catchment profile" onClick={() => (p.onSimulator(), close())} />
              <Item icon={<Waypoints size={14} strokeWidth={1.5} />} label="Subsurface Utility Inspector" hint="Block view of a box culvert and pipe" onClick={() => (p.onInspector(), close())} />
            </>
          )}
        </Menu>
        <Menu label="Simulation" testId="menu-simulation">
          {(close) => (
            <>
              <Item icon={<Sun size={14} strokeWidth={1.5} />} label="Live Weather" hint="Open-Meteo rainfall drives the twin" onClick={() => (p.onMode('LIVE'), close())} />
              <Item icon={<Waypoints size={14} strokeWidth={1.5} />} label="Storm Sim (stress test)" hint="Manual rainfall and rack-occlusion scrubbers" onClick={() => (p.onMode('SIM'), close())} />
            </>
          )}
        </Menu>
        <Menu label="Hardware" testId="menu-hardware">
          {(close) => (
            <>
              <Item
                icon={<Usb size={14} strokeWidth={1.5} />}
                label={p.usb.status === 'connected' ? `Disconnect ${p.usb.label}` : 'Connect USB Arduino / ESP32'}
                hint={p.usb.status === 'unsupported' ? 'Web Serial needs desktop Chrome or Edge' : `Targets ${p.usbSensorId} (select a sensor to retarget)`}
                onClick={() => {
                  if (p.usb.status === 'connected') void p.usb.disconnect();
                  else if (p.usb.status !== 'unsupported') void p.usb.connect();
                  close();
                }}
              />
              <Item icon={<Cpu size={14} strokeWidth={1.5} />} label="Aquarium Serial Rig" hint="Opens in a new tab and syncs live" onClick={() => (p.onHardwareSim(), close())} />
              <Item icon={<Clapperboard size={14} strokeWidth={1.5} />} label="Ultra-HD Pitch Studio" hint="Cutaway diorama and Arduino bench" onClick={() => (p.onStudio(), close())} />
              <Item icon={<HardDrive size={14} strokeWidth={1.5} />} label="Black-box SD recovery" hint="Comms blackout, DUMP_SD_LOG burst sync, hydrograph backfill" onClick={() => (p.onAnalytics(), close())} />
            </>
          )}
        </Menu>
        <button className="sh-nav flex items-center gap-1 px-2 py-1" onClick={p.onCctv} data-testid="nav-cctv">
          <Cctv size={13} strokeWidth={1.5} /> CCTV VMS
        </button>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <SurfacePill surface={p.surface} onSurface={p.onSurface} />
        <div className="sh-seg" role="radiogroup" aria-label="Camera dimension">
          {(['2d', '3d'] as const).map((d) => (
            <button key={d} role="radio" aria-checked={p.dimension === d} onClick={() => p.onDimension(d)}>
              {d.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="sh-seg" role="radiogroup" aria-label="Theme">
          <button role="radio" aria-checked={p.theme === 'daylight'} onClick={() => p.onTheme('daylight')} aria-label="Daylight diorama" className="!px-2">
            <Sun size={13} strokeWidth={1.5} />
          </button>
          <button role="radio" aria-checked={p.theme === 'xray'} onClick={() => p.onTheme('xray')} aria-label="Dark X-ray theme" className="!px-2">
            <Moon size={13} strokeWidth={1.5} />
          </button>
        </div>
        <Menu label="Export PDF" testId="menu-export">
          {(close) => (
            <>
              <Item icon={<LayoutDashboard size={14} strokeWidth={1.5} />} label="Analytics Command Center" hint="Hydrograph, conduit stress, Kalman audit, agency actions" onClick={() => (p.onAnalytics(), close())} />
              <Item icon={<FileText size={14} strokeWidth={1.5} />} label="Official LGU PDF report" hint="3 pages, four-agency header, strict typography" onClick={() => (p.onReport(), close())} />
              <Item icon={<FileJson size={14} strokeWidth={1.5} />} label="Telemetry JSON export" hint="Current state + recorded session snapshots" onClick={() => (p.onExportJson(), close())} />
            </>
          )}
        </Menu>
        <button onClick={p.onShare} className="sh-btn rounded-md p-1.5" aria-label="Share via QR">
          <QrCode size={14} strokeWidth={1.5} />
        </button>
        <span className="sh-card flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em]" title={badge.title}>
          <span className="h-2 w-2 rounded-full" style={{ background: badge.color }} />
          <span className="sh-ink">Live Telemetry</span>
          <span className="sh-muted hidden 2xl:inline">{badge.source}</span>
        </span>
      </div>
    </header>
  );
}

export const HeaderBar = memo(HeaderBarImpl);
