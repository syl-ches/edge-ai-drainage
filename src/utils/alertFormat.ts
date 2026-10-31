// Alert message formatting (Phase 9D) ≡ backend/notifications.py, locked by
// tests/frontend/fixtures/alerts_golden.json. Used for the browser-side sandbox loopback when no
// backend answers (e.g. the Vercel QR view) and for the SMS / e-mail previews.

export type AlertGroup = 'MAYOR' | 'CDRRMO' | 'CEPMO' | 'DPWH' | 'CUSTOM';
export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export const GROUPS: Record<AlertGroup, { label: string; focus: 'executive' | 'evacuation' | 'maintenance' | 'infrastructure' }> = {
  MAYOR: { label: 'Office of the City Mayor (Executive Brief)', focus: 'executive' },
  CDRRMO: { label: 'Baguio CDRRMO Emergency Operations', focus: 'evacuation' },
  CEPMO: { label: 'CEPMO & City Engineering Maintenance Crew', focus: 'maintenance' },
  DPWH: { label: 'DPWH-BCDEO Infrastructure Desk', focus: 'infrastructure' },
  CUSTOM: { label: 'Custom / live test recipient', focus: 'evacuation' },
};

export const NODE_SHORT: Record<string, string> = {
  'EN-01': 'Guisad Surong',
  'EN-02': 'Upper Rock Quarry',
  'EN-03': 'Legarda Outlet',
  'EN-04': 'Dominican Hill',
  'EN-05': 'Kisad Rd',
  'EN-06': 'Queen of Peace',
  'EN-07': 'Lagoon Stage',
  'EN-08': 'Lagoon Intake',
  'EN-09': 'Rack Camera',
  'EN-10': 'Rock Choke',
};

export const VERDICT_SHORT: Record<string, string> = {
  CONFIRMED_TRASH_RACK_OCCLUSION: 'RACK CLOGGED',
  DOWNSTREAM_ROCK_CHOKE_BACKWATER: 'ROCK CHOKE BACKWATER',
  INTAKE_SURCHARGE_OVERFLOW: 'LAGOON OVERFLOW',
  DEBRIS_ACCUMULATING_NO_BACKWATER: 'DEBRIS BUILDING',
  NOMINAL: 'NOMINAL',
};

const SEV_SHORT: Record<string, string> = { CRITICAL: 'CRIT SURGE', WARNING: 'WARN RISING', INFO: 'INFO' };

// GSM 03.38 basic set (index = code) and the extension table (ESC + code, two septets).
export const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
export const GSM7_EXT: Record<string, number> = { '^': 0x14, '{': 0x28, '}': 0x29, '\\': 0x2f, '[': 0x3c, '~': 0x3d, ']': 0x3e, '|': 0x40, '€': 0x65 };

export function gsm7Safe(text: string): string {
  return [...text].map((c) => ((GSM7.includes(c) && c !== '\u001b') || c in GSM7_EXT ? c : '?')).join('');
}

export function gsm7Septets(text: string): number {
  return [...text].reduce((n, c) => n + (c in GSM7_EXT ? 2 : 1), 0);
}

export function gsm7Truncate(text: string, limit = 160): string {
  let n = 0;
  let out = '';
  for (const c of text) {
    const w = c in GSM7_EXT ? 2 : 1;
    if (n + w > limit) break;
    out += c;
    n += w;
  }
  return out;
}

const signed = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

export interface AlertContext {
  node: string;
  severity: AlertSeverity;
  cap: number;
  dh: number; // cm/min
  vision: number | null;
  verdict: string;
  eta: number | null; // minutes to lagoon overflow
}

/** <= 160 GSM-7 septets; optional clauses drop from the end until it fits. */
export function formatSms(c: AlertContext): string {
  const head = `[BAGUIO FLOOD INTEL] ${SEV_SHORT[c.severity] ?? c.severity} @ ${c.node} (${NODE_SHORT[c.node] ?? c.node}): ${c.cap.toFixed(0)}% Cap`;
  const parts = [head, `dh/dt ${signed(c.dh)}cm/m`, `Verdict: ${VERDICT_SHORT[c.verdict] ?? c.verdict}`];
  if (c.eta !== null) parts.push(c.eta <= 0 ? 'Evac Lead: NOW' : `Evac Lead: +${c.eta.toFixed(0)}m`);
  if (c.vision !== null) parts.push(`EN-09 Grate ${c.vision < 35 ? 'Clear' : 'Clogged'} ${c.vision.toFixed(0)}%`);
  for (;;) {
    const text = gsm7Safe(`${parts.join('. ')}.`);
    if (gsm7Septets(text) <= 160 || parts.length <= 1) return gsm7Truncate(text);
    parts.pop();
  }
}

export function emailSubject(c: AlertContext): string {
  return `[Baguio Flood Intelligence] ${c.severity} ${c.node} ${VERDICT_SHORT[c.verdict] ?? c.verdict}`;
}

