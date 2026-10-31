"""Multi-agency SMS / e-mail dispatch (Phase 9D) ≡ src/utils/alertFormat.ts (messages locked by
tests/frontend/fixtures/alerts_golden.json).

Gateways are used only when configured; otherwise every dispatch is a SANDBOX_VERIFIED_LOOPBACK:
the exact SMS (GSM-7 text + SMS-SUBMIT PDU) and MIME e-mail are built, signed and written to the
audit ledger, and nothing leaves the machine.

    SMS:    SEMAPHORE_API_KEY (+ SEMAPHORE_SENDER_NAME)   https://api.semaphore.co/api/v4/messages
            TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM
            ALERT_WEBHOOK_URL                              (JSON POST, any gateway / chat bridge)
    E-mail: RESEND_API_KEY + ALERT_EMAIL_FROM              https://api.resend.com/emails
            SMTP_HOST [+ SMTP_PORT, SMTP_USER, SMTP_PASS] + ALERT_EMAIL_FROM
    Contacts per group: ALERT_CONTACTS='{"CDRRMO": {"phones": ["+639..."], "emails": ["..."]}, ...}'
    Signing key:        ALERT_SIGNING_KEY (HMAC-SHA256; the dev key is public)
Threshold auto-dispatches stay in the sandbox unless ALERT_AUTO_LIVE=1.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import smtplib
import urllib.parse
import urllib.request
import uuid
from email.message import EmailMessage

GROUPS: dict[str, dict[str, str]] = {
    "MAYOR": dict(label="Office of the City Mayor (Executive Brief)", focus="executive"),
    "CDRRMO": dict(label="Baguio CDRRMO Emergency Operations", focus="evacuation"),
    "CEPMO": dict(label="CEPMO & City Engineering Maintenance Crew", focus="maintenance"),
    "DPWH": dict(label="DPWH-BCDEO Infrastructure Desk", focus="infrastructure"),
    "CUSTOM": dict(label="Custom / live test recipient", focus="evacuation"),
}

NODE_SHORT = {
    "EN-01": "Guisad Surong", "EN-02": "Upper Rock Quarry", "EN-03": "Legarda Outlet", "EN-04": "Dominican Hill",
    "EN-05": "Kisad Rd", "EN-06": "Queen of Peace", "EN-07": "Lagoon Stage", "EN-08": "Lagoon Intake",
    "EN-09": "Rack Camera", "EN-10": "Rock Choke",
}

VERDICT_SHORT = {
    "CONFIRMED_TRASH_RACK_OCCLUSION": "RACK CLOGGED",
    "DOWNSTREAM_ROCK_CHOKE_BACKWATER": "ROCK CHOKE BACKWATER",
    "INTAKE_SURCHARGE_OVERFLOW": "LAGOON OVERFLOW",
    "DEBRIS_ACCUMULATING_NO_BACKWATER": "DEBRIS BUILDING",
    "NOMINAL": "NOMINAL",
}

SEV_SHORT = {"CRITICAL": "CRIT SURGE", "WARNING": "WARN RISING", "INFO": "INFO"}
DEV_SIGNING_KEY = "BFI-ALERT-DEV-KEY"

# GSM 03.38 basic character set (7-bit default alphabet, no extension table).
GSM7 = ("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
        "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà")


# GSM 03.38 extension table: sent as ESC (0x1B) + code, so each counts as two septets.
GSM7_EXT = {"^": 0x14, "{": 0x28, "}": 0x29, "\\": 0x2F, "[": 0x3C, "~": 0x3D, "]": 0x3E, "|": 0x40, "€": 0x65}


def gsm7_safe(text: str) -> str:
    """Replaces characters outside the GSM-7 basic + extension sets (and a bare escape) with '?'."""
    return "".join(c if (c in GSM7 and c != "\x1b") or c in GSM7_EXT else "?" for c in text)


def gsm7_septets(text: str) -> int:
    return sum(2 if c in GSM7_EXT else 1 for c in text)


def gsm7_truncate(text: str, limit: int = 160) -> str:
    out, n = [], 0
    for c in text:
        w = 2 if c in GSM7_EXT else 1
        if n + w > limit:
            break
        out.append(c)
        n += w
    return "".join(out)


def fmt_signed(v: float, nd: int = 1) -> str:
    return f"{'+' if v >= 0 else ''}{v:.{nd}f}"


def format_sms(node_id: str, severity: str, cap_pct: float, dh_dt_cm_min: float, vision_pct: float | None,
               verdict: str, evac_lead_min: float | None) -> str:
    """<= 160 GSM-7 septets; optional clauses are dropped from the end until it fits."""
    head = f"[BAGUIO FLOOD INTEL] {SEV_SHORT.get(severity, severity)} @ {node_id} ({NODE_SHORT.get(node_id, node_id)}): {cap_pct:.0f}% Cap"
    parts = [head, f"dh/dt {fmt_signed(dh_dt_cm_min)}cm/m", f"Verdict: {VERDICT_SHORT.get(verdict, verdict)}"]
    if evac_lead_min is not None:
        parts.append("Evac Lead: NOW" if evac_lead_min <= 0 else f"Evac Lead: +{evac_lead_min:.0f}m")
    if vision_pct is not None:
        parts.append(f"EN-09 Grate {'Clear' if vision_pct < 35 else 'Clogged'} {vision_pct:.0f}%")
    while True:
        text = gsm7_safe(". ".join(parts) + ".")
        if gsm7_septets(text) <= 160 or len(parts) <= 1:
            return gsm7_truncate(text)
        parts.pop()


def email_subject(node_id: str, severity: str, verdict: str) -> str:
    return f"[Baguio Flood Intelligence] {severity} {node_id} {VERDICT_SHORT.get(verdict, verdict)}"


def email_text(group: str, node_id: str, severity: str, cap_pct: float, dh_dt_cm_min: float, vision_pct: float | None,
               verdict: str, evac_lead_min: float | None, attach_pdf_summary: bool) -> str:
    g = GROUPS.get(group, GROUPS["CUSTOM"])
    lead = "none forecast" if evac_lead_min is None else ("now" if evac_lead_min <= 0 else f"about {evac_lead_min:.0f} min")
    lines = [
        f"To: {g['label']}",
        f"Severity: {severity}",
        f"Node: {node_id} ({NODE_SHORT.get(node_id, node_id)}), {cap_pct:.0f} % of capacity, dh/dt {fmt_signed(dh_dt_cm_min)} cm/min",
        f"Rack camera EN-09: {'not reporting' if vision_pct is None else f'{vision_pct:.0f} % occluded'}",
        f"Multi-sensor verdict: {VERDICT_SHORT.get(verdict, verdict)}",
        f"Lagoon overflow lead time: {lead}",
        "",
    ]
    focus = g["focus"]
    if focus == "executive":
        lines.append("Decision needed: review the CDRRMO advisory and authorise the citywide SMS alert if the countdown holds.")
    elif focus == "evacuation":
        lines.append("Action: prepare the City Camp Proper / Central advisory; confirm with the field team and PAGASA bulletins.")
    elif focus == "maintenance":
        lines.append("Action: dispatch the rack-clearing crew only if the verdict is RACK CLOGGED; a clear rack with backwater needs no crew.")
    else:
        lines.append("Log: conduit capacity exceedance and the governing bottleneck (1.5 m x 1.7 m rock choke, 4.44 m3/s).")
    if attach_pdf_summary:
        lines.append("Attached: executive PDF summary (generate from Analytics Command Center > Official LGU PDF).")
    lines.append("Decision support only. Synthetic network geometry; verify on site.")
    return "\n".join(lines)


# ---------------------------------------------------------------- SMS-SUBMIT PDU (GSM-7)
def pack_septets(text: str) -> bytes:
    codes: list[int] = []
    for ch in text:
        codes.extend([0x1B, GSM7_EXT[ch]] if ch in GSM7_EXT else [GSM7.index(ch)])
    bits, nbits, out = 0, 0, bytearray()
    for code in codes:
        bits |= code << nbits
        nbits += 7
        while nbits >= 8:
            out.append(bits & 0xFF)
            bits >>= 8
            nbits -= 8
    if nbits:
        out.append(bits & 0xFF)
    return bytes(out)


def normalise_ph_mobile(number: str) -> str | None:
    digits = re.sub(r"[^\d+]", "", number or "")
    if digits.startswith("09") and len(digits) == 11:
        digits = "+63" + digits[1:]
    if digits.startswith("639") and len(digits) == 12:
        digits = "+" + digits
    return digits if re.fullmatch(r"\+639\d{9}", digits) else None


def sms_submit_pdu(number: str, text: str) -> str:
    """SMS-SUBMIT TPDU (no SMSC, no validity period, GSM-7) for a +63 9XX number, as hex."""
    num = number.lstrip("+")
    bcd = "".join(num[i + 1] + num[i] if i + 1 < len(num) else "F" + num[i] for i in range(0, len(num), 2))
    t = gsm7_truncate(gsm7_safe(text))
    return ("00" + "01" + "00" + f"{len(num):02X}" + "91" + bcd + "00" + "00" + f"{gsm7_septets(t):02X}" + pack_septets(t).hex()).upper()


def valid_email(addr: str | None) -> bool:
    return bool(addr) and re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", addr or "") is not None


def signature(message_id: str, timestamp: str, body: str) -> str:
    key = os.environ.get("ALERT_SIGNING_KEY", DEV_SIGNING_KEY).encode()
    return hmac.new(key, f"{message_id}|{timestamp}|{body}".encode(), hashlib.sha256).hexdigest()[:32]


def mime_email(sender: str, to: list[str], subject: str, text: str) -> EmailMessage:
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = sender, ", ".join(to) or "undisclosed-recipients:;", subject
    m.set_content(text)
    html = "<br>".join(text.replace("&", "&amp;").replace("<", "&lt;").split("\n"))
    m.add_alternative(f"<div style=\"font-family:Inter,Arial,sans-serif;font-size:14px\"><b>{subject}</b><br><br>{html}</div>", subtype="html")
    return m


# ---------------------------------------------------------------- gateways
def _post(url: str, data: bytes, headers: dict[str, str]) -> tuple[bool, str]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return 200 <= r.status < 300, f"HTTP {r.status}"
    except Exception as exc:  # network errors are reported in the ledger, never raised
        return False, f"{type(exc).__name__}: {exc}"[:200]


def sms_gateways() -> list[str]:
    e = os.environ
    return [n for n, ok in (("SEMAPHORE", e.get("SEMAPHORE_API_KEY")), ("TWILIO", e.get("TWILIO_ACCOUNT_SID") and e.get("TWILIO_AUTH_TOKEN") and e.get("TWILIO_FROM")),
                             ("WEBHOOK", e.get("ALERT_WEBHOOK_URL"))) if ok]


def email_gateways() -> list[str]:
    e = os.environ
    return [n for n, ok in (("RESEND", e.get("RESEND_API_KEY") and e.get("ALERT_EMAIL_FROM")), ("SMTP", e.get("SMTP_HOST") and e.get("ALERT_EMAIL_FROM"))) if ok]


def send_sms(number: str, text: str) -> tuple[str, bool, str]:
    e = os.environ
    for g in sms_gateways():
        if g == "SEMAPHORE":
            ok, info = _post("https://api.semaphore.co/api/v4/messages", urllib.parse.urlencode(
                dict(apikey=e["SEMAPHORE_API_KEY"], number=number, message=text, sendername=e.get("SEMAPHORE_SENDER_NAME", "BAGUIOFLOOD"))).encode(),
                {"Content-Type": "application/x-www-form-urlencoded"})
        elif g == "TWILIO":
            auth = base64.b64encode(f"{e['TWILIO_ACCOUNT_SID']}:{e['TWILIO_AUTH_TOKEN']}".encode()).decode()
            ok, info = _post(f"https://api.twilio.com/2010-04-01/Accounts/{e['TWILIO_ACCOUNT_SID']}/Messages.json",
                             urllib.parse.urlencode(dict(From=e["TWILIO_FROM"], To=number, Body=text)).encode(),
                             {"Content-Type": "application/x-www-form-urlencoded", "Authorization": f"Basic {auth}"})
        else:
            ok, info = _post(e["ALERT_WEBHOOK_URL"], json.dumps(dict(channel="sms", to=number, text=text)).encode(), {"Content-Type": "application/json"})
        if ok:
            return g, True, info
    return (sms_gateways() or ["NONE"])[-1], False, "all SMS gateways failed"


def send_email(msg: EmailMessage) -> tuple[str, bool, str]:
    e = os.environ
    for g in email_gateways():
        if g == "RESEND":
            body = dict(**{"from": e["ALERT_EMAIL_FROM"]}, to=[a.strip() for a in msg["To"].split(",")], subject=msg["Subject"],
                        text=msg.get_body(("plain",)).get_content())
            ok, info = _post("https://api.resend.com/emails", json.dumps(body).encode(),
                             {"Content-Type": "application/json", "Authorization": f"Bearer {e['RESEND_API_KEY']}"})
        else:
            try:
                with smtplib.SMTP(e["SMTP_HOST"], int(e.get("SMTP_PORT", "587")), timeout=10) as s:
                    s.starttls()
                    if e.get("SMTP_USER"):
                        s.login(e["SMTP_USER"], e.get("SMTP_PASS", ""))
                    s.send_message(msg)
                ok, info = True, "SMTP 250"
            except Exception as exc:
                ok, info = False, f"{type(exc).__name__}: {exc}"[:200]
        if ok:
            return g, True, info
    return (email_gateways() or ["NONE"])[-1], False, "all e-mail gateways failed"


def contacts(group: str) -> dict[str, list[str]]:
    try:
        c = json.loads(os.environ.get("ALERT_CONTACTS", "") or "{}").get(group, {})
    except json.JSONDecodeError:
        c = {}
    return dict(phones=[p for p in c.get("phones", []) if normalise_ph_mobile(p)], emails=[m for m in c.get("emails", []) if valid_email(m)])


# ---------------------------------------------------------------- orchestration
def dispatch_alert(ctx: dict, group: str, custom_phone: str | None, custom_email: str | None, attach_pdf_summary: bool,
                   timestamp_utc: str, auto: bool = False) -> dict:
    """Builds, signs and (if gateways are configured) sends the SMS + e-mail for one recipient group.

    ctx: node_id, severity, cap_pct, dh_dt_cm_min, vision_pct, verdict, evac_lead_min.
    Returns the payloads plus one ledger row per channel x recipient.
    """
    group = group if group in GROUPS else "CUSTOM"
    sms = format_sms(ctx["node_id"], ctx["severity"], ctx["cap_pct"], ctx["dh_dt_cm_min"], ctx["vision_pct"], ctx["verdict"], ctx["evac_lead_min"])
    subject = email_subject(ctx["node_id"], ctx["severity"], ctx["verdict"])
    text = email_text(group, ctx["node_id"], ctx["severity"], ctx["cap_pct"], ctx["dh_dt_cm_min"], ctx["vision_pct"], ctx["verdict"],
                      ctx["evac_lead_min"], attach_pdf_summary)
    c = contacts(group)
    phones = list(c["phones"])
    emails = list(c["emails"])
    if custom_phone:
        n = normalise_ph_mobile(custom_phone)
        if n is None:
            raise ValueError("custom_phone must be a Philippine mobile number (+63 9XX XXX XXXX)")
        phones.append(n)
    if custom_email:
        if not valid_email(custom_email):
            raise ValueError("custom_email is not a valid address")
        emails.append(custom_email)
    live = not (auto and os.environ.get("ALERT_AUTO_LIVE") != "1")
    sender = os.environ.get("ALERT_EMAIL_FROM", "alerts@baguio-flood-intelligence.invalid")
    mime = mime_email(sender, emails, subject, text)
    message_id = f"BFI-{uuid.uuid4().hex[:12].upper()}"
    ledger: list[dict] = []

    def row(channel: str, recipient: str, mode: str, provider: str, status: str, body: str, info: str) -> None:
        ledger.append(dict(timestamp_utc=timestamp_utc, message_id=message_id, channel=channel, recipient_group=group, recipient=recipient,
                           severity=ctx["severity"], node_id=ctx["node_id"], fusion_verdict=ctx["verdict"], delivery_mode=mode, provider=provider,
                           status=status, info=info, body=body, signature=signature(message_id, timestamp_utc, body)))

    sms_targets = phones or [f"{GROUPS[group]['label']} (no number configured)"]
    for target in sms_targets:
        if live and sms_gateways() and normalise_ph_mobile(target):
            provider, ok, info = send_sms(target, sms)
            row("SMS", target, "LIVE_GATEWAY", provider, "DELIVERED" if ok else "FAILED", sms, info)
        else:
            row("SMS", target, "SANDBOX_VERIFIED_LOOPBACK", "LOOPBACK", "DELIVERED", sms, "sandbox: logged, not sent")
    if live and email_gateways() and emails:
        provider, ok, info = send_email(mime)
        row("EMAIL", ", ".join(emails), "LIVE_GATEWAY", provider, "DELIVERED" if ok else "FAILED", text, info)
    else:
        row("EMAIL", ", ".join(emails) or f"{GROUPS[group]['label']} (no address configured)", "SANDBOX_VERIFIED_LOOPBACK", "LOOPBACK", "DELIVERED", text,
            "sandbox: logged, not sent")
    first_phone = next((p for p in phones if normalise_ph_mobile(p)), None)
    return dict(
        message_id=message_id,
        delivery_mode="LIVE_GATEWAY" if any(r["delivery_mode"] == "LIVE_GATEWAY" for r in ledger) else "SANDBOX_VERIFIED_LOOPBACK",
        group=group, group_label=GROUPS[group]["label"],
        sms=dict(text=sms, septets=gsm7_septets(sms), segments=1, gsm7=True, pdu=sms_submit_pdu(first_phone, sms) if first_phone else None),
        email=dict(subject=subject, text=text, mime=mime.as_string()),
        ledger=ledger,
    )
