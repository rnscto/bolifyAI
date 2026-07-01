import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Send a 6-digit OTP to the lead's email to verify ownership before they can book a demo.
// Also enforces "one active demo per email" — if an upcoming scheduled demo already exists,
// the OTP is NOT sent and the existing booking is returned so the lead can manage it instead.
//
// Payload: { lead_email }
// Returns:
//   { success: true, expires_in: 600 } → OTP sent
//   { existing_booking: true, booking_code, scheduled_at } → already has an upcoming demo
//   { error: "..." } on validation failure



const OTP_TTL_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 30;
// Per-IP abuse cap — bucket size measured by OTP rows created in the last hour
// with a hashed source IP. Prevents a single attacker from spamming many
// different addresses through the public form.
const OTP_PER_IP_HOURLY_LIMIT = 10;

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── ACS REST email sender (HMAC-signed) — inlined to avoid auth indirection ──
function b64Buf(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
async function sha256B64(text) {
  return b64Buf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
async function hmacSha256B64(keyB64, text) {
  const keyBytes = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64Buf(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
}
async function acsSendEmail({ endpoint, accessKey, fromAddr, to, subject, html }) {
  const url = new URL(`${endpoint}/emails:send?api-version=2023-03-31`);
  const body = JSON.stringify({
    senderAddress: fromAddr,
    content: { subject, html },
    recipients: { to: [{ address: to }] }
  });
  const dateStr = new Date().toUTCString();
  const contentHash = await sha256B64(body);
  const stringToSign = `POST\n${url.pathname + url.search}\n${dateStr};${url.host};${contentHash}`;
  const signature = await hmacSha256B64(accessKey, stringToSign);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ms-date': dateStr,
      'x-ms-content-sha256': contentHash,
      'Authorization': `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
    },
    body
  });
  if (!res.ok && res.status !== 202) {
    const errText = await res.text();
    console.error(`[sendDemoOtp] ACS send failed: ${res.status} - ${errText.substring(0, 500)}`);
    return { ok: false, status: res.status, errText: errText.substring(0, 500) };
  }
  return { ok: true };
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

function fmtIST(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric',
      month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
    }) + ' IST';
  } catch { return iso; }
}

function otpEmailHtml({ otp, lead_email }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#1e3a5f,#3b82f6);color:#fff;padding:24px;border-radius:8px 8px 0 0;text-align:center">
        <h1 style="margin:0;font-size:20px">🔐 Verify your email</h1>
        <p style="margin:6px 0 0;opacity:.9;font-size:13px">Vaani AI Demo Booking</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:28px;border-radius:0 0 8px 8px">
        <p style="font-size:15px;color:#1f2937">Enter this code on the booking page to verify <b>${lead_email}</b>:</p>
        <div style="text-align:center;margin:24px 0">
          <div style="display:inline-block;background:#f1f5f9;border:2px dashed #3b82f6;border-radius:10px;padding:18px 36px;font-size:32px;font-weight:700;letter-spacing:8px;color:#1e3a5f;font-family:monospace">${otp}</div>
        </div>
        <p style="font-size:13px;color:#6b7280;text-align:center">This code expires in ${OTP_TTL_MINUTES} minutes.</p>
        <p style="font-size:12px;color:#9ca3af;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:14px">
          If you didn't request this, you can safely ignore this email — no booking will be created.
        </p>
      </div>
    </div>`;
}

export default async function sendDemoOtp(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const { lead_email } = await c.req.json();

    if (!isValidEmail(lead_email)) {
      return c.json({ data: { error: 'Please enter a valid email address' } }, 400);
    }
    const email = String(lead_email).trim().toLowerCase();

    // ── ONE ACTIVE DEMO PER EMAIL ────────────────────────────────────────────
    // If an upcoming scheduled demo already exists for this email, block new booking
    // and surface the existing booking so the UI can offer "manage / cancel / reschedule".
    const nowIso = new Date().toISOString();
    const existing = await svc.entities.DemoBooking.filter({
      lead_email: email, status: 'scheduled'
    }).catch(() => []);
    const upcoming = existing.filter(b => b.scheduled_at && b.scheduled_at >= nowIso)
      .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
    if (upcoming) {
      return c.json({ data: {
        existing_booking: true,
        booking_code: upcoming.booking_code,
        scheduled_at: upcoming.scheduled_at,
        scheduled_at_label: fmtIST(upcoming.scheduled_at),
        cancel_url: `/DemoRoom?cancel=${upcoming.cancel_token}`,
        message: `You already have an upcoming demo on ${fmtIST(upcoming.scheduled_at)}. Please cancel it first if you want to pick a different time.`
      } });
    }

    // ── COOLDOWN: don't allow re-sending OTP within 30 seconds ───────────────
    const recent = await svc.entities.DemoOtpVerification.filter({ email }).catch(() => []);
    const lastSent = recent.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];
    if (lastSent) {
      const ageSec = (Date.now() - new Date(lastSent.created_date).getTime()) / 1000;
      if (ageSec < OTP_RESEND_COOLDOWN_SECONDS) {
        return c.json({ data: {
          error: `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - ageSec)}s before requesting another code.`
        } }, 429);
      }
    }

    // ── PER-IP HOURLY RATE LIMIT (abuse / mass-enum protection) ──────────────
    // Hashed IP keeps PII out of the DB. If the same IP has caused more than
    // OTP_PER_IP_HOURLY_LIMIT OTPs in the last hour, block further sends.
    const rawIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
    let ipHash = '';
    if (rawIp) {
      try { ipHash = (await sha256(rawIp)).slice(0, 24); } catch { /* ignore */ }
    }
    if (ipHash) {
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recentFromIp = await svc.entities.DemoOtpVerification
        .filter({ source_ip_hash: ipHash })
        .catch(() => []);
      const hourly = recentFromIp.filter(r => r.created_date >= cutoff).length;
      if (hourly >= OTP_PER_IP_HOURLY_LIMIT) {
        console.warn(`[sendDemoOtp] IP rate-limited: ${ipHash} (${hourly}/${OTP_PER_IP_HOURLY_LIMIT})`);
        return c.json({ data: {
          error: 'Too many verification requests from this device. Please try again later.'
        } }, 429);
      }
    }

    // ── GENERATE + STORE OTP (hashed) ────────────────────────────────────────
    const otp = genOtp();
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

    // Invalidate any previous unused OTPs for this email
    for (const old of recent.filter(r => !r.verified)) {
      await svc.entities.DemoOtpVerification.update(old.id, { invalidated: true }).catch(() => {});
    }

    await svc.entities.DemoOtpVerification.create({
      email,
      otp_hash: otpHash,
      expires_at: expiresAt,
      verified: false,
      attempts: 0,
      source_ip_hash: ipHash || undefined,
    });

    // ── SEND EMAIL DIRECTLY via Azure Communication Services (public endpoint — no auth indirection) ──
    const endpoint = (Deno.env.get('AZURE_COMM_ENDPOINT') || '').replace(/\/+$/, '');
    const accessKey = Deno.env.get('AZURE_COMM_KEY');
    const fromAddr = Deno.env.get('ACS_SMTP_FROM');
    if (!endpoint || !accessKey || !fromAddr) {
      console.error('sendDemoOtp: ACS env not set');
      return c.json({ data: { error: 'Email service not configured' } }, 500);
    }
    const sendRes = await acsSendEmail({
      endpoint, accessKey, fromAddr,
      to: email,
      subject: `Your Vaani AI verification code: ${otp}`,
      html: otpEmailHtml({ otp, lead_email: email })
    });
    if (!sendRes.ok) {
      console.error('sendDemoOtp: ACS send failed', sendRes.status, sendRes.errText);
      return c.json({ data: { error: 'Could not send verification email. Please try again.' } }, 500);
    }

    return c.json({ data: { success: true, expires_in: OTP_TTL_MINUTES * 60 } });
  } catch (error) {
    console.error('sendDemoOtp error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};