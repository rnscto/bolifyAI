import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public endpoint: cancel a demo booking via the cancel_token from the invite email.
// POST { cancel_token, reason? }



export default async function cancelDemoBooking(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Public endpoint — gated by secret cancel_token (knowledge of token = authorization).
    const svc = base44;;
    const { cancel_token, reason = '' } = await c.req.json();
    if (!cancel_token) return c.json({ data: { error: 'cancel_token required' } }, 400);

    const matches = await svc.entities.DemoBooking.filter({ cancel_token });
    if (!matches.length) return c.json({ data: { error: 'Invalid cancel link' } }, 404);
    const booking = matches[0];

    if (['cancelled', 'completed', 'no_show', 'expired'].includes(booking.status)) {
      return c.json({ data: { success: true, already: booking.status } });
    }

    await svc.entities.DemoBooking.update(booking.id, {
      status: 'cancelled',
      notes: (booking.notes ? booking.notes + '\n' : '') + `Cancelled by lead: ${reason || 'no reason given'}`
    });

    // Notify sales team
    if (booking.cc_sales_emails?.length) {
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: booking.cc_sales_emails,
        subject: `[Demo Cancelled] ${booking.lead_name || booking.lead_email} — ${booking.booking_code}`,
        html: `<p>${booking.lead_name || booking.lead_email} cancelled their demo scheduled for ${new Date(booking.scheduled_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.</p>${reason ? `<p><b>Reason:</b> ${reason}</p>` : ''}`,
        from_name: 'Vaani AI'
      }).catch(() => {});
    }

    svc.functions.invoke('notifyDemoAlert', {
      severity: 'info',
      title: 'Demo Cancelled',
      message: `${booking.lead_name || booking.lead_email} cancelled. Reason: ${reason || '—'}`,
      booking_id: booking.id
    }).catch(() => {});

    return c.json({ data: { success: true, booking_code: booking.booking_code } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};