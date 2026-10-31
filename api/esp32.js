// Baseline ESP32-S3 -> Vercel link test (firmware/vercel_baseline_test, CLAUDE.md §24).
// Stores nothing: a reading is echoed back to the board and written to the Vercel runtime log,
// which is the proof it arrived. No auth, so nothing may act on these readings yet.
const LEVELS = new Set(['NORMAL', 'WARNING', 'ALARM', 'NO_ECHO']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export default function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'esp32-baseline', hint: 'POST a reading here' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  let body;
  try {
    body = req.body; // the Vercel helper parses JSON on first read and throws on malformed input
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid JSON' });
  }
  const device = typeof body?.device === 'string' && /^[\w-]{1,32}$/.test(body.device) ? body.device : null;
  if (!device || !LEVELS.has(body.level)) return res.status(422).json({ ok: false, error: 'device and level are required' });
  const reading = {
    device,
    level: body.level,
    dist_mm: num(body.dist_mm),
    fill_pct: num(body.fill_pct),
    seq: num(body.seq),
    rssi: num(body.rssi),
    uptime_s: num(body.uptime_s),
  };
  const received_at = new Date().toISOString();
  (reading.level === 'ALARM' ? console.warn : console.log)('[esp32]', JSON.stringify({ received_at, ...reading }));
  return res.status(200).json({ ok: true, received_at, ...reading });
}
