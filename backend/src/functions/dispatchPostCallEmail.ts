import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// dispatchPostCallEmail — Email counterpart of dispatchPostCallWhatsApp
//
// Triggered from postCallActionExtractor after every completed call.
// 1. Loads EmailIntentMapping rows for this call's campaign + lead's groups
// 2. Uses Azure OpenAI to detect which intents the lead requested via EMAIL
//    (e.g. "Can you email me the pricing?" → ["pricing"])
// 3. Also fires outcome-based mappings (interested → pricing, callback → confirm)
// 4. Sends each matching template via sendEmailFromTemplate
//
// Payload: { call_log_id }
// ═══════════════════════════════════════════════════════════════════



async function detectEmailIntents(transcript, availableIntents) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey || !transcript || availableIntents.length === 0) {
    return { send_requested: false, intents: [], email_override: null };
  }
  const intentList = availableIntents.map(i => `- ${i}`).join('\n');
  const res = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: `You detect EMAIL send requests in a sales call transcript.

Available intents the AI agent CAN deliver via EMAIL:
${intentList}

The lead may ask in English, Hindi, or Hinglish (e.g. "email kar dena", "send me on email", "mail karo brochure", "mujhe details mail kar do", "share over email").

Return STRICT JSON: {"send_requested": boolean, "intents": ["<intent_from_list>", ...], "email_override": "<email or null>"}

Rules:
- Only include intents from the available list. NEVER invent new intents.
- "send_requested": true ONLY if the lead clearly asked to receive something on EMAIL specifically (not WhatsApp).
- "email_override": ONLY if the lead specified a different email than what's on file. Else null.
- If the lead asked for "WhatsApp" only → send_requested: false (handled separately).
- If unclear or AI agent offered but lead didn't confirm → send_requested: false.`
        },
        { role: 'user', content: `Transcript:\n\n${transcript.substring(0, 8000)}` }
      ],
      max_completion_tokens: 200,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) return { send_requested: false, intents: [], email_override: null };
  const data = await res.json();
  try {
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return {
      send_requested: !!parsed.send_requested,
      intents: Array.isArray(parsed.intents) ? parsed.intents.filter(i => availableIntents.includes(i)) : [],
      email_override: parsed.email_override || null
    };
  } catch (_) {
    return { send_requested: false, intents: [], email_override: null };
  }
}

// AI picks the best attachments from the client's library based on transcript + intent.
// Returns array of EmailAttachment ids (already in availableLibrary).
async function pickRelevantAttachments({ transcript, intents, availableLibrary }) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey || !transcript || availableLibrary.length === 0) return [];

  const library = availableLibrary.map(a => ({
    id: a.id,
    name: a.name,
    category: a.category || 'other',
    description: (a.description || '').substring(0, 300)
  }));

  const res = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: `You pick the most relevant files to email a lead after a sales call.

Available file library (id, name, category, description):
${JSON.stringify(library, null, 2)}

Detected intents the lead expressed: ${intents.join(', ') || '(none)'}

Return STRICT JSON: {"attachment_ids": ["<id>", ...]}

Rules:
- ONLY include ids from the library above. NEVER invent new ids.
- Pick files whose DESCRIPTION or NAME clearly matches what the lead asked for in the transcript.
- Prefer 1-3 files. Quality over quantity. If nothing clearly matches, return empty array.
- Match Hindi/Hinglish phrasing too (e.g. "site visit checklist" → file described as visit checklist).`
        },
        { role: 'user', content: `Transcript:\n\n${transcript.substring(0, 6000)}` }
      ],
      max_completion_tokens: 200,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) return [];
  try {
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const validIds = new Set(availableLibrary.map(a => a.id));
    return Array.isArray(parsed.attachment_ids)
      ? parsed.attachment_ids.filter(id => validIds.has(id))
      : [];
  } catch (_) {
    return [];
  }
}

