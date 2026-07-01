import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public endpoint: reschedule an existing demo booking via the room_token or cancel_token.
// Updates scheduled_at + expires_at, checks the new slot is free, notifies lead + sales.
//
// POST { token, new_scheduled_at }
//   token            — room_token OR cancel_token from the invite email
//   new_scheduled_at — ISO datetime of the new slot (must be ≥30 min in the future)



const DEFAULT_EXPIRY_HOURS = 24;

function fmtIST(iso) {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function buildRescheduleHtml({ booking, roomUrl, oldWhen, newWhen }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#1e3a5f,#3b82f6);color:#fff;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="margin:0;font-size:22px">📅 Your Demo Has Been Rescheduled</h1>
        <p style="margin:8px 0 0;opacity:.9">Booking ${booking.booking_code}</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 8px 8px">
        <p>Hi ${booking.lead_name || 'there'},</p>
        <p>Your Vaani AI demo has been moved to a new time.</p>

        <div style="background:#f8fafc;border-left:4px solid #3b82f6;padding:16px;margin:20px 0;border-radius:4px">
          <p style="margin:0 0 6px;color:#64748b;text-decoration:line-through"><b>Previous:</b> ${oldWhen}</p>
          <p style="margin:0;color:#1e3a5f;font-size:16px"><b>📅 New time:</b> ${newWhen}</p>
        </div>

        <div style="text-align:center;margin:24px 0">
          <a href="${roomUrl}" style="background:#3b82f6;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block">🚀 Join Demo Room</a>
        </div>

        <p style="font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:16px;margin-top:24px">
          Your demo room link stays the same — just open it 1-2 minutes before your new time.
        </p>
      </div>
    </div>`;
}

export default async function rescheduleDemoBooking(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Public endpoint — gated by secret room_token / cancel_token.
    const svc = base44;;
    const { token, new_scheduled_at } = await c.req.json();

    if (!token || !new_scheduled_at) {
      return c.json({ data: { error: 'token and new_scheduled_at required' } }, 400);
    }

    // Look up by room_token OR cancel_token
    let matches = await svc.entities.DemoBooking.filter({ room_token: token }).catch(() => []);
    if (!matches.length) {
      matches = await svc.entities.DemoBooking.filter({ cancel_token: token }).catch(() => []);
    }
    if (!matches.length) return c.json({ data: { error: 'Invalid reschedule link' } }, 404);
    const booking = matches[0];

    if (['cancelled', 'completed', 'no_show', 'expired'].includes(booking.status)) {
      return c.json({ data: { error: `Cannot reschedule a ${booking.status} booking. Please book a new slot.` } }, 400);
    }
    if (booking.status === 'in_progress') {
      return c.json({ data: { error: 'Cannot reschedule an in-progress demo.' } }, 400);
    }

    const newSlot = new Date(new_scheduled_at);
    if (isNaN(newSlot.getTime())) {
      return c.json({ data: { error: 'Invalid new_scheduled_at' } }, 400);
    }
    if (newSlot < new Date(Date.now() + 30 * 60 * 1000)) {
      return c.json({ data: { error: 'New slot must be at least 30 minutes in the future' } }, 400);
    }

    const newIso = newSlot.toISOString();
    if (newIso === booking.scheduled_at) {
      return c.json({ data: { error: 'This is already your current slot.' } }, 400);
    }

    // Slot conflict check (ignore self)
    const conflict = await svc.entities.DemoBooking.filter({
      scheduled_at: newIso, status: 'scheduled'
    }).catch(() => []);
    if (conflict.some(b => b.id !== booking.id)) {
      return c.json({ data: { error: 'This slot was just taken. Please pick another.' } }, 409);
    }

    const oldScheduled = booking.scheduled_at;
    const newExpiresAt = new Date(newSlot.getTime() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    await svc.entities.DemoBooking.update(booking.id, {
      scheduled_at: newIso,
      expires_at: newExpiresAt,
      reminder_sent_at: '', // reset reminder so it re-fires for new time
      notes: (booking.notes ? booking.notes + '\n' : '') +
        `Rescheduled by lead: ${fmtIST(oldScheduled)} → ${fmtIST(newIso)}`
    });

    const origin = req.headers.get('origin') || req.headers.get('referer')?.replace(/\/[^/]*$/, '') || 'https://vaaniai.in';
    const baseOrigin = origin.replace(/\/+$/, '');
    const roomUrl = `${baseOrigin}/DemoRoom?token=${booking.room_token}`;

    // Notify lead
    svc.functions.invoke('sendAcsSmtpEmail', {
      to: booking.lead_email,
      subject: `📅 Your Vaani AI Demo has been rescheduled — ${fmtIST(newIso)}`,
      html: buildRescheduleHtml({ booking, roomUrl, oldWhen: fmtIST(oldScheduled), newWhen: fmtIST(newIso) }),
      from_name: 'Vaani AI Demo'
    }).catch(e => console.error('Reschedule email failed:', e?.message));

    // Notify sales team
    if (booking.cc_sales_emails?.length) {
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: booking.cc_sales_emails,
        subject: `[Demo Rescheduled] ${booking.lead_name || booking.lead_email} — ${booking.booking_code}`,
        html: `<p>${booking.lead_name || booking.lead_email} rescheduled their demo.</p>
               <p><b>Previous:</b> ${fmtIST(oldScheduled)}<br/>
               <b>New:</b> ${fmtIST(newIso)}</p>`,
        from_name: 'Vaani AI'
      }).catch(() => {});
    }

    svc.functions.invoke('notifyDemoAlert', {
      severity: 'info',
      title: 'Demo Rescheduled',
      message: `${booking.lead_name || booking.lead_email}: ${fmtIST(oldScheduled)} → ${fmtIST(newIso)}`,
      booking_id: booking.id
    }).catch(() => {});

    return c.json({ data: {
      success: true,
      booking_code: booking.booking_code,
      old_scheduled_at: oldScheduled,
      new_scheduled_at: newIso
    } });
  } catch (error) {
    console.error('rescheduleDemoBooking error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};