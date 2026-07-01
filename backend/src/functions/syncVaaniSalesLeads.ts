import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Pulls leads into the Vaani Internal Sales tenant from:
//   1. DemoBooking records (website demo requests)
//   2. WebsiteLead entity (Home page form submissions)
//
// Idempotent — uses email as the dedup key. Safe to run repeatedly.
// Admin-only endpoint. Returns counts of new leads added per source.



const TENANT_NAME = 'Vaani Internal Sales';

export default async function syncVaaniSalesLeads(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;

    // Auth: cron key (via ?key= or x-cron-key header) OR admin user
    const url = new URL(req.url);
    const cronKey = url.searchParams.get('key') || req.headers.get('x-cron-key') || '';
    const expectedKey = Deno.env.get('CRON_API_KEY') || '';
    const isCron = !!expectedKey && cronKey === expectedKey;

    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user || user.role !== 'admin') {
        return c.json({ data: { error: 'Forbidden', hint: 'pass ?key=CRON_API_KEY or be admin' } }, 403);
      }
    }

    const svc = base44.asServiceRole;

    // Locate Vaani tenant
    const clients = await svc.entities.Client.filter({ company_name: TENANT_NAME });
    if (!clients.length) {
      return c.json({ data: { error: 'Vaani Internal tenant not set up. Run setupVaaniInternalTenant first.' } }, 400);
    }
    const client = clients[0];
    const clientId = client.id;

    // Group IDs
    const demoGroup = (await svc.entities.LeadGroup.filter({ client_id: clientId, name: 'Website Demo Requests' }))[0];
    const websiteGroup = (await svc.entities.LeadGroup.filter({ client_id: clientId, name: 'Website Form Leads' }))[0];

    // Existing leads — index by email
    const existing = await svc.entities.Lead.filter({ client_id: clientId });
    const existingEmails = new Set(existing.map(l => (l.email || '').toLowerCase()).filter(Boolean));

    let demoCount = 0;
    let websiteCount = 0;

    // 1. Pull DemoBookings without a linked lead (or whose email isn't in the tenant yet)
    const bookings = await svc.entities.DemoBooking.list('-created_date', 500);
    for (const b of bookings) {
      const email = (b.lead_email || '').toLowerCase();
      if (!email || existingEmails.has(email)) continue;

      const newLead = await svc.entities.Lead.create({
        client_id: clientId,
        name: b.lead_name || email.split('@')[0],
        email: b.lead_email,
        phone: b.lead_phone || '',
        company: b.company_name || '',
        source: 'demo_booking',
        status: b.status === 'completed' ? 'qualified' : 'new',
        group_ids: demoGroup ? [demoGroup.id] : [],
        notes: `Auto-imported from demo booking ${b.booking_code || b.id}. Focus: ${b.focus_area || '—'}`
      }).catch(e => { console.error('Lead create failed', e?.message); return null; });

      if (newLead) {
        existingEmails.add(email);
        demoCount++;
        // Backfill lead_id on the booking
        await svc.entities.DemoBooking.update(b.id, { lead_id: newLead.id }).catch(() => {});
      }
    }

    // 2. Backfill orphan website leads — created with placeholder client_ids before
    //    setup, or from older lead-capture code paths.
    const orphanClientIds = ['website_visitor', 'vaani_internal_pending'];
    for (const placeholderId of orphanClientIds) {
      try {
        const orphans = await svc.entities.Lead.filter({ client_id: placeholderId }, '-created_date', 500);
        for (const w of orphans) {
          const email = (w.email || '').toLowerCase();
          if (email && existingEmails.has(email)) continue;

          const updated = await svc.entities.Lead.update(w.id, {
            client_id: clientId,
            source: w.source || 'website',
            group_ids: websiteGroup ? [...(w.group_ids || []), websiteGroup.id] : (w.group_ids || [])
          }).catch(e => { console.error('Lead reassign failed', e?.message); return null; });

          if (updated) {
            if (email) existingEmails.add(email);
            websiteCount++;
          }
        }
      } catch (e) {
        console.log(`Website lead reassignment error (${placeholderId}):`, e?.message);
      }
    }

    // 3. Auto-assign any existing leads already in the Vaani tenant that came from
    //    website sources but are missing the website group.
    if (websiteGroup) {
      const websiteSources = ['website', 'exit_intent', 'sticky_bar', 'roi_calculator', 'hero_form', 'lead_capture', 'website_voice_agent', 'quick_lead', 'pricing_calculator'];
      const inTenant = existing.filter(l =>
        websiteSources.includes(l.source) &&
        !(l.group_ids || []).includes(websiteGroup.id)
      );
      for (const l of inTenant) {
        await svc.entities.Lead.update(l.id, {
          group_ids: [...(l.group_ids || []), websiteGroup.id]
        }).catch(() => {});
      }
    }

    return c.json({ data: {
      success: true,
      client_id: clientId,
      imported: { demo_bookings: demoCount, website_leads: websiteCount },
      total_leads: existingEmails.size
    } });
  } catch (error) {
    console.error('syncVaaniSalesLeads error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};