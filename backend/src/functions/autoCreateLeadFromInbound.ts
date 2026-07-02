import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";


// Auto-creates a Lead record from an inbound call to an unknown number.
// Extracts name/email/company/intent from the transcript via Azure OpenAI.
// Triggered by smartfloWebhook after an inbound call completes with transcript
// and no existing lead_id.

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

async function azureLLM(prompt, jsonSchema) {
          const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'Extract structured lead data from a call transcript. Respond in valid JSON only.' },
        { role: 'user', content: prompt + '\n\nRespond in JSON matching: ' + JSON.stringify(jsonSchema) }
      ],
      max_completion_tokens: 600,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function notifyTelegram(client, leadName, phone, intent) {
  if (!client?.telegram_connected || !client.telegram_chat_id || !TELEGRAM_BOT_TOKEN) return;
  if (client.dnd_enabled) return;
  try {
    const msg = `🆕 <b>New Lead Captured</b>\n\n` +
      `📱 <b>${leadName || 'Unknown'}</b>\n` +
      `📞 ${phone}\n` +
      `🎯 Intent: ${intent || 'General inquiry'}\n\n` +
      `Added to your leads list automatically.`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: client.telegram_chat_id, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error(`[autoCreateLeadFromInbound] Telegram failed: ${e.message}`);
  }
}

export default async function autoCreateLeadFromInbound(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Use service-role bound to the request — `createClient({ asServiceRole: true })`
    // on the server is unauthenticated and fails with 401 on the first entity call.
    const client = base44;;
    const base44 = client.asServiceRole;

    const { call_log_id } = await c.req.json();
    if (!call_log_id) {
      return c.json({ data: { success: false, error: 'call_log_id required' } }, 400);
    }

    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return c.json({ data: { success: false, error: 'CallLog not found' } }, 404);
    }

    // Guard: only inbound, no existing lead, has transcript, known client
    if (callLog.direction !== 'inbound') {
      return c.json({ data: { success: false, skipped: 'not inbound' } });
    }
    if (callLog.lead_id) {
      return c.json({ data: { success: false, skipped: 'lead already linked' } });
    }
    if (!callLog.transcript || callLog.transcript.length < 50) {
      return c.json({ data: { success: false, skipped: 'no transcript' } });
    }
    if (!callLog.client_id || callLog.client_id === 'unknown') {
      return c.json({ data: { success: false, skipped: 'unknown client' } });
    }

    // Normalize caller phone
    const cleanPhone = (callLog.caller_id || '').replace(/\D/g, '');
    const last10 = cleanPhone.slice(-10);
    if (!last10) {
      return c.json({ data: { success: false, skipped: 'no caller number' } });
    }

    // Double-check no lead already exists for this phone (race-safety)
    const existing = await base44.entities.Lead.filter({ client_id: callLog.client_id });
    const dupe = existing.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === last10);
    if (dupe) {
      // Link the call to the existing lead rather than duplicating
      await base44.entities.CallLog.update(call_log_id, { lead_id: dupe.id });
      console.log(`[autoCreateLeadFromInbound] Existing lead ${dupe.id} linked — no creation needed`);
      return c.json({ data: { success: true, skipped: 'lead already exists', lead_id: dupe.id } });
    }

    // Extract lead info from transcript
    const extracted = await azureLLM(
      `You are analyzing a transcript of an INBOUND call from an unknown caller to a business.\n` +
      `Extract the caller's details from what they said about themselves.\n\n` +
      `TRANSCRIPT:\n${callLog.transcript.substring(0, 6000)}\n\n` +
      `Extract: name, email, company, intent (what they wanted), interest_level (hot/warm/cold/spam), notes (2-3 sentence summary).\n` +
      `If a field was not shared, return null for that field. Do NOT invent data.`,
      {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          company: { type: ['string', 'null'] },
          intent: { type: ['string', 'null'] },
          interest_level: { type: 'string', enum: ['hot', 'warm', 'cold', 'spam'] },
          notes: { type: 'string' }
        },
        required: ['interest_level', 'notes']
      }
    );

    console.log(`[autoCreateLeadFromInbound] Extracted:`, JSON.stringify(extracted));

    // Skip if classified as spam
    if (extracted.interest_level === 'spam') {
      console.log(`[autoCreateLeadFromInbound] Spam call — skipping lead creation`);
      return c.json({ data: { success: false, skipped: 'spam call' } });
    }

    // Map interest → lead status + score
    const statusMap = { hot: 'interested', warm: 'interested', cold: 'contacted' };
    const scoreMap = { hot: 75, warm: 55, cold: 30 };

    const newLead = await base44.entities.Lead.create({
      client_id: callLog.client_id,
      name: extracted.name || `Inbound Caller ${last10}`,
      phone: callLog.caller_id,
      email: extracted.email || undefined,
      company: extracted.company || undefined,
      status: statusMap[extracted.interest_level] || 'new',
      score: scoreMap[extracted.interest_level] || 40,
      qualification_tier: extracted.interest_level,
      source: 'inbound_call',
      notes: extracted.notes + (extracted.intent ? `\n\nIntent: ${extracted.intent}` : ''),
      last_call_date: callLog.call_end_time || callLog.call_start_time || new Date().toISOString(),
      last_engagement_date: new Date().toISOString(),
      engagement_count: 1
    });

    // Link the CallLog back to the new lead
    await base44.entities.CallLog.update(call_log_id, { lead_id: newLead.id });

    // Mirror the new lead into Postgres (best-effort, credit-independent).
    base44.functions.invoke('pgLeadSync', { lead: newLead }).catch(() => {});

    console.log(`[autoCreateLeadFromInbound] ✅ Created Lead ${newLead.id} "${newLead.name}" from CallLog ${call_log_id}`);

    // Notify client (Telegram, non-blocking)
    try {
      const client = await base44.entities.Client.get(callLog.client_id);
      notifyTelegram(client, newLead.name, newLead.phone, extracted.intent);
    } catch (_) {}

    return c.json({ data: {
      success: true,
      lead_id: newLead.id,
      name: newLead.name,
      interest_level: extracted.interest_level,
      intent: extracted.intent
    } });

  } catch (error) {
    console.error('[autoCreateLeadFromInbound] Error:', error);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};