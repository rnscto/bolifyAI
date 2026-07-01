import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends pre-demo reminders via THREE channels in parallel:
//   1. Email (ACS SMTP)
//   2. WhatsApp (platform RCS Digital, uses demo_reminder_template_id or falls back to demo_booking_template_id)
//   3. AI reminder call (Smartflo + Vaani Sales Hub agent) — calls the lead's phone, the AI nudges them to join
//
// Modes:
//   • Cron / scheduled: scans DemoBooking for bookings starting in the [lead_minutes ± window] window
//   • Manual single: pass { booking_id } in body to fire for one booking immediately (admin only)
//   • Manual sweep: pass { sweep: true, lead_minutes?: 5 } in body to scan and fire (admin only)
//
// Idempotent via `reminder_sent_at`. Default lead_minutes = 5.



const TENANT_NAME = 'Vaani Internal Sales';
const DEFAULT_LEAD_MIN = 5;     // fire 5 min before scheduled_at
const WINDOW_MIN = 5;            // ± window around lead time (so 5min target → fire if 2.5–7.5 min away)

function fmtIST(iso) {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function buildReminderHtml({ booking, roomUrl, leadMinutes }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#1e3a5f,#3b82f6);color:#fff;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="margin:0;font-size:22px">⏰ Your Vaani Demo Starts in ${leadMinutes} Minutes</h1>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 8px 8px">
        <p>Hi ${booking.lead_name || 'there'},</p>
        <p>Quick reminder — your Vaani AI demo starts at <b>${fmtIST(booking.scheduled_at)} IST</b>.</p>
        <div style="text-align:center;margin:24px 0">
          <a href="${roomUrl}" style="background:#3b82f6;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block">🚀 Join Demo Room Now</a>
        </div>
        <p style="font-size:13px;color:#6b7280">💡 <b>Quick checklist:</b></p>
        <ul style="font-size:13px;color:#374151">
          <li>Use Chrome, Edge, or Safari on desktop</li>
          <li>Have headphones ready for best audio</li>
          <li>Allow microphone access when prompted</li>
        </ul>
      </div>
    </div>`;
}

// Fire all three channels for one booking. Returns a per-channel result.
async function fireReminder(svc, booking, { origin, leadMinutes }) {
  const roomUrl = `${(origin || 'https://vaaniai.in').replace(/\/+$/, '')}/DemoRoom?token=${booking.room_token}`;
  const result = { email: null, whatsapp: null, call: null };

  // ── 1. EMAIL ─────────────────────────────────────────
  if (booking.lead_email) {
    const html = buildReminderHtml({ booking, roomUrl, leadMinutes });
    const r = await svc.functions.invoke('sendAcsSmtpEmail', {
      to: booking.lead_email,
      subject: `⏰ Your Vaani Demo starts in ${leadMinutes} min — Join now`,
      html,
      from_name: 'Vaani AI Demo'
    }).catch(e => ({ error: e?.message }));
    result.email = r?.error ? `failed: ${r.error}` : 'sent';
  } else {
    result.email = 'skipped: no_email';
  }

  // ── 2. WHATSAPP ──────────────────────────────────────
  if (booking.lead_phone) {
    const r = await svc.functions.invoke('sendDemoBookingWhatsApp', {
      booking_id: booking.id
    }).catch(e => ({ error: e?.message }));
    const data = r?.data || r;
    if (data?.success) result.whatsapp = 'sent';
    else if (data?.skipped) result.whatsapp = `skipped: ${data.skipped}`;
    else result.whatsapp = `failed: ${data?.error || 'unknown'}`;
  } else {
    result.whatsapp = 'skipped: no_phone';
  }

  // ── 3. AI REMINDER CALL ─────────────────────────────
  // Uses the Vaani Internal Sales tenant + its primary agent.
  if (booking.lead_phone) {
    try {
      const tenants = await svc.entities.Client.filter({ company_name: TENANT_NAME });
      const tenant = tenants[0];
      if (!tenant) {
        result.call = 'skipped: vaani_tenant_not_found';
      } else {
        const agents = await svc.entities.Agent.filter({ client_id: tenant.id, status: 'active' }, '-created_date', 1);
        const agent = agents[0];
        if (!agent) {
          result.call = 'skipped: no_active_agent';
        } else {
          // Resolve / create lead inside Vaani tenant so initiateCall has lead_id
          let lead = null;
          if (booking.lead_id) {
            lead = await svc.entities.Lead.get(booking.lead_id).catch(() => null);
          }
          if (!lead && booking.lead_email) {
            const matches = await svc.entities.Lead.filter({ client_id: tenant.id, email: booking.lead_email }, '-created_date', 1);
            lead = matches[0] || null;
          }
          if (!lead) {
            lead = await svc.entities.Lead.create({
              client_id: tenant.id,
              name: booking.lead_name || (booking.lead_email || '').split('@')[0] || 'Demo Lead',
              email: booking.lead_email || '',
              phone: booking.lead_phone || '',
              company: booking.company_name || '',
              source: 'demo_booking',
              status: 'new',
              notes: `Auto-created for demo reminder call. Booking ${booking.booking_code || booking.id}`
            }).catch(() => null);
            if (lead) {
              await svc.entities.DemoBooking.update(booking.id, { lead_id: lead.id }).catch(() => {});
            }
          }

          if (!lead) {
            result.call = 'skipped: lead_create_failed';
          } else {
            const reminderContext = `URGENT REMINDER CALL: This lead has a Vaani demo scheduled in ${leadMinutes} minutes at ${fmtIST(booking.scheduled_at)} IST. Your ONLY job on this call is to: (1) politely remind them the demo is starting in ${leadMinutes} minutes, (2) confirm they will join, (3) share that the join link was emailed and WhatsApp'd to them. Keep the call under 60 seconds. Do NOT pitch — just remind and confirm. Booking code: ${booking.booking_code || 'N/A'}. Room URL: ${roomUrl}`;

            const r = await svc.functions.invoke('initiateCall', {
              lead_id: lead.id,
              agent_id: agent.id,
              phone_number: booking.lead_phone,
              service_call: true,
              context_override: reminderContext
            }).catch(e => ({ error: e?.message }));
            const data = r?.data || r;
            if (data?.success) result.call = `placed: ${data.call_sid || data.call_id || 'ok'}`;
            else result.call = `failed: ${data?.error || 'unknown'}`;
          }
        }
      }
    } catch (e) {
      result.call = `failed: ${e?.message || 'exception'}`;
    }
  } else {
    result.call = 'skipped: no_phone';
  }

  return result;
}

