import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Fires when a new Lead is created (via Base44 entity automation).
// If the lead belongs to any LeadGroup with auto_trigger_enabled = true:
//   1. Send WhatsApp template immediately (via sendWhatsAppTemplate)
//   2. Schedule an AI call by setting Lead.auto_call_scheduled_at = now + delay
//      → processAutoTriggerCalls (scheduled every 5 min) will place the call when due.
//
// Triggered by entity automation: Lead create event.
// Payload: { event: { type, entity_name, entity_id }, data: <Lead> }



export default async function onNewLeadAutoTrigger(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const lead = body?.data;

    if (!lead || !lead.id) {
      return c.json({ data: { skipped: 'no lead data in payload' } });
    }
    if (!Array.isArray(lead.group_ids) || lead.group_ids.length === 0) {
      return c.json({ data: { skipped: 'lead has no group_ids' } });
    }
    if (!lead.phone) {
      return c.json({ data: { skipped: 'lead has no phone' } });
    }

    // Find first group with auto-trigger enabled
    const groups = await Promise.all(
      lead.group_ids.map(gid => base44.asServiceRole.entities.LeadGroup.get(gid).catch(() => null))
    );
    const triggerGroup = groups.find(g => g && g.auto_trigger_enabled && g.client_id === lead.client_id);
    if (!triggerGroup) {
      return c.json({ data: { skipped: 'no group has auto_trigger_enabled' } });
    }

    console.log(`[onNewLeadAutoTrigger] Lead ${lead.id} matched group "${triggerGroup.name}" — firing auto-trigger`);

    const actions = [];

    // ── 1. Send WhatsApp immediately ──
    if (triggerGroup.auto_trigger_whatsapp_template_id) {
      try {
        // Resolve template variables. Group-configured values support
        // {{name}}/{{company}}/{{phone}}/{{email}} placeholders. If the group
        // left the variables empty but the template expects placeholders, the
        // send would fail with "needs N variable(s) but got 0", so we fetch the
        // template and auto-fill missing slots with the lead's name as a sane
        // default (these greeting templates almost always start with "Hi {{1}}").
        const resolvePlaceholders = (v) => String(v ?? '')
          .replace(/\{\{name\}\}/g, lead.name || 'there')
          .replace(/\{\{company\}\}/g, lead.company || '')
          .replace(/\{\{phone\}\}/g, lead.phone || '')
          .replace(/\{\{email\}\}/g, lead.email || '');

        let variables = (triggerGroup.auto_trigger_whatsapp_variables || []).map(resolvePlaceholders);

        const tmpl = await base44.asServiceRole.entities.MessageTemplate
          .get(triggerGroup.auto_trigger_whatsapp_template_id).catch(() => null);
        const needed = tmpl?.body ? (tmpl.body.match(/\{\{\s*\d+\s*\}\}/g) || []).length : 0;
        if (needed > variables.length) {
          // Fill the first missing slot with the lead name, the rest with blanks.
          while (variables.length < needed) {
            variables.push(variables.length === 0 ? (lead.name || 'there') : '');
          }
        }

        const waRes = await base44.asServiceRole.functions.invoke('sendWhatsAppTemplate', {
          client_id: lead.client_id,
          template_id: triggerGroup.auto_trigger_whatsapp_template_id,
          to: lead.phone,
          variables,
          lead_id: lead.id,
          outreach_type: 'lead_followup'
        });
        if (waRes?.data?.success) {
          actions.push('whatsapp_sent');
          console.log(`[onNewLeadAutoTrigger] WhatsApp sent for lead ${lead.id}`);
        } else {
          actions.push(`whatsapp_failed:${waRes?.data?.error || 'unknown'}`);
        }
      } catch (e) {
        actions.push(`whatsapp_error:${e.message}`);
      }
    }

    // ── 2. Schedule AI call (delay in minutes) ──
    const updatePatch = {
      auto_actions_taken: [...(lead.auto_actions_taken || []), ...actions]
    };
    if (triggerGroup.auto_trigger_agent_id) {
      const delayMin = Number(triggerGroup.auto_trigger_call_delay_minutes) || 5;
      const scheduledAt = new Date(Date.now() + delayMin * 60_000).toISOString();
      updatePatch.auto_call_scheduled_at = scheduledAt;
      updatePatch.auto_call_agent_id = triggerGroup.auto_trigger_agent_id;
      updatePatch.auto_call_group_id = triggerGroup.id;
      updatePatch.auto_actions_taken.push(`call_scheduled:${scheduledAt}`);
      console.log(`[onNewLeadAutoTrigger] Call scheduled for lead ${lead.id} at ${scheduledAt}`);
    }

    await base44.asServiceRole.entities.Lead.update(lead.id, updatePatch);

    return c.json({ data: { success: true, actions, group: triggerGroup.name } });
  } catch (error) {
    console.error('[onNewLeadAutoTrigger] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};