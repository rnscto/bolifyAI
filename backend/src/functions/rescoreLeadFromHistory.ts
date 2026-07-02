import { base44ORM as base44 } from "../db/orm.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";

async function azureLLM(prompt: string, systemPrompt: string, jsonSchema: any) {
        if (!baseUrl || !deployment || !apiKey) {
    throw new Error('Azure OpenAI credentials missing from .env');
  }

    const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_tokens: 800,
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function scoreLead(lead: any) {
  const calls = await base44.entities.CallLog.filter({ lead_id: lead.id }, '-created_at', 10);
  const latest = calls.find((c: any) => (c.transcript && c.transcript.length > 30) || (c.conversation_summary && c.conversation_summary.length > 20));

  if (!latest) {
    return { skipped: 'no_call_history', lead_id: lead.id };
  }

  const transcript = latest.transcript || '';
  const summary = latest.conversation_summary || '';
  const duration = latest.duration || 0;
  const direction = latest.direction || 'outbound';

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

export default async function rescoreLeadFromHistory(c: any) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { lead_id, client_id, limit = 50 } = body;

    // TODO: Verify JWT user roles

    if (lead_id) {
      const lead = await base44.entities.Lead.get(lead_id);
      if (!lead) return c.json({ data: { error: 'Lead not found' } }, 404);
      const result = await scoreLead(lead);
      return c.json({ data: result });
    }

    if (client_id) {
      const allLeads = await base44.entities.Lead.filter({ client_id }, '-last_call_date', Math.min(limit, 200));
      const leadsWithCalls = allLeads.filter((l: any) => l.last_call_date);

      const results = { processed: 0, scored: 0, skipped: 0, errors: 0, details: [] as any[] };
      for (const lead of leadsWithCalls.slice(0, limit)) {
        results.processed++;
        try {
          const r = await scoreLead(lead);
          if (r.success) {
            results.scored++;
            results.details.push({ lead: lead.name || lead.phone, prev: r.previous_score, new: r.new_score });
          } else {
            results.skipped++;
          }
        } catch (e: any) {
          console.error(`[rescoreLeadFromHistory] Failed for ${lead.id}: ${e.message}`);
          results.errors++;
        }
      }
      return c.json({ data: { success: true, ...results } });
    }

    return c.json({ data: { error: 'Provide lead_id or client_id' } }, 400);
  } catch (error: any) {
    console.error('[rescoreLeadFromHistory] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
