import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Re-scores existing leads using their most recent call transcript.
// - Single mode: { lead_id }
// - Bulk mode:   { client_id, only_with_calls?: boolean, limit?: number }
//
// For each lead, finds the most recent CallLog with a transcript or summary,
// runs Azure OpenAI scoring, and updates Lead.score, sentiment, intent_signals,
// and score_breakdown. The existing leadQualification entity automation will
// then auto-assign tier and trigger follow-up actions.

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
      max_completion_tokens: 800,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function scoreLead(base44, lead) {
  // Find most recent CallLog with transcript or summary
  const calls = await base44.entities.CallLog.filter({ lead_id: lead.id }, '-created_at', 10);
  const latest = calls.find(c => (c.transcript && c.transcript.length > 30) || (c.conversation_summary && c.conversation_summary.length > 20));

  if (!latest) {
    return { skipped: 'no_call_history', lead_id: lead.id };
  }

  const transcript = latest.transcript || '';
  const summary = latest.conversation_summary || '';
  const duration = latest.duration || 0;
  const direction = latest.direction || 'outbound';

  // Engagement bonus from duration
  const engagementScore = duration >= 90 ? 25 : duration >= 30 ? 15 : duration > 0 ? 5 : 0;

  const aiResult = await azureLLM(
    `Re-score this existing lead based on their most recent call. Score purchase intent (0-100), detect sentiment, extract intent signals.

LEAD:
- Name: ${lead.name || 'Unknown'}
- Company: ${lead.company || 'N/A'}
- Status: ${lead.status || 'new'}
- Existing Score: ${lead.score || 0}/100

LAST CALL:
- Direction: ${direction}
- Duration: ${duration}s
- Date: ${latest.call_start_time || latest.created_at}

SUMMARY: ${summary || '(none)'}

TRANSCRIPT:
${transcript ? transcript.substring(0, 4000) : '(no transcript — only summary available)'}

Detect intent_signals from: pricing_request, demo_request, meeting_request, budget_confirmed, timeline_mentioned, decision_maker, brochure_request, location_request, payment_intent, support_query, comparison_shopping, objection_price, objection_timing, objection_need, callback_requested, wrong_number.

Respond with JSON.`,
    'You are an expert sales lead scoring AI. Always respond in valid JSON.',
    {
      type: 'object',
      properties: {
        score: { type: 'number' },
        sentiment: { type: 'string', enum: ['very_positive', 'positive', 'neutral', 'negative', 'very_negative'] },
        intent_signals: { type: 'array', items: { type: 'string' } },
        score_breakdown: { type: 'object' },
        reasoning: { type: 'string' }
      },
      required: ['score', 'sentiment', 'intent_signals']
    }
  );

  const aiScore = Math.max(0, Math.min(100, parseInt(aiResult.score) || 0));
  const finalScore = Math.min(100, aiScore + Math.round(engagementScore * 0.3));

  const breakdown = aiResult.score_breakdown || {};
  breakdown.engagement_bonus = Math.round(engagementScore * 0.3);
  breakdown.call_duration_seconds = duration;
  breakdown.source = 'rescore_from_history';
  breakdown.based_on_call_id = latest.id;
  breakdown.reasoning = aiResult.reasoning || '';

  const prevIntents = lead.intent_signals || [];
  const newIntents = aiResult.intent_signals || [];
  const mergedIntents = Array.from(new Set([...prevIntents, ...newIntents])).slice(0, 20);

  await base44.entities.Lead.update(lead.id, {
    score: finalScore,
    sentiment: aiResult.sentiment || 'neutral',
    intent_signals: mergedIntents,
    score_breakdown: breakdown
  });

  return {
    success: true,
    lead_id: lead.id,
    previous_score: lead.score || 0,
    new_score: finalScore,
    sentiment: aiResult.sentiment,
    based_on_call_id: latest.id
  };
}

Deno.serve(async (req) => {
  try {
    const base44Client = createClientFromRequest(req);
    const user = await base44Client.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const base44 = base44Client.asServiceRole;
    const body = await req.json();
    const { lead_id, client_id, limit = 50 } = body;

    // ─── SINGLE LEAD MODE ───
    if (lead_id) {
      const lead = await base44.entities.Lead.get(lead_id);
      if (!lead) return Response.json({ error: 'Lead not found' }, { status: 404 });

      // Ownership check (non-admin)
      if (user.role !== 'admin') {
        const clients = await base44Client.entities.Client.filter({ user_id: user.id });
        if (!clients.find(c => c.id === lead.client_id)) {
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
      }

      const result = await scoreLead(base44, lead);
      return Response.json(result);
    }

    // ─── BULK MODE ───
    if (client_id) {
      // Ownership check (non-admin)
      if (user.role !== 'admin') {
        const clients = await base44Client.entities.Client.filter({ user_id: user.id });
        if (!clients.find(c => c.id === client_id)) {
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
      }

      // Get leads — prioritize those with engagement (last_call_date set)
      const allLeads = await base44.entities.Lead.filter({ client_id }, '-last_call_date', Math.min(limit, 200));
      const leadsWithCalls = allLeads.filter(l => l.last_call_date);

      console.log(`[rescoreLeadFromHistory] Bulk: ${leadsWithCalls.length} leads with call history (cap ${limit})`);

      const results = { processed: 0, scored: 0, skipped: 0, errors: 0, details: [] };
      for (const lead of leadsWithCalls.slice(0, limit)) {
        results.processed++;
        try {
          const r = await scoreLead(base44, lead);
          if (r.success) {
            results.scored++;
            results.details.push({ lead: lead.name || lead.phone, prev: r.previous_score, new: r.new_score });
          } else {
            results.skipped++;
          }
        } catch (e) {
          console.error(`[rescoreLeadFromHistory] Failed for ${lead.id}: ${e.message}`);
          results.errors++;
        }
      }

      return Response.json({ success: true, ...results });
    }

    return Response.json({ error: 'Provide lead_id or client_id' }, { status: 400 });
  } catch (error) {
    console.error('[rescoreLeadFromHistory] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});