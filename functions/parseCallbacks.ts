import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
async function azureLLM(prompt, systemPrompt, jsonSchema) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { client_id } = await req.json();
    const svc = base44.asServiceRole;

    // Fetch callback AND interested leads for this client
    const callbackLeads = await svc.entities.Lead.filter({ client_id, status: 'callback' });
    const interestedLeads = await svc.entities.Lead.filter({ client_id, status: 'interested' });
    const allCallbackLeads = [...callbackLeads, ...interestedLeads];
    
    // Fetch recent campaign leads with callback or interested outcome
    const campaignCallbacks = await svc.entities.CampaignLead.filter({ client_id, outcome: 'callback' });
    const campaignInterested = await svc.entities.CampaignLead.filter({ client_id, outcome: 'interested' });
    const campaignLeads = [...campaignCallbacks, ...campaignInterested];
    
    // Fetch scheduled followup activities (all types that need action)
    const followupActivities = await svc.entities.Activity.filter({ client_id, type: 'followup', status: 'scheduled' });
    const callActivities = await svc.entities.Activity.filter({ client_id, type: 'call', status: 'scheduled' });
    const activities = [...followupActivities, ...callActivities];

    // Fetch recent completed call logs for this client (batch instead of per-lead)
    const callLogs = await svc.entities.CallLog.filter({ client_id: cId, status: 'completed' }, '-created_date', 200);
    
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

    // Batch AI extraction for items that have transcripts
    const itemsWithTranscripts = callbackItems.filter(i => i.transcript_snippet && i.transcript_snippet.length > 20);
    
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

    return Response.json({ 
      success: true, 
      callbacks: callbackItems,
      total: callbackItems.length,
      parsed_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('[parseCallbacks] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});