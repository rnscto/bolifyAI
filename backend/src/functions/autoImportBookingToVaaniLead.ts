import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Entity automation: triggered when a new DemoBooking is created.
// Auto-creates a corresponding Lead in the Vaani Internal Sales tenant
// so every demo request becomes a trackable lead in the sales pipeline.



const TENANT_NAME = 'Vaani Internal Sales';

export default async function autoImportBookingToVaaniLead(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const body = await c.req.json().catch(() => ({}));

    const event = body.event || {};
    const bookingId = event.entity_id;
    if (!bookingId) return c.json({ data: { skipped: 'no booking_id' } });

    const booking = body.data || await svc.entities.DemoBooking.get(bookingId).catch(() => null);
    if (!booking?.lead_email) return c.json({ data: { skipped: 'no email' } });

    // Find Vaani tenant
    const clients = await svc.entities.Client.filter({ company_name: TENANT_NAME });
    if (!clients.length) return c.json({ data: { skipped: 'vaani tenant not set up' } });
    const clientId = clients[0].id;

    // Skip if a lead with this email already exists
    const existing = await svc.entities.Lead.filter({ client_id: clientId, email: booking.lead_email });
    if (existing.length > 0) {
      // Link booking to the existing lead if not already
      if (!booking.lead_id) {
        await svc.entities.DemoBooking.update(bookingId, { lead_id: existing[0].id }).catch(() => {});
      }
      return c.json({ data: { skipped: 'lead exists', lead_id: existing[0].id } });
    }

    // Find the Website Demo Requests group
    const groups = await svc.entities.LeadGroup.filter({ client_id: clientId, name: 'Website Demo Requests' });
    const groupIds = groups.length ? [groups[0].id] : [];

    const newLead = await svc.entities.Lead.create({
      client_id: clientId,
      name: booking.lead_name || booking.lead_email.split('@')[0],
      email: booking.lead_email,
      phone: booking.lead_phone || '',
      company: booking.company_name || '',
      source: 'demo_booking',
      status: 'new',
      group_ids: groupIds,
      notes: `Auto-created from demo booking ${booking.booking_code || bookingId}. Focus: ${booking.focus_area || '—'}`
    });

    // Link booking to new lead
    await svc.entities.DemoBooking.update(bookingId, { lead_id: newLead.id }).catch(() => {});

    return c.json({ data: { success: true, lead_id: newLead.id } });
  } catch (error) {
    console.error('autoImportBookingToVaaniLead error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};