export default async function dispatchPostCallEmail(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const svc = client.asServiceRole;
    const { call_log_id } = await c.req.json();
    if (!call_log_id) return c.json({ data: { error: 'call_log_id required' } }, 400);

    const callLog = await svc.entities.CallLog.get(call_log_id).catch(() => null);
    if (!callLog || !callLog.lead_id || !callLog.client_id) {
      return c.json({ data: { skipped: true, reason: 'Missing CallLog data' } });
    }

    const lead = await svc.entities.Lead.get(callLog.lead_id).catch(() => null);
    if (!lead) return c.json({ data: { skipped: true, reason: 'Lead not found' } });

    // Find campaign context
    const campaignLeads = await svc.entities.CampaignLead.filter({ call_log_id });
    const cLead = campaignLeads[0] || null;
    const campaignId = cLead?.campaign_id || null;
    const outcome = cLead?.outcome || callLog.lead_status_updated || '';

    // Collect mappings from both campaign + lead's groups
    const groupIds = Array.isArray(lead.group_ids) ? lead.group_ids : [];
    const [campMappings, groupMappingsArr] = await Promise.all([
      campaignId ? svc.entities.EmailIntentMapping.filter({ campaign_id: campaignId }).catch(() => []) : Promise.resolve([]),
      groupIds.length > 0
        ? Promise.all(groupIds.map(gid => svc.entities.EmailIntentMapping.filter({ group_id: gid }).catch(() => [])))
        : Promise.resolve([])
    ]);
    const allMappings = [...campMappings, ...groupMappingsArr.flat()];
    const seen = new Set();
    const enabledMappings = allMappings.filter(m => {
      if (!m || m.enabled === false || !m.template_id) return false;
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    if (enabledMappings.length === 0) {
      return c.json({ data: { skipped: true, reason: 'No email mappings configured' } });
    }

    const intentsToFire = new Set();

    // 1. AI-detected intents
    const aiMappings = enabledMappings.filter(m => m.trigger_condition === 'ai_requested' || !m.trigger_condition);
    const availableIntents = [...new Set(aiMappings.map(m => m.intent))];
    if (availableIntents.length > 0 && callLog.transcript && callLog.transcript.length > 100) {
      const detected = await detectEmailIntents(callLog.transcript, availableIntents);
      if (detected.send_requested) {
        detected.intents.forEach(i => intentsToFire.add(JSON.stringify({ intent: i, email: detected.email_override })));
      }
    }

    // 2. Outcome-based
    const outcomeMap = {
      'interested': 'outcome_interested',
      'callback': 'outcome_callback',
      'converted': 'outcome_converted'
    };
    const outcomeTrigger = outcomeMap[outcome];
    enabledMappings.forEach(m => {
      if (m.trigger_condition === 'always' || (outcomeTrigger && m.trigger_condition === outcomeTrigger)) {
        intentsToFire.add(JSON.stringify({ intent: m.intent, email: null }));
      }
    });

    if (intentsToFire.size === 0) {
      return c.json({ data: { success: true, sent: 0, reason: 'No intents matched' } });
    }

    // ── AI auto-pick attachments from client's full library ──
    // Reads EmailAttachment.description for every enabled file the client has,
    // and picks the ones that match the transcript.
    let aiPickedAttachmentIds = [];
    if (callLog.transcript && callLog.transcript.length > 100) {
      const library = await svc.entities.EmailAttachment.filter({
        client_id: callLog.client_id, enabled: true
      }).catch(() => []);
      if (library.length > 0) {
        const intentList = Array.from(intentsToFire).map(i => JSON.parse(i).intent);
        aiPickedAttachmentIds = await pickRelevantAttachments({
          transcript: callLog.transcript,
          intents: intentList,
          availableLibrary: library
        });
        if (aiPickedAttachmentIds.length > 0) {
          console.log(`[dispatchPostCallEmail] AI auto-picked ${aiPickedAttachmentIds.length} attachments from library`);
        }
      }
    }

    const sent = [], failed = [];
    for (const item of intentsToFire) {
      const { intent, email } = JSON.parse(item);
      const mapping = enabledMappings.find(m => m.intent === intent);
      if (!mapping) continue;

      const recipientEmail = email || lead.email;
      if (!recipientEmail) {
        failed.push({ intent, error: 'No email address' });
        continue;
      }

      // Merge: mapping's configured extras + AI-picked from library (dedupe)
      const mergedExtras = [...new Set([
        ...(mapping.extra_attachment_ids || []),
        ...aiPickedAttachmentIds
      ])];

      try {
        const r = await svc.functions.invoke('sendEmailFromTemplate', {
          client_id: callLog.client_id,
          template_id: mapping.template_id,
          to_email: recipientEmail,
          lead_id: callLog.lead_id,
          call_log_id,
          extra_attachment_ids: mergedExtras,
          outreach_type: 'lead_followup'
        });
        if (r?.data?.success) sent.push({ intent, to: recipientEmail, attachments: mergedExtras.length });
        else failed.push({ intent, error: r?.data?.error || 'send failed' });
      } catch (e) {
        failed.push({ intent, error: e.message });
      }
    }

    console.log(`[dispatchPostCallEmail] call=${call_log_id} sent=${sent.length} failed=${failed.length}`);
    return c.json({ data: { success: true, sent: sent.length, failed: failed.length, details: { sent, failed } } });
  } catch (error) {
    console.error('[dispatchPostCallEmail] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};