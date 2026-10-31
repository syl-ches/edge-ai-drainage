import { memo } from 'react';
import { CircleCheck, Crosshair, Siren, Unplug } from 'lucide-react';
import type { HardwarePacket } from '../live/hardwareSync';
import { ALARM_PCT } from '../utils/fullness';

/** Short human label of where a rig packet came from. */
export function rigLabel(p: HardwarePacket): string {
  if (p.origin === 'WIFI_NODE') return 'Wi-Fi ESP32-S3 node';
  return p.origin === 'WEB_SERIAL' ? 'USB Arduino / ESP32' : 'Aquarium / Pitch Studio simulator';
}

/** Banner text for a live sensor packet (alarm at >= 80 % full). Status is shown by an SVG icon, never an emoji. */
export function hardwareBannerText(p: HardwarePacket): { alarm: boolean; text: string } {
  const pct = Math.round(Math.min(p.capacityPct, 127));
  const alarm = pct >= ALARM_PCT || p.anomaly === 'SURCHARGED';
  return alarm
    ? { alarm, text: `LIVE SENSOR ALERT — ${p.sensorId} AT ${pct}% CAPACITY` }
    : { alarm, text: `Live sensor: ${p.sensorId} · ${pct}% capacity` };
}

function HardwareAlertBannerImpl({
  packet,
  onFocus,
  onDisconnect,
}: {
  packet: HardwarePacket;
  onFocus(): void;
  /** Absent for a physical Wi-Fi node: the browser cannot disconnect it. */
  onDisconnect?: () => void;
}) {
  const { alarm, text } = hardwareBannerText(packet);
  return (
    <div
      role={alarm ? 'alert' : 'status'}
      className="pointer-events-none absolute inset-x-3 top-3 z-40 flex justify-center"
    >
      <div className={`pointer-events-auto flex w-full max-w-[760px] flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl px-3 py-2 shadow-2xl ${alarm ? 'hw-banner-alarm text-[#ffffff]' : 'btn-active'}`}>
        {alarm ? <Siren size={18} strokeWidth={1.75} className="shrink-0" aria-hidden /> : <CircleCheck size={18} strokeWidth={1.75} className="shrink-0" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-extrabold leading-tight tracking-wide">{text}</div>
          <div className="truncate font-mono text-[10px] font-semibold opacity-90">
            {rigLabel(packet)} · {packet.anomaly.replace('_', ' ')} · {packet.payloadHex} · {packet.scope === 'full_catchment' ? 'full catchment' : 'targeted sensor'}
          </div>
        </div>
        <button onClick={onFocus} className="flex items-center gap-1 rounded-full bg-[#ffffff] px-3 py-1 text-[11px] font-bold text-[#0f172a] hover:bg-[#f1f5f9]">
          <Crosshair size={12} /> Jump to Sensor
        </button>
        {onDisconnect && (
          <button onClick={onDisconnect} className="flex items-center gap-1 rounded-full bg-[#0f172a] px-3 py-1 text-[11px] font-bold text-[#ffffff] ring-1 ring-white/40 hover:bg-[#1e293b]">
            <Unplug size={12} /> Disconnect Sim
          </button>
        )}
      </div>
    </div>
  );
}

export const HardwareAlertBanner = memo(HardwareAlertBannerImpl);