export default async function sendDemoReminder(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // Auth: cron key OR admin user
    const url = new URL(req.url);
    const cronKey = url.searchParams.get('key') || req.headers.get('x-cron-key') || '';
    const expectedKey = Deno.env.get('CRON_API_KEY') || '';
    const isCron = !!expectedKey && cronKey === expectedKey;

    let user = null;
    if (!isCron) {
      user = c.get('jwtPayload').catch(() => null);
      if (!user || user.role !== 'admin') {
        return c.json({ data: { error: 'Forbidden', hint: 'pass ?key=CRON_API_KEY or be admin' } }, 403);
      }
    }

    const body = await c.req.json().catch(() => ({}));
    const leadMinutes = Number(body.lead_minutes || DEFAULT_LEAD_MIN);
    const origin = req.headers.get('origin') || body.origin || 'https://vaaniai.in';
    const force = !!body.force; // bypass reminder_sent_at idempotency (manual override)

    // ── Mode 1: single booking (manual trigger from admin UI) ─────────
    if (body.booking_id) {
      const booking = await svc.entities.DemoBooking.get(body.booking_id).catch(() => null);
      if (!booking) return c.json({ data: { error: 'Booking not found' } }, 404);
      if (booking.reminder_sent_at && !force) {
        return c.json({ data: { success: true, skipped: 'already_sent', reminder_sent_at: booking.reminder_sent_at } });
      }
      const result = await fireReminder(svc, booking, { origin, leadMinutes });
      await svc.entities.DemoBooking.update(booking.id, { reminder_sent_at: new Date().toISOString() }).catch(() => {});
      return c.json({ data: { success: true, booking_id: booking.id, lead_minutes: leadMinutes, result } });
    }

    // ── Mode 2: sweep (cron OR manual sweep button) ───────────────────
    const now = Date.now();
    const windowStart = new Date(now + (leadMinutes - WINDOW_MIN / 2) * 60 * 1000);
    const windowEnd = new Date(now + (leadMinutes + WINDOW_MIN / 2) * 60 * 1000);

    const all = await svc.entities.DemoBooking.filter({ status: 'scheduled' }, '-scheduled_at', 200).catch(() => []);
    const due = all.filter(b => {
      if (b.reminder_sent_at && !force) return false;
      const t = new Date(b.scheduled_at).getTime();
      return t >= windowStart.getTime() && t <= windowEnd.getTime();
    });

    const results = [];
    for (const booking of due) {
      const r = await fireReminder(svc, booking, { origin, leadMinutes });
      await svc.entities.DemoBooking.update(booking.id, { reminder_sent_at: new Date().toISOString() }).catch(() => {});
      results.push({ booking_id: booking.id, code: booking.booking_code, ...r });
    }

    return c.json({ data: {
      success: true,
      lead_minutes: leadMinutes,
      checked: all.length,
      due: due.length,
      window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      results
    } });
  } catch (error) {
    console.error('sendDemoReminder error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};