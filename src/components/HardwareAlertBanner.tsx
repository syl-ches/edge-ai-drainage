import { memo } from 'react';
import { Crosshair, Unplug } from 'lucide-react';
import type { HardwarePacket } from '../live/hardwareSync';
import { ALARM_PCT } from '../utils/fullness';

/** Short human label of where a rig packet came from. */
export function rigLabel(p: HardwarePacket): string {
  return p.origin === 'WEB_SERIAL' ? 'USB Arduino / ESP32' : 'Aquarium simulator';
}

/** Banner text for a live hardware packet (alarm at >= 80 % full). */
export function hardwareBannerText(p: HardwarePacket): { alarm: boolean; text: string } {
  const pct = Math.round(Math.min(p.capacityPct, 127));
  const alarm = pct >= ALARM_PCT || p.anomaly === 'SURCHARGED';
  return alarm
    ? { alarm, text: `🔴 LIVE HARDWARE SENSOR ALERT: ${p.sensorId} IS ${pct}% FULL` }
    : { alarm, text: `🟢 Live hardware sensor: ${p.sensorId} · ${pct}% full` };
}

function HardwareAlertBannerImpl({
  packet,
  onFocus,
  onDisconnect,
  rightInset,
}: {
  packet: HardwarePacket;
  onFocus(): void;
  onDisconnect(): void;
  /** px kept clear on the right (the inspector drawer when open) */
  rightInset: number;
}) {
  const { alarm, text } = hardwareBannerText(packet);
  return (
    <div
      role={alarm ? 'alert' : 'status'}
      className="pointer-events-auto absolute inset-x-2 top-[calc(var(--topbar-h,52px)+20px)] z-40 flex justify-center sm:left-[404px]"
      style={typeof window !== 'undefined' && window.innerWidth >= 640 ? { right: rightInset } : undefined}
    >
      <div className={`flex w-full max-w-[760px] flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl px-3 py-2 shadow-2xl ${alarm ? 'hw-banner-alarm text-[#ffffff]' : 'btn-active'}`}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-extrabold leading-tight tracking-wide">{text}</div>
          <div className="truncate font-mono text-[10px] font-semibold opacity-90">
            {rigLabel(packet)} · {packet.anomaly.replace('_', ' ')} · {packet.payloadHex} · {packet.scope === 'full_catchment' ? 'full catchment' : 'targeted sensor'}
          </div>
        </div>
        <button onClick={onFocus} className="flex items-center gap-1 rounded-full bg-[#ffffff] px-3 py-1 text-[11px] font-bold text-[#0f172a] hover:bg-[#f1f5f9]">
          <Crosshair size={12} /> Focus Camera
        </button>
        <button onClick={onDisconnect} className="flex items-center gap-1 rounded-full bg-[#0f172a] px-3 py-1 text-[11px] font-bold text-[#ffffff] ring-1 ring-white/40 hover:bg-[#1e293b]">
          <Unplug size={12} /> Disconnect Sim
        </button>
      </div>
    </div>
  );
}

export const HardwareAlertBanner = memo(HardwareAlertBannerImpl);