export function emailText(group: AlertGroup, c: AlertContext, attachPdf: boolean): string {
  const g = GROUPS[group] ?? GROUPS.CUSTOM;
  const lead = c.eta === null ? 'none forecast' : c.eta <= 0 ? 'now' : `about ${c.eta.toFixed(0)} min`;
  const lines = [
    `To: ${g.label}`,
    `Severity: ${c.severity}`,
    `Node: ${c.node} (${NODE_SHORT[c.node] ?? c.node}), ${c.cap.toFixed(0)} % of capacity, dh/dt ${signed(c.dh)} cm/min`,
    `Rack camera EN-09: ${c.vision === null ? 'not reporting' : `${c.vision.toFixed(0)} % occluded`}`,
    `Multi-sensor verdict: ${VERDICT_SHORT[c.verdict] ?? c.verdict}`,
    `Lagoon overflow lead time: ${lead}`,
    '',
  ];
  if (g.focus === 'executive') lines.push('Decision needed: review the CDRRMO advisory and authorise the citywide SMS alert if the countdown holds.');
  else if (g.focus === 'evacuation') lines.push('Action: prepare the City Camp Proper / Central advisory; confirm with the field team and PAGASA bulletins.');
  else if (g.focus === 'maintenance') lines.push('Action: dispatch the rack-clearing crew only if the verdict is RACK CLOGGED; a clear rack with backwater needs no crew.');
  else lines.push('Log: conduit capacity exceedance and the governing bottleneck (1.5 m x 1.7 m rock choke, 4.44 m3/s).');
  if (attachPdf) lines.push('Attached: executive PDF summary (generate from Analytics Command Center > Official LGU PDF).');
  lines.push('Decision support only. Synthetic network geometry; verify on site.');
  return lines.join('\n');
}

export function normalisePhMobile(n: string): string | null {
  let d = (n ?? '').replace(/[^\d+]/g, '');
  if (d.startsWith('09') && d.length === 11) d = `+63${d.slice(1)}`;
  if (d.startsWith('639') && d.length === 12) d = `+${d}`;
  return /^\+639\d{9}$/.test(d) ? d : null;
}

export function validEmail(a: string | null | undefined): boolean {
  return !!a && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a);
}

function packSeptets(text: string): string {
  const codes: number[] = [];
  for (const ch of text) {
    if (ch in GSM7_EXT) codes.push(0x1b, GSM7_EXT[ch]);
    else codes.push(GSM7.indexOf(ch));
  }
  let bits = 0;
  let nbits = 0;
  let out = '';
  for (const code of codes) {
    bits |= code << nbits;
    nbits += 7;
    while (nbits >= 8) {
      out += (bits & 0xff).toString(16).padStart(2, '0');
      bits >>>= 8;
      nbits -= 8;
    }
  }
  if (nbits) out += (bits & 0xff).toString(16).padStart(2, '0');
  return out;
}

/** SMS-SUBMIT TPDU (no SMSC, no validity period, GSM-7) for a +63 9XX number, as hex. */
export function smsSubmitPdu(number: string, text: string): string {
  const num = number.replace(/^\+/, '');
  let bcd = '';
  for (let i = 0; i < num.length; i += 2) bcd += i + 1 < num.length ? num[i + 1] + num[i] : `F${num[i]}`;
  const t = gsm7Truncate(gsm7Safe(text));
  const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
  // SMSC length 00 · SMS-SUBMIT 01 · message ref 00 · DA length + type 91 + BCD · PID 00 · DCS 00 · UDL · UD
  return `000100${hex2(num.length)}91${bcd}0000${hex2(gsm7Septets(t))}${packSeptets(t)}`.toUpperCase();
}

/** HMAC-SHA256(message_id | timestamp | body), first 16 bytes hex (dev key unless configured). */
export async function signAlert(messageId: string, timestamp: string, body: string, key = 'BFI-ALERT-DEV-KEY'): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${messageId}|${timestamp}|${body}`)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface LedgerRow {
  timestamp_utc: string;
  message_id: string;
  channel: 'SMS' | 'EMAIL';
  recipient_group: AlertGroup;
  recipient: string;
  severity: AlertSeverity;
  node_id: string;
  fusion_verdict: string;
  delivery_mode: 'SANDBOX_VERIFIED_LOOPBACK' | 'LIVE_GATEWAY';
  provider: string;
  status: 'DELIVERED' | 'FAILED';
  info: string;
  body: string;
  signature: string;
}

/** Browser-side sandbox loopback (no backend): the same messages, signed, logged, never sent. */
export async function loopbackDispatch(c: AlertContext, group: AlertGroup, phone: string | null, email: string | null, attachPdf: boolean, now = new Date()): Promise<{ sms: string; subject: string; text: string; pdu: string | null; ledger: LedgerRow[] }> {
  const sms = formatSms(c);
  const subject = emailSubject(c);
  const text = emailText(group, c, attachPdf);
  const ts = now.toISOString();
  const id = `BFI-${Math.floor(now.getTime() % 0xffffffffffff)
    .toString(16)
    .toUpperCase()
    .padStart(12, '0')}`;
  const n = phone ? normalisePhMobile(phone) : null;
  const row = async (channel: 'SMS' | 'EMAIL', recipient: string, body: string): Promise<LedgerRow> => ({
    timestamp_utc: ts,
    message_id: id,
    channel,
    recipient_group: group,
    recipient,
    severity: c.severity,
    node_id: c.node,
    fusion_verdict: c.verdict,
    delivery_mode: 'SANDBOX_VERIFIED_LOOPBACK',
    provider: 'LOOPBACK',
    status: 'DELIVERED',
    info: 'browser sandbox: logged, not sent',
    body,
    signature: await signAlert(id, ts, body),
  });
  return {
    sms,
    subject,
    text,
    pdu: n ? smsSubmitPdu(n, sms) : null,
    ledger: [await row('SMS', n ?? `${GROUPS[group].label} (no number configured)`, sms), await row('EMAIL', email && validEmail(email) ? email : `${GROUPS[group].label} (no address configured)`, text)],
  };
}
