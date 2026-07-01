import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Tool function callable by the AI mid-call (or any backend) to book a demo
// directly during a sales conversation.
//
// Inputs:
//   lead_id (optional) — link the booking to an existing Lead
//   lead_name, lead_email, lead_phone, company_name (required if no lead_id)
//   scheduled_at (ISO 8601)
//   focus_area, language, duration_minutes
//
// Returns the booking + room URL.



export default async function bookDemoFromCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const body = await c.req.json();

    let { lead_id, lead_name, lead_email, lead_phone, company_name, industry, team_size,
          focus_area, language = 'bilingual', scheduled_at, duration_minutes = 30 } = body;

    // If lead_id provided, hydrate missing fields from the Lead record
    if (lead_id) {
      const lead = await svc.entities.Lead.get(lead_id).catch(() => null);
      if (lead) {
        lead_name = lead_name || lead.name;
        lead_email = lead_email || lead.email;
        lead_phone = lead_phone || lead.phone;
        company_name = company_name || lead.company;
      }
    }

    if (!lead_email || !scheduled_at) {
      return c.json({ data: { error: 'lead_email and scheduled_at required' } }, 400);
    }

    // Delegate to the existing createDemoBooking function (handles slot check, room token, emails)
    const res = await svc.functions.invoke('createDemoBooking', {
      lead_id: lead_id || '',
      lead_name, lead_email, lead_phone, company_name, industry, team_size,
      focus_area, language, scheduled_at, duration_minutes,
      source: 'voice_agent'
    });

    if (res?.data?.error) {
      return c.json({ data: { error: res.data.error } }, res.status || 400);
    }

    return c.json({ data: { success: true, ...(res?.data || {}) } });
  } catch (error) {
    console.error('bookDemoFromCall error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};