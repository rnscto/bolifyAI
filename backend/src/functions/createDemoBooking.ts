import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public endpoint: create a demo booking from website / voice agent / admin.
// Validates slot, generates room + cancel tokens, sends invite email + WhatsApp,
// tracks delivery status, supports idempotency and consent capture.



const SALES_CC = ['sales@vaaniai.io'];
const DEFAULT_EXPIRY_HOURS = 24; // hours after scheduled_at when token stops working

function genCode() {
  const r = crypto.randomUUID().replace(/-/g, '').substring(0, 6).toUpperCase();
  return `DEMO-${r}`;
}
function genToken() { return crypto.randomUUID().replace(/-/g, ''); }

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fmtIST(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function pad(n) { return String(n).padStart(2, '0'); }
function toIcsDate(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function buildIcs({ booking, roomUrl }) {
  const start = new Date(booking.scheduled_at);
  const end = new Date(start.getTime() + (booking.duration_minutes || 30) * 60 * 1000);
  const dtstamp = toIcsDate(new Date());
  const uid = `vaani-demo-${booking.booking_code}@vaaniai.in`;
  const desc = `Your Vaani AI demo session.\\n\\nJoin: ${roomUrl}\\n\\nBooking: ${booking.booking_code}`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vaani AI//Demo Booking//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`,
    `DTSTART:${toIcsDate(start)}`, `DTEND:${toIcsDate(end)}`,
    `SUMMARY:Vaani AI Demo (${booking.booking_code})`,
    `DESCRIPTION:${desc}`, `LOCATION:${roomUrl}`, `URL:${roomUrl}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY',
    'DESCRIPTION:Vaani AI demo starting in 15 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
}

// "Add to Google Calendar" URL
function googleCalUrl({ booking, roomUrl }) {
  const start = new Date(booking.scheduled_at);
  const end = new Date(start.getTime() + (booking.duration_minutes || 30) * 60 * 1000);
  const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Vaani AI Demo (${booking.booking_code})`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: `Join your Vaani AI demo: ${roomUrl}`,
    location: roomUrl
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
// Outlook web cal URL
function outlookCalUrl({ booking, roomUrl }) {
  const start = new Date(booking.scheduled_at).toISOString();
  const end = new Date(new Date(booking.scheduled_at).getTime() + (booking.duration_minutes || 30) * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: `Vaani AI Demo (${booking.booking_code})`,
    startdt: start, enddt: end,
    body: `Join your Vaani AI demo: ${roomUrl}`,
    location: roomUrl
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function buildInviteHtml({ booking, roomUrl, cancelUrl, gcalUrl, outlookUrl }) {
  const when = fmtIST(booking.scheduled_at);
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#1e3a5f,#3b82f6);color:#fff;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="margin:0;font-size:22px">🎤 Your Vaani AI Demo is Confirmed</h1>
        <p style="margin:8px 0 0;opacity:.9">Booking ${booking.booking_code}</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 8px 8px">
        <p>Hi ${booking.lead_name || 'there'},</p>
        <p>Thanks for booking a demo with Vaani AI. Your AI demo agent will meet you live and walk you through the platform.</p>

        <div style="background:#f8fafc;border-left:4px solid #3b82f6;padding:16px;margin:20px 0;border-radius:4px">
          <p style="margin:0 0 6px"><b>📅 When:</b> ${when}</p>
          <p style="margin:0 0 6px"><b>⏱️ Duration:</b> ${booking.duration_minutes} minutes</p>
          <p style="margin:0 0 6px"><b>🗣️ Language:</b> ${booking.language === 'hi' ? 'Hindi' : booking.language === 'bilingual' ? 'English + Hindi' : 'English'}</p>
          ${booking.focus_area ? `<p style="margin:0"><b>🎯 Focus:</b> ${booking.focus_area}</p>` : ''}
        </div>

        <div style="text-align:center;margin:24px 0">
          <a href="${roomUrl}" style="background:#3b82f6;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block">🚀 Join Demo Room</a>
          <p style="margin:12px 0 0;font-size:12px;color:#6b7280">Best to open this 1-2 minutes before the start time.</p>
        </div>

        <div style="text-align:center;margin:16px 0;font-size:13px">
          <a href="${gcalUrl}" style="display:inline-block;margin:4px 6px;padding:8px 14px;background:#fff;border:1px solid #d1d5db;border-radius:4px;color:#374151;text-decoration:none">📅 Add to Google Calendar</a>
          <a href="${outlookUrl}" style="display:inline-block;margin:4px 6px;padding:8px 14px;background:#fff;border:1px solid #d1d5db;border-radius:4px;color:#374151;text-decoration:none">📅 Add to Outlook</a>
        </div>

        <p style="font-size:14px;margin-top:24px"><b>What to expect:</b></p>
        <ul style="font-size:14px;color:#374151">
          <li>You'll be greeted by Vaani, our AI demo agent</li>
          <li>You'll be asked to share your screen (optional)</li>
          <li>The agent will walk you through the platform live, answer questions, and pause anytime you want</li>
          <li>A human sales rep is on standby — just say "talk to a human" anytime</li>
        </ul>

        <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;margin:20px 0;border-radius:4px;font-size:12px;color:#78350f">
          <b>📹 Recording notice:</b> Your demo session will be recorded and transcribed for quality and follow-up purposes. By joining, you consent to this. Data is retained per our <a href="https://vaaniai.io/PrivacyPolicy" style="color:#78350f">privacy policy</a>.
        </div>

        <p style="font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:16px;margin-top:24px">
          Need to reschedule? Just reply to this email. <br/>
          Can't make it? <a href="${cancelUrl}" style="color:#dc2626">Cancel this booking</a>.
        </p>
      </div>
    </div>`;
}

export default async function createDemoBooking(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Public endpoint — verification_token + idempotency_key + slot/rate checks gate access.
    const svc = base44;;

    const body = await c.req.json();
    const {
      lead_name, lead_email, lead_phone, company_name, industry, team_size,
      focus_area, language = 'bilingual', scheduled_at, duration_minutes = 30,
      source = 'website', lead_id, cc_sales_emails,
      idempotency_key, recording_consent = false, terms_consent = false,
      verification_token
    } = body;

    if (!lead_email || !scheduled_at) {
      return c.json({ data: { error: 'lead_email and scheduled_at required' } }, 400);
    }
    const normalizedEmail = String(lead_email).trim().toLowerCase();

    // ── EMAIL OTP VERIFICATION (skipped for voice_agent + admin sources) ─────
    // Website / lead-initiated bookings MUST pass a valid verification_token from verifyDemoOtp.
    if (source === 'website' || source === 'lead') {
      if (!verification_token) {
        return c.json({ data: { error: 'Email verification required. Please verify your email with the OTP first.' } }, 401);
      }
      const records = await svc.entities.DemoOtpVerification.filter({
        email: normalizedEmail, verification_token
      }).catch(() => []);
      const rec = records[0];
      if (!rec || !rec.verified || rec.invalidated) {
        return c.json({ data: { error: 'Invalid verification. Please re-verify your email.' } }, 401);
      }
      if (rec.token_expires_at && new Date(rec.token_expires_at) < new Date()) {
        return c.json({ data: { error: 'Verification expired. Please verify your email again.' } }, 401);
      }
    }

    // ── ONE ACTIVE DEMO PER EMAIL (backstop — UI also blocks this) ───────────
    const nowIso = new Date().toISOString();
    const myUpcoming = await svc.entities.DemoBooking.filter({
      lead_email: normalizedEmail, status: 'scheduled'
    }).catch(() => []);
    const stillUpcoming = myUpcoming.find(b => b.scheduled_at && b.scheduled_at >= nowIso);
    if (stillUpcoming && source !== 'admin') {
      return c.json({ data: {
        error: 'You already have an upcoming demo booked with this email. Please cancel it first to book a new slot.',
        existing_booking_code: stillUpcoming.booking_code,
        existing_scheduled_at: stillUpcoming.scheduled_at
      } }, 409);
    }

    // Idempotency — if the same key was used in the last 10 minutes, return the existing booking
    if (idempotency_key) {
      const existing = await svc.entities.DemoBooking.filter({ idempotency_key }).catch(() => []);
      if (existing.length) {
        const origin = req.headers.get('origin') || 'https://vaaniai.in';
        const roomUrl = `${origin.replace(/\/+$/, '')}/DemoRoom?token=${existing[0].room_token}`;
        return c.json({ data: { success: true, booking: existing[0], room_url: roomUrl, idempotent: true } });
      }
    }

    const slotTime = new Date(scheduled_at);
    if (isNaN(slotTime.getTime())) return c.json({ data: { error: 'Invalid scheduled_at' } }, 400);
    if (slotTime < new Date(Date.now() + 30 * 60 * 1000)) {
      return c.json({ data: { error: 'Slot must be at least 30 minutes in the future' } }, 400);
    }

    // Rate limit (per email/phone/hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentByEmail = await svc.entities.DemoBooking.filter({ lead_email: normalizedEmail }).catch(() => []);
    if (recentByEmail.filter(b => b.created_date >= oneHourAgo).length >= 5) {
      return c.json({ data: { error: 'Too many bookings in the last hour.' } }, 429);
    }
    if (lead_phone) {
      const recentByPhone = await svc.entities.DemoBooking.filter({ lead_phone }).catch(() => []);
      if (recentByPhone.filter(b => b.created_date >= oneHourAgo).length >= 3) {
        return c.json({ data: { error: 'Too many bookings from this phone in the last hour.' } }, 429);
      }
    }

    // Slot conflict check
    const conflict = await svc.entities.DemoBooking.filter({
      scheduled_at: slotTime.toISOString(), status: 'scheduled'
    }).catch(() => []);
    if (conflict.length > 0) {
      return c.json({ data: { error: 'This slot was just taken. Please pick another.' } }, 409);
    }

    // Capture abuse-detection signals (hashed, no raw IP stored)
    const fwd = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '';
    const ipHash = fwd ? await sha256(fwd.split(',')[0].trim()) : '';
    const ua = (req.headers.get('user-agent') || '').slice(0, 200);

    const bookingCode = genCode();
    const roomToken = genToken();
    const cancelToken = genToken();
    const expiresAt = new Date(slotTime.getTime() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    const booking = await svc.entities.DemoBooking.create({
      booking_code: bookingCode,
      lead_name: lead_name || '',
      lead_email: normalizedEmail,
      lead_phone: lead_phone || '',
      company_name: company_name || '',
      industry: industry || '',
      team_size: team_size || '',
      focus_area: focus_area || '',
      language,
      scheduled_at: slotTime.toISOString(),
      duration_minutes,
      expires_at: expiresAt,
      room_token: roomToken,
      cancel_token: cancelToken,
      status: 'scheduled',
      source,
      lead_id: lead_id || '',
      cc_sales_emails: Array.isArray(cc_sales_emails) && cc_sales_emails.length ? cc_sales_emails : SALES_CC,
      idempotency_key: idempotency_key || '',
      lead_user_agent: ua,
      lead_ip_hash: ipHash,
      recording_consent: !!recording_consent,
      recording_consent_at: recording_consent ? new Date().toISOString() : '',
      terms_consent: !!terms_consent,
      terms_consent_at: terms_consent ? new Date().toISOString() : '',
      email_delivery_status: 'pending',
      whatsapp_delivery_status: lead_phone ? 'pending' : 'skipped'
    });

    const origin = req.headers.get('origin') || req.headers.get('referer')?.replace(/\/[^/]*$/, '') || 'https://vaaniai.in';
    const baseOrigin = origin.replace(/\/+$/, '');
    const roomUrl = `${baseOrigin}/DemoRoom?token=${roomToken}`;
    const cancelUrl = `${baseOrigin}/DemoRoom?cancel=${cancelToken}`;
    const gcalUrl = googleCalUrl({ booking, roomUrl });
    const outlookUrl = outlookCalUrl({ booking, roomUrl });

    // Send invite email (tracked)
    const html = buildInviteHtml({ booking, roomUrl, cancelUrl, gcalUrl, outlookUrl });
    const subject = `🎤 Your Vaani AI Demo — ${fmtIST(booking.scheduled_at)}`;
    const icsBase64 = btoa(buildIcs({ booking, roomUrl }));

    svc.functions.invoke('sendAcsSmtpEmail', {
      to: lead_email, subject, html, from_name: 'Vaani AI Demo',
      attachments: [{
        filename: `vaani-demo-${booking.booking_code}.ics`,
        content: icsBase64,
        contentType: 'text/calendar; method=REQUEST; charset=UTF-8'
      }]
    })
      .then(() => svc.entities.DemoBooking.update(booking.id, { email_delivery_status: 'sent' }).catch(() => {}))
      .catch(e => {
        console.error('Lead invite email failed:', e?.message);
        svc.entities.DemoBooking.update(booking.id, {
          email_delivery_status: 'failed', email_delivery_error: String(e?.message || e).slice(0, 500)
        }).catch(() => {});
        svc.functions.invoke('notifyDemoAlert', {
          severity: 'critical',
          title: 'Demo invite email FAILED',
          message: `Lead: ${lead_email}\nBooking: ${booking.booking_code}\nError: ${e?.message}`,
          booking_id: booking.id
        }).catch(() => {});
      });

    // Notify sales reps
    if (booking.cc_sales_emails?.length) {
      const salesHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#1e3a5f">📅 New Demo Booked</h2>
          <p><b>${booking.lead_name || 'Unknown'}</b>${booking.company_name ? ` from <b>${booking.company_name}</b>` : ''}</p>
          <ul>
            <li><b>Email:</b> ${booking.lead_email}</li>
            ${booking.lead_phone ? `<li><b>Phone:</b> ${booking.lead_phone}</li>` : ''}
            <li><b>When:</b> ${fmtIST(booking.scheduled_at)}</li>
            <li><b>Industry:</b> ${booking.industry || '—'}</li>
            <li><b>Focus:</b> ${booking.focus_area || '—'}</li>
            <li><b>Language:</b> ${booking.language}</li>
          </ul>
          <p>Vaani AI will conduct the demo. You can <a href="${roomUrl}">join the room</a> to listen in or take over.</p>
        </div>`;
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: booking.cc_sales_emails,
        subject: `[Demo] ${booking.lead_name || booking.lead_email} — ${fmtIST(booking.scheduled_at)}`,
        html: salesHtml, from_name: 'Vaani AI'
      }).catch(e => console.error('Sales notify email failed:', e?.message));
    }

    // WhatsApp dispatch + delivery tracking
    if (lead_phone) {
      svc.functions.invoke('sendDemoBookingWhatsApp', { booking_id: booking.id })
        .then(r => {
          const ok = r?.data?.success;
          svc.entities.DemoBooking.update(booking.id, {
            whatsapp_delivery_status: ok ? 'sent' : (r?.data?.skipped ? 'skipped' : 'failed'),
            whatsapp_delivery_error: ok ? '' : String(r?.data?.error || r?.data?.skipped || '').slice(0, 500)
          }).catch(() => {});
        })
        .catch(e => {
          svc.entities.DemoBooking.update(booking.id, {
            whatsapp_delivery_status: 'failed', whatsapp_delivery_error: String(e?.message || e).slice(0, 500)
          }).catch(() => {});
        });
    }

    // Race-condition dedup sweep (best-effort)
    setTimeout(async () => {
      try {
        const dupes = await svc.entities.DemoBooking.filter({
          scheduled_at: slotTime.toISOString(), status: 'scheduled'
        });
        if (dupes.length > 1) {
          const sorted = dupes.sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
          for (const loser of sorted.slice(1)) {
            await svc.entities.DemoBooking.update(loser.id, {
              status: 'cancelled', notes: 'Auto-cancelled: slot already taken (race condition)'
            }).catch(() => {});
          }
        }
      } catch (_) {}
    }, 1500);

    return c.json({ data: { success: true, booking, room_url: roomUrl, cancel_url: cancelUrl } });
  } catch (error) {
    console.error('createDemoBooking error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};