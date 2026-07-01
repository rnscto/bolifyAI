import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public endpoint called by the website lead-capture forms (e.g. /get-started).
// Uses service role so unauthenticated visitors land in the right Vaani tenant
// with the correct group + an IMMEDIATE call (no automation, no scheduler).
//
// Flow:
//   1. Resolve Vaani Internal Sales tenant (by company_name)
//   2. Resolve "Website Form Leads" group
//   3. Dedup by phone within that tenant
//   4. Create the Lead with correct client_id + group_ids
//   5. Fire initiateCall immediately (fire-and-forget) using the group's
//      auto_trigger_agent_id



const TENANT_NAME = 'Vaani Internal Sales';
const WEBSITE_GROUP_NAME = 'Website Form Leads';

export default async function captureWebsiteLead(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));
    const {
      name, email, phone, company, solution, industry,
      source, notes, tags = [], whatsappOptIn,
      landing_url, user_agent, affiliate_ref
    } = body || {};

    if (!email && !phone) {
      return c.json({ data: { success: false, error: 'Email or phone required' } }, 400);
    }

    // 1. Resolve tenant
    const clients = await svc.entities.Client.filter({ company_name: TENANT_NAME }, '-created_date', 1);
    if (!clients.length) {
      console.error('[captureWebsiteLead] Vaani tenant not found');
      return c.json({ data: { success: false, error: 'Tenant not configured' } }, 500);
    }
    const clientId = clients[0].id;

    // 2. Resolve group
    const groups = await svc.entities.LeadGroup.filter(
      { client_id: clientId, name: WEBSITE_GROUP_NAME }, '-created_date', 1
    );
    const websiteGroup = groups[0] || null;
    const groupIds = websiteGroup ? [websiteGroup.id] : [];

    // 3. Dedup by phone (last 10 digits) — query directly instead of scanning
    // up to 500 records (that heavy read intermittently trips the API rate
    // limit and aborts the whole capture before the lead is ever saved).
    const phoneClean = String(phone || '').replace(/[^0-9]/g, '');
    // Store in normalized last-10 form so dedup matches across all entry points
    const phoneLast10 = phoneClean.length > 10 ? phoneClean.slice(-10) : phoneClean;
    let existing = null;
    if (phoneLast10.length === 10) {
      try {
        // Match on the exact stored phone first (covers the common case)
        const byExact = await svc.entities.Lead.filter(
          { client_id: clientId, phone: phoneClean }, '-created_date', 5
        );
        existing = byExact[0] || null;
        // Fallback: also try matching the bare last-10 form
        if (!existing && phoneClean !== phoneLast10) {
          const byLast10 = await svc.entities.Lead.filter(
            { client_id: clientId, phone: phoneLast10 }, '-created_date', 5
          );
          existing = byLast10[0] || null;
        }
      } catch (dedupErr) {
        // Never let dedup failure block lead creation — just create a new lead.
        console.warn('[captureWebsiteLead] dedup lookup failed, creating new:', dedupErr?.message);
      }
    }

    let lead;
    if (existing) {
      // Update existing — refresh fields, ensure group membership
      const mergedGroups = Array.from(new Set([...(existing.group_ids || []), ...groupIds]));
      lead = await svc.entities.Lead.update(existing.id, {
        name: name || existing.name,
        email: email || existing.email,
        company: company || existing.company,
        source: source || existing.source || 'website',
        group_ids: mergedGroups,
        last_engagement_date: new Date().toISOString(),
        engagement_count: (existing.engagement_count || 0) + 1
      });
      console.log(`[captureWebsiteLead] Updated existing lead ${lead.id}`);
    } else {
      lead = await svc.entities.Lead.create({
        client_id: clientId,
        name: name || (email ? email.split('@')[0] : 'Website Visitor'),
        email: email || undefined,
        phone: phoneClean || '',
        company: company || '',
        status: 'new',
        source: source || 'website',
        group_ids: groupIds,
        notes: [
          solution ? `Looking for: ${solution}` : null,
          industry ? `Industry: ${industry}` : null,
          whatsappOptIn ? `WhatsApp opt-in: yes` : null,
          affiliate_ref ? `Affiliate ref: ${affiliate_ref}` : null,
          notes || null
        ].filter(Boolean).join('\n'),
        tags: [
          source || 'website',
          ...(whatsappOptIn ? ['whatsapp_optin'] : []),
          ...(tags || [])
        ],
        custom_fields: {
          captured_at: new Date().toISOString(),
          landing_url: landing_url || '',
          user_agent: user_agent || '',
          solution: solution || '',
          industry: industry || ''
        }
      });
      console.log(`[captureWebsiteLead] Created lead ${lead.id} in tenant ${clientId}`);
    }

    // 4. Fire immediate AI call (fire-and-forget) using group's configured agent
    let callFired = false;
    if (websiteGroup?.auto_trigger_agent_id && phoneClean) {
      try {
        // Fire-and-forget — don't await the call itself, just kick it off
        svc.functions.invoke('initiateCall', {
          lead_id: lead.id,
          agent_id: websiteGroup.auto_trigger_agent_id,
          phone_number: phoneClean,
          service_call: true
        }).then(() => {
          console.log(`[captureWebsiteLead] Call fired for lead ${lead.id}`);
        }).catch(err => {
          console.error(`[captureWebsiteLead] Call invoke failed for ${lead.id}:`, err?.message);
        });

        // Mark on the lead so we have an audit trail
        await svc.entities.Lead.update(lead.id, {
          auto_actions_taken: [
            ...(lead.auto_actions_taken || []),
            `call_fired:${new Date().toISOString()}`
          ],
          auto_call_agent_id: websiteGroup.auto_trigger_agent_id,
          auto_call_group_id: websiteGroup.id
        }).catch(() => {});
        callFired = true;
      } catch (e) {
        console.error(`[captureWebsiteLead] Call fire error:`, e?.message);
      }
    } else {
      console.log(`[captureWebsiteLead] Skipped call — no agent on group or no phone`);
    }

    return c.json({ data: {
      success: true,
      leadId: lead.id,
      client_id: clientId,
      group_id: websiteGroup?.id || null,
      call_fired: callFired
    } });
  } catch (error) {
    console.error('[captureWebsiteLead] error:', error);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};