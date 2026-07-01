import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public endpoint: record the lead's recording consent from the DemoRoom page,
// or capture a human-handoff request mid-demo.
// POST { room_token, action: 'recording_consent' | 'human_handoff' }



export default async function recordDemoConsent(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Public endpoint — gated by secret room_token.
    const svc = base44;;
    const { room_token, action } = await c.req.json();
    if (!room_token || !action) return c.json({ data: { error: 'room_token and action required' } }, 400);

    const matches = await svc.entities.DemoBooking.filter({ room_token });
    if (!matches.length) return c.json({ data: { error: 'Booking not found' } }, 404);
    const booking = matches[0];

    if (action === 'recording_consent') {
      await svc.entities.DemoBooking.update(booking.id, {
        recording_consent: true, recording_consent_at: new Date().toISOString()
      });
      return c.json({ data: { success: true } });
    }

    if (action === 'human_handoff') {
      await svc.entities.DemoBooking.update(booking.id, {
        human_handoff_requested: true, human_handoff_at: new Date().toISOString(),
        outcome: 'needs_human'
      });
      // Alert sales
      svc.functions.invoke('notifyDemoAlert', {
        severity: 'critical',
        title: '🙋 Demo Lead Wants HUMAN NOW',
        message: `${booking.lead_name || booking.lead_email}${booking.company_name ? ` (${booking.company_name})` : ''} clicked "Talk to Human" during their demo.\nPhone: ${booking.lead_phone || '—'}\nFocus: ${booking.focus_area || '—'}`,
        booking_id: booking.id
      }).catch(() => {});
      if (booking.cc_sales_emails?.length) {
        svc.functions.invoke('sendAcsSmtpEmail', {
          to: booking.cc_sales_emails,
          subject: `🚨 [URGENT] Demo lead asking for HUMAN — ${booking.lead_name || booking.lead_email}`,
          html: `<p><b>${booking.lead_name || booking.lead_email}</b> clicked "Talk to Human" during their live demo.</p>
                 <p>Phone: ${booking.lead_phone || '—'}</p>
                 <p>Email: ${booking.lead_email}</p>
                 <p>Company: ${booking.company_name || '—'}</p>
                 <p>Focus: ${booking.focus_area || '—'}</p>
                 <p><b>Please reach out NOW.</b></p>`,
          from_name: 'Vaani AI'
        }).catch(() => {});
      }
      return c.json({ data: { success: true } });
    }

    return c.json({ data: { error: 'Unknown action' } }, 400);
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};