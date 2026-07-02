import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
async function azureLLM(prompt, systemPrompt, jsonSchema) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_completion_tokens: 1200,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    console.warn('[parseCallbacks] Azure returned empty content, returning empty object');
    return {};
  }
  return JSON.parse(content);
}

export default async function parseCallbacks(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id, enrich = false } = await c.req.json();
    const svc = base44.asServiceRole;

    // ── Fetch everything in PARALLEL (was 7 sequential round-trips) ──
    const [
      callbackLeads,
      interestedLeads,
      campaignCallbacks,
      campaignInterested,
      followupActivities,
      callActivities,
      callLogs,
    ] = await Promise.all([
      svc.entities.Lead.filter({ client_id, status: 'callback' }),
      svc.entities.Lead.filter({ client_id, status: 'interested' }),
      svc.entities.CampaignLead.filter({ client_id, outcome: 'callback' }),
      svc.entities.CampaignLead.filter({ client_id, outcome: 'interested' }),
      svc.entities.Activity.filter({ client_id, type: 'followup', status: 'scheduled' }),
      svc.entities.Activity.filter({ client_id, type: 'call', status: 'scheduled' }),
      svc.entities.CallLog.filter({ client_id, status: 'completed' }, '-created_date', 200),
    ]);

    const allCallbackLeads = [...callbackLeads, ...interestedLeads];
    const campaignLeads = [...campaignCallbacks, ...campaignInterested];
    const activities = [...followupActivities, ...callActivities];
    
    // Index by lead_id (keep only the most recent per lead)
    const callLogByLead = {};
    for (const log of callLogs) {
      if (log.lead_id && !callLogByLead[log.lead_id]) {
        callLogByLead[log.lead_id] = log;
      }
    }

    // Use LLM to extract callback details from transcripts
    const callbackItems = [];

    for (const lead of allCallbackLeads) {
      const matchingLog = callLogByLead[lead.id];
      const matchingCL = campaignLeads.find(cl => cl.lead_id === lead.id);
      const matchingActivity = activities.find(a => a.lead_id === lead.id);

      const transcript = matchingCL?.transcript || matchingLog?.transcript || '';
      const summary = matchingCL?.conversation_summary || matchingLog?.conversation_summary || '';

      // Build the base callback item from existing data
      const item = {
        lead_id: lead.id,
        lead_name: lead.name || 'Unknown',
        lead_phone: lead.phone,
        lead_email: lead.email || '',
        lead_company: lead.company || '',
        lead_score: lead.score || 0,
        qualification_tier: lead.qualification_tier || 'cold',
        sentiment: lead.sentiment || 'neutral',
        intent_signals: lead.intent_signals || [],
        summary: summary.split('\n---')[0].trim(),
        transcript_snippet: transcript.length > 500 ? transcript.slice(-500) : transcript,
        existing_followup_date: lead.next_followup_date || matchingActivity?.scheduled_date || null,
        activity_id: matchingActivity?.id || null,
        activity_title: matchingActivity?.title || null,
        call_date: matchingLog?.call_start_time || matchingCL?.created_date || null,
        call_duration: matchingLog?.duration || matchingCL?.call_duration || 0,
        campaign_lead_id: matchingCL?.id || null,
        extracted: null, // Will be filled by AI
      };

      callbackItems.push(item);
    }

    // Batch AI extraction for items that have transcripts.
    // Only runs when explicitly requested (enrich=true) — the default page
    // load skips the expensive LLM call and renders instantly from DB data.
    const itemsWithTranscripts = enrich
      ? callbackItems.filter(i => i.transcript_snippet && i.transcript_snippet.length > 20)
      : [];

    if (itemsWithTranscripts.length > 0) {
      const batchPrompt = itemsWithTranscripts.map((item, idx) => {
        return `--- LEAD #${idx + 1}: ${item.lead_name} ---\nCall Date: ${item.call_date || 'Unknown'}\nSummary: ${item.summary}\nTranscript (last part):\n${item.transcript_snippet}\n`;
      }).join('\n\n');

      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      const aiResult = await azureLLM(
        `You are a call analysis assistant. Current date/time (IST): ${nowIST}.

For each lead below, extract the callback/follow-up details mentioned in the conversation. Look for:
1. When to call back (specific date/time, relative time like "tomorrow 2 PM", "after 30 minutes", "next week", etc.)
2. Why they want a callback (reason/context)
3. Any specific requests they made (demo, pricing, meeting with senior person, etc.)

If no specific callback time was mentioned, estimate based on context (e.g., "busy now" = try again in a few hours).

${batchPrompt}`,
        'You are a call analysis assistant. Always respond in valid JSON.',
        {
          type: "object",
          properties: {
            leads: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  lead_index: { type: "number" },
                  callback_datetime_ist: { type: "string" },
                  callback_time_description: { type: "string" },
                  reason: { type: "string" },
                  specific_requests: { type: "array", items: { type: "string" } },
                  confidence: { type: "string" },
                  urgency: { type: "string" }
                }
              }
            }
          }
        }
      );

      // Merge AI results back
      if (aiResult?.leads) {
        for (const aiLead of aiResult.leads) {
          const idx = (aiLead.lead_index || 1) - 1;
          if (idx >= 0 && idx < itemsWithTranscripts.length) {
            const targetItem = callbackItems.find(i => i.lead_id === itemsWithTranscripts[idx].lead_id);
            if (targetItem) {
              targetItem.extracted = {
                callback_datetime: aiLead.callback_datetime_ist || null,
                callback_description: aiLead.callback_time_description || 'No specific time mentioned',
                reason: aiLead.reason || 'Follow-up requested',
                specific_requests: aiLead.specific_requests || [],
                confidence: aiLead.confidence || 'low',
                urgency: aiLead.urgency || 'medium',
              };
            }
          }
        }
      }
    }

    // Fill defaults for items without AI extraction
    for (const item of callbackItems) {
      if (!item.extracted) {
        item.extracted = {
          callback_datetime: item.existing_followup_date || null,
          callback_description: item.existing_followup_date
            ? new Date(item.existing_followup_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
            : 'No specific time — needs scheduling',
          reason: item.summary || 'Follow-up requested during call',
          specific_requests: [],
          confidence: 'low',
          urgency: 'low',
        };
      }
    }

    // Sort by urgency: high first, then by callback datetime
    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    callbackItems.sort((a, b) => {
      const uA = urgencyOrder[a.extracted?.urgency] ?? 2;
      const uB = urgencyOrder[b.extracted?.urgency] ?? 2;
      if (uA !== uB) return uA - uB;
      const dA = a.extracted?.callback_datetime ? new Date(a.extracted.callback_datetime).getTime() : Infinity;
      const dB = b.extracted?.callback_datetime ? new Date(b.extracted.callback_datetime).getTime() : Infinity;
      return dA - dB;
    });

    return c.json({ data: { 
      success: true, 
      callbacks: callbackItems,
      total: callbackItems.length,
      enriched: enrich,
      parsed_at: new Date().toISOString()
    } });
  } catch (error) {
    console.error('[parseCallbacks] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};