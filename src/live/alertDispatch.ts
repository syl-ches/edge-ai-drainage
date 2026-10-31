// Alert dispatch client (Phase 9D): POST /api/alerts/dispatch when the backend answers, else the
// browser sandbox loopback (same messages, signed, logged, never sent). Loopback rows are also
// written to the telemetry database's incident ledger (IndexedDB).
import type { TelemetryDatabase } from '../utils/telemetryDatabase';
import { GROUPS, loopbackDispatch, type AlertContext, type AlertGroup, type LedgerRow } from '../utils/alertFormat';

export interface DispatchOutcome {
  mode: 'SANDBOX_VERIFIED_LOOPBACK' | 'LIVE_GATEWAY';
  via: 'backend' | 'browser';
  messages: { group: AlertGroup; sms: string; subject: string; text: string; pdu: string | null }[];
  ledger: LedgerRow[];
}

interface BackendDispatch {
  group: AlertGroup;
  delivery_mode: DispatchOutcome['mode'];
  sms: { text: string; pdu: string | null };
  email: { subject: string; text: string };
  ledger: LedgerRow[];
}

export async function dispatchAlert(
  api: string | null,
  db: TelemetryDatabase | null,
  ctx: AlertContext,
  groups: AlertGroup[],
  phone: string | null,
  email: string | null,
  attachPdf: boolean,
  auto = false,
): Promise<DispatchOutcome> {
  if (api) {
    try {
      const results: BackendDispatch[] = [];
      for (const g of groups) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`${api}/api/alerts/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: ctx.node, severity: ctx.severity, fusion_verdict: ctx.verdict, recipient_group: g, custom_phone: phone, custom_email: email, attach_pdf_summary: attachPdf, auto }),
          signal: ctl.signal,
        });
        clearTimeout(t);
        if (r.status === 422) throw new Error((await r.json()).detail ?? 'invalid recipient');
        if (!r.ok) throw new TypeError(`HTTP ${r.status}`);
        results.push(...((await r.json()).dispatches as BackendDispatch[]));
      }
      return {
        mode: results.some((d) => d.delivery_mode === 'LIVE_GATEWAY') ? 'LIVE_GATEWAY' : 'SANDBOX_VERIFIED_LOOPBACK',
        via: 'backend',
        messages: results.map((d) => ({ group: d.group, sms: d.sms.text, subject: d.email.subject, text: d.email.text, pdu: d.sms.pdu })),
        ledger: results.flatMap((d) => d.ledger),
      };
    } catch (e) {
      if (!(e instanceof TypeError) && !(e instanceof DOMException)) throw e; // a 422 is the caller's problem
    }
  }
  const messages: DispatchOutcome['messages'] = [];
  const ledger: LedgerRow[] = [];
  for (const g of groups) {
    const r = await loopbackDispatch(ctx, g, phone, email, attachPdf);
    messages.push({ group: g, sms: r.sms, subject: r.subject, text: r.text, pdu: r.pdu });
    ledger.push(...r.ledger);
    await db?.store.putIncident({ timestamp_utc: r.ledger[0].timestamp_utc, node_id: ctx.node, fusion_verdict: ctx.verdict, trash_rack_occlusion_pct: ctx.vision ?? 0, target_agency: GROUPS[g].label, action_summary: r.sms });
  }
  return { mode: 'SANDBOX_VERIFIED_LOOPBACK', via: 'browser', messages, ledger };
}

/** Severity of a node fullness on the dispatch thresholds (45 % warning, 80 % critical). */
export function severityFor(pct: number): AlertContext['severity'] {
  return pct >= 80 ? 'CRITICAL' : pct >= 45 ? 'WARNING' : 'INFO';
}

/** Auto-dispatch gate: once per node and level, re-armed after `cooldownMs` or when the level drops. */
export class AutoDispatchGate {
  private last = new Map<string, { level: 'WARNING' | 'CRITICAL'; at: number }>();
  constructor(private readonly cooldownMs = 10 * 60_000) {}
  /** Returns the level to dispatch for this reading, or null. */
  check(node: string, pct: number, now: number): 'WARNING' | 'CRITICAL' | null {
    const sev = severityFor(pct);
    const prev = this.last.get(node);
    if (sev === 'INFO') {
      this.last.delete(node);
      return null;
    }
    const rank = (s: string) => (s === 'CRITICAL' ? 2 : 1);
    if (prev && rank(prev.level) >= rank(sev) && now - prev.at < this.cooldownMs) return null;
    this.last.set(node, { level: sev, at: now });
    return sev;
  }
}
