// React hook around Web Serial + HardwareRig: "Connect Physical USB Arduino / ESP32".
// Shared by the main map HUD and the /?view=hardware-sim page.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HardwarePacket } from './hardwareSync';
import { connectWebSerial, parseSerialLine, webSerialSupported, HardwareRig, type DistanceUnit, type RigConfig, type SerialSession } from './serialRig';

export type UsbStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'unsupported';

export interface UsbRig {
  status: UsbStatus;
  label: string | null;
  error: string | null;
  /** last raw lines (newest last) for a serial monitor */
  lines: string[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export function useUsbRig(cfg: RigConfig, unit: DistanceUnit, onPacket: (p: HardwarePacket) => void, maxLines = 80): UsbRig {
  const [status, setStatus] = useState<UsbStatus>(() => (webSerialSupported() ? 'idle' : 'unsupported'));
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const session = useRef<SerialSession | null>(null);
  const rig = useRef(new HardwareRig(cfg));
  const latest = useRef({ unit, onPacket });
  latest.current = { unit, onPacket };

  useEffect(() => rig.current.configure(cfg), [cfg]);

  const disconnect = useCallback(async () => {
    const s = session.current;
    session.current = null;
    await s?.close();
    setStatus(webSerialSupported() ? 'idle' : 'unsupported');
    setLabel(null);
  }, []);

  const connect = useCallback(async () => {
    if (!webSerialSupported()) {
      setStatus('unsupported');
      return;
    }
    setStatus('connecting');
    setError(null);
    try {
      const s = await connectWebSerial(
        (line) => {
          setLines((l) => {
            const next = l.length >= maxLines ? l.slice(l.length - maxLines + 1) : l.slice();
            next.push(line);
            return next;
          });
          const reading = parseSerialLine(line, latest.current.unit);
          if (!reading) return;
          const p = rig.current.ingestReading(reading, performance.now());
          if (p) latest.current.onPacket(p);
        },
        (err) => {
          session.current = null;
          setStatus(err ? 'error' : 'idle');
          if (err) setError(err instanceof Error ? err.message : String(err));
        },
      );
      session.current = s;
      rig.current.reset();
      setLabel(s.label);
      setStatus('connected');
    } catch (err) {
      // The user dismissing the port picker is not an error worth shouting about.
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(/No port selected|cancel/i.test(msg) ? 'idle' : 'error');
      setError(/No port selected|cancel/i.test(msg) ? null : msg);
    }
  }, [maxLines]);

  useEffect(() => () => void session.current?.close(), []);

  return { status, label, error, lines, connect, disconnect };
}
