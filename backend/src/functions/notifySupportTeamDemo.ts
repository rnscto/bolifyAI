import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends an email to every active Support Team member whenever a demo event
// happens (new booking, AI failure, no-show, takeover requested). Uses ACS SMTP
// via sendAcsSmtpEmail. Only members with handles_categories containing 'sales'
// receive the email; if none are tagged for sales, all active members are notified.
//
// Payload: { kind: 'new_booking'|'alert', booking_id, severity?, title?, message? }



function fmtIST(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric',
      month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    }) + ' IST';
  } catch { return iso || '—'; }
}

function buildNewBookingEmail(booking, joinUrl, adminUrl) {
  const subject = `🎤 New Vaani Demo: ${booking.lead_name || booking.lead_email} · ${fmtIST(booking.scheduled_at)}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
      <h2 style="color:#1e3a5f">New Demo Booking</h2>
      <p style="color:#475569">A new lead just booked a Vaani product demo. Please be ready to take over if the AI needs help.</p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;overflow:hidden">
        <tr><td style="padding:10px 14px;color:#64748b;width:120px">Code</td><td style="padding:10px 14px"><b>${booking.booking_code || '—'}</b></td></tr>
        <tr><td style="padding:10px 14px;color:#64748b">When (IST)</td><td style="padding:10px 14px"><b>${fmtIST(booking.scheduled_at)}</b></td></tr>
        <tr><td style="padding:10px 14px;color:#64748b">Lead</td><td style="padding:10px 14px">${booking.lead_name || '—'} &lt;${booking.lead_email}&gt;</td></tr>
        ${booking.lead_phone ? `<tr><td style="padding:10px 14px;color:#64748b">Phone</td><td style="padding:10px 14px">${booking.lead_phone}</td></tr>` : ''}
        ${booking.company_name ? `<tr><td style="padding:10px 14px;color:#64748b">Company</td><td style="padding:10px 14px">${booking.company_name}</td></tr>` : ''}
        ${booking.focus_area ? `<tr><td style="padding:10px 14px;color:#64748b">Focus</td><td style="padding:10px 14px">${booking.focus_area}</td></tr>` : ''}
        <tr><td style="padding:10px 14px;color:#64748b">Language</td><td style="padding:10px 14px">${booking.language || 'bilingual'}</td></tr>
        <tr><td style="padding:10px 14px;color:#64748b">Source</td><td style="padding:10px 14px">${booking.source || 'website'}</td></tr>
      </table>
      <div style="margin:24px 0;text-align:center">
        <a href="${joinUrl}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Join as Human Agent</a>
        <a href="${adminUrl}" style="background:#1e3a5f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;margin-left:8px">Open in Admin</a>
      </div>
      <p style="color:#94a3b8;font-size:12px;text-align:center">You're receiving this because you're an active Vaani Support Team member.</p>
    </div>`;
  return { subject, html };
}

function buildAlertEmail(booking, severity, title, message, joinUrl, adminUrl) {
  const icon = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
  const color = severity === 'critical' ? '#dc2626' : severity === 'warning' ? '#d97706' : '#0369a1';
  const subject = `${icon} Demo Alert: ${title}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
      <h2 style="color:${color}">${icon} ${title}</h2>
      <p style="white-space:pre-wrap">${(message || '').replace(/</g, '&lt;')}</p>
      ${booking ? `<p style="color:#64748b;font-size:14px">Booking <b>${booking.booking_code}</b> · Lead: ${booking.lead_name || booking.lead_email} · ${fmtIST(booking.scheduled_at)}</p>` : ''}
      ${joinUrl ? `<div style="margin:18px 0"><a href="${joinUrl}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Jump into demo as agent</a> <a href="${adminUrl}" style="color:#1e3a5f;margin-left:8px">Admin view →</a></div>` : ''}
    </div>`;
  return { subject, html };
}

export default async function notifySupportTeamDemo(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const body = await c.req.json().catch(() => ({}));

    // Entity automation passes event/data; manual invoke passes kind/booking_id directly
    const isEntityEvent = !!body.event;
    const kind = isEntityEvent ? 'new_booking' : (body.kind || 'new_booking');
    const bookingId = body.booking_id || body.event?.entity_id;
    const severity = body.severity || 'info';
    const title = body.title || 'Demo update';
    const message = body.message || '';

    if (!bookingId && kind === 'new_booking') return c.json({ data: { skipped: 'no_booking_id' } });

    let booking = null;
    if (bookingId) {
      booking = body.data || await svc.entities.DemoBooking.get(bookingId).catch(() => null);
    }

    // Resolve recipients: active SupportTeamMembers tagged with 'sales' (fallback: all active)
    const allMembers = await svc.entities.SupportTeamMember.filter({ is_active: true }).catch(() => []);
    let recipients = allMembers.filter(m => (m.handles_categories || []).includes('sales'));
    if (recipients.length === 0) recipients = allMembers;
    if (recipients.length === 0) return c.json({ data: { skipped: 'no_support_team' } });

    // Build join + admin URLs
    const origin = body.origin || Deno.env.get('APP_BASE_URL') || 'https://app.vaaniai.com';
    const joinUrl = booking?.room_token ? `${origin}/DemoRoom?token=${booking.room_token}&agent=1` : '';
    const adminUrl = `${origin}/AdminDemoBookings`;

    const { subject, html } = kind === 'alert'
      ? buildAlertEmail(booking, severity, title, message, joinUrl, adminUrl)
      : buildNewBookingEmail(booking, joinUrl, adminUrl);

    // Fan-out emails via internal SMTP helper
    const results = await Promise.allSettled(recipients.map(m =>
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: m.user_email,
        subject,
        html
      })
    ));

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - sent;
    return c.json({ data: { success: true, recipients: recipients.length, sent, failed, kind } });
  } catch (error) {
    console.error('notifySupportTeamDemo error', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};