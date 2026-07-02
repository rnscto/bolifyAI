import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";
// dispatchPostCallWhatsApp
// ────────────────────────────────────────────────────────────────────────────
// Hybrid post-call WhatsApp dispatcher (Option C from the architecture plan).
//
// Triggered from postCallActionExtractor after every campaign call.
// 1. Loads the campaign's CampaignTemplateMapping rows
// 2. Uses Azure OpenAI (GPT) to detect which intents the lead requested in the
//    transcript (e.g. "WhatsApp pe pricing bhej do" → ["pricing"])
// 3. Also fires outcome-based mappings (interested → pricing, callback → confirm)
// 4. Sends each matching approved template via sendWhatsAppTemplate
//
// Payload: { call_log_id }
// ────────────────────────────────────────────────────────────────────────────



function resolveVariables(mappingValues, lead, campaign) {
  return (mappingValues || []).map(v => {
    if (!v) return '';
    return String(v)
      .replace(/\{\{name\}\}/g, lead?.name || '')
      .replace(/\{\{company\}\}/g, lead?.company || '')
      .replace(/\{\{phone\}\}/g, lead?.phone || '')
      .replace(/\{\{email\}\}/g, lead?.email || '')
      .replace(/\{\{campaign_name\}\}/g, campaign?.name || '');
  });
}

async function detectIntents(transcript, availableIntents) {
        if (!baseUrl || !deployment || !apiKey || !transcript || availableIntents.length === 0) {
    return { send_requested: false, intents: [], phone_override: null };
  }

  const intentList = availableIntents.map(i => `- ${i}`).join('\n');
  const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: `You detect WhatsApp send requests in a sales call transcript.

Available intents the AI agent CAN deliver via WhatsApp:
${intentList}

The lead may ask in English, Hindi, or Hinglish (e.g. "WhatsApp pe details bhej do", "send me pricing on whatsapp", "brochure share kar do", "location share karo").

Return STRICT JSON: {"send_requested": boolean, "intents": ["<intent_from_list>", ...], "phone_override": "<E.164 phone or null>"}

Rules:
- Only include intents from the available list above. NEVER invent new intents.
- "send_requested": true ONLY if the lead clearly asked to receive something on WhatsApp (or text message).
- "intents": the topics they asked for, mapped to the closest available intent.
- "phone_override": ONLY if the lead specified a different phone number than the one they're calling from. Otherwise null.
- If unclear or the AI agent offered but the lead didn't confirm → send_requested: false.`
        },
        { role: 'user', content: `Transcript:\n\n${transcript.substring(0, 8000)}` }
      ],
      max_completion_tokens: 200,
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) return { send_requested: false, intents: [], phone_override: null };
  const data = await res.json();
  try {
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return {
      send_requested: !!parsed.send_requested,
      intents: Array.isArray(parsed.intents) ? parsed.intents.filter(i => availableIntents.includes(i)) : [],
      phone_override: parsed.phone_override || null
    };
  } catch (_) {
    return { send_requested: false, intents: [], phone_override: null };
  }
}

export default async function dispatchPostCallWhatsApp(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const svc = client.asServiceRole;
    const { call_log_id } = await c.req.json();
    if (!call_log_id) return c.json({ data: { error: 'call_log_id required' } }, 400);

    const callLog = await svc.entities.CallLog.get(call_log_id).catch(() => null);
    if (!callLog) return c.json({ data: { skipped: true, reason: 'CallLog not found' } });
    if (!callLog.lead_id || !callLog.client_id) {
      return c.json({ data: { skipped: true, reason: 'Missing lead_id or client_id' } });
    }

    // Try to find an active CampaignLead for this call (campaign-scoped context)
    const campaignLeads = await svc.entities.CampaignLead.filter({ call_log_id });
    const cLead = campaignLeads[0] || null;
    const campaignId = cLead?.campaign_id || null;
    const outcome = cLead?.outcome || callLog.lead_status_updated || '';

    // Load lead first — needed to resolve group mappings
    const lead = await svc.entities.Lead.get(callLog.lead_id).catch(() => null);
    if (!lead) return c.json({ data: { skipped: true, reason: 'Lead not found' } });

    // Collect mappings from BOTH scopes (campaign + lead's groups)
    const groupIds = Array.isArray(lead.group_ids) ? lead.group_ids : [];
    const [campaignMappings, groupMappingArrays, campaign] = await Promise.all([
      campaignId
        ? svc.entities.CampaignTemplateMapping.filter({ campaign_id: campaignId }).catch(() => [])
        : Promise.resolve([]),
      groupIds.length > 0
        ? Promise.all(groupIds.map(gid =>
            svc.entities.CampaignTemplateMapping.filter({ group_id: gid }).catch(() => [])
          ))
        : Promise.resolve([]),
      campaignId ? svc.entities.Campaign.get(campaignId).catch(() => null) : Promise.resolve(null)
    ]);

    let allMappings = [
      ...campaignMappings,
      ...groupMappingArrays.flat()
    ];

    // Fallback for standalone calls (no campaign + lead not in any mapped group):
    // use the client's own mappings so "send me on WhatsApp" still works.
    if (allMappings.length === 0) {
      allMappings = await svc.entities.CampaignTemplateMapping
        .filter({ client_id: callLog.client_id })
        .catch(() => []);
    }

    // Dedupe by id (a mapping can only exist once)
    const seenIds = new Set();
    const enabledMappings = allMappings.filter(m => {
      if (!m || m.enabled === false || !m.template_id) return false;
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    });

    if (enabledMappings.length === 0) {
      return c.json({ data: { skipped: true, reason: 'No template mappings (campaign, group, or client) configured' } });
    }

    const intentsToFire = new Set();

    // 1. AI-detected intents from transcript
    const aiMappings = enabledMappings.filter(m => m.trigger_condition === 'ai_requested' || !m.trigger_condition);
    const availableIntents = [...new Set(aiMappings.map(m => m.intent))];
    if (availableIntents.length > 0 && callLog.transcript && callLog.transcript.length > 100) {
      const detected = await detectIntents(callLog.transcript, availableIntents);
      if (detected.send_requested) {
        detected.intents.forEach(i => intentsToFire.add(JSON.stringify({ intent: i, source: 'ai', phone: detected.phone_override })));
      }
    }

    // 2. Outcome-based intents
    const outcomeMap = {
      'interested': 'outcome_interested',
      'callback': 'outcome_callback',
      'converted': 'outcome_converted'
    };
    const outcomeTrigger = outcomeMap[outcome];
    enabledMappings.forEach(m => {
      if (m.trigger_condition === 'always' || (outcomeTrigger && m.trigger_condition === outcomeTrigger)) {
        intentsToFire.add(JSON.stringify({ intent: m.intent, source: 'outcome', phone: null }));
      }
    });

    if (intentsToFire.size === 0) {
      return c.json({ data: { success: true, sent: 0, reason: 'No intents matched' } });
    }

    const sent = [];
    const failed = [];
    for (const item of intentsToFire) {
      const { intent, phone } = JSON.parse(item);
      const mapping = enabledMappings.find(m => m.intent === intent);
      if (!mapping) continue;

      const variables = resolveVariables(mapping.variable_mapping, lead, campaign);
      const recipientPhone = phone || lead.phone;
      if (!recipientPhone) {
        failed.push({ intent, error: 'No phone number' });
        continue;
      }

      try {
        const response = await svc.functions.invoke('sendWhatsAppTemplate', {
          client_id: callLog.client_id,
          template_id: mapping.template_id,
          to: recipientPhone,
          variables,
          lead_id: callLog.lead_id,
          call_log_id,
          outreach_type: 'lead_followup'
        });
        const result = response?.data || {};
        if (result?.success) {
          sent.push({ intent, message_id: result.message_id });
        } else {
          failed.push({ intent, error: result?.error || 'invoke failed' });
        }
      } catch (e) {
        failed.push({ intent, error: e.message });
      }
    }

    console.log(`[dispatchPostCallWhatsApp] call=${call_log_id} sent=${sent.length} failed=${failed.length}`);
    return c.json({ data: { success: true, sent: sent.length, failed: failed.length, details: { sent, failed } } });
  } catch (error) {
    console.error('[dispatchPostCallWhatsApp] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};