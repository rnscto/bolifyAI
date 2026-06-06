import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Scores an inbound call by analyzing its transcript with Azure OpenAI,
// then updates the associated Lead's AI score, sentiment, intent signals
// and breakdown. The existing leadQualification entity automation will
// then auto-assign tier (hot/warm/nurture/cold/disqualified) and trigger actions.
//
// Payload: { call_log_id: string }

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

Deno.serve(async (req) => {
  try {
    const base44Client = createClientFromRequest(req);
    const base44 = base44Client.asServiceRole;

    const { call_log_id } = await req.json();
    if (!call_log_id) return Response.json({ error: 'call_log_id required' }, { status: 400 });

    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) return Response.json({ error: 'CallLog not found' }, { status: 404 });

    // Only score inbound calls
    if (callLog.direction !== 'inbound') {
      return Response.json({ skipped: 'not_inbound' });
    }
    if (!callLog.lead_id) {
      return Response.json({ skipped: 'no_lead_linked' });
    }

    const lead = await base44.entities.Lead.get(callLog.lead_id);
    if (!lead) return Response.json({ skipped: 'lead_not_found' });

    const transcript = callLog.transcript || '';
    const summary = callLog.conversation_summary || '';
    const duration = callLog.duration || 0;

    // Need at least *something* to score on
    if (!transcript && !summary) {
      return Response.json({ skipped: 'no_transcript_or_summary' });
    }

    // Engagement signals (deterministic, before LLM)
    // duration: 0-30s = low, 30-90s = mid, 90s+ = high
    const engagementScore = duration >= 90 ? 25 : duration >= 30 ? 15 : duration > 0 ? 5 : 0;

    const aiResult = await azureLLM(
      `Analyze this INBOUND call transcript from a customer who called the business. Score the lead's purchase intent (0-100), detect sentiment, and extract intent signals.

LEAD CONTEXT:
- Name: ${lead.name || 'Unknown'}
- Company: ${lead.company || 'N/A'}
- Current Status: ${lead.status || 'new'}
- Existing Score: ${lead.score || 0}/100

CALL DURATION: ${duration} seconds
CONVERSATION SUMMARY: ${summary || '(none)'}

TRANSCRIPT:
${transcript ? transcript.substring(0, 4000) : '(no transcript — only summary available)'}

Score guidance for INBOUND calls (caller initiated contact):
- Inbound calls inherently signal interest — baseline starts at 40+
- Asks pricing / "how much" / wants quote → +20
- Asks for demo / meeting / visit → +25
- Mentions budget / timeline / decision-making → +15
- Asks technical/product details → +10
- Just info-gathering / generic enquiry → 0
- Wrong number / not relevant → score < 25
- Already a customer / support call → score 50 baseline

Detect intent_signals from this list: pricing_request, demo_request, meeting_request, budget_confirmed, timeline_mentioned, decision_maker, brochure_request, location_request, payment_intent, support_query, comparison_shopping, objection_price, objection_timing, objection_need, callback_requested, wrong_number.

Respond with JSON.`,
      'You are an expert sales lead scoring AI. Always respond in valid JSON.',
      {
        type: 'object',
        properties: {
          score: { type: 'number', description: '0-100 purchase intent score' },
          sentiment: { type: 'string', enum: ['very_positive', 'positive', 'neutral', 'negative', 'very_negative'] },
          intent_signals: { type: 'array', items: { type: 'string' } },
          score_breakdown: {
            type: 'object',
            properties: {
              intent: { type: 'number' },
              engagement: { type: 'number' },
              fit: { type: 'number' },
              urgency: { type: 'number' }
            }
          },
          reasoning: { type: 'string' }
        },
        required: ['score', 'sentiment', 'intent_signals']
      }
    );

    // Blend engagement bonus into final score (cap at 100)
    const aiScore = Math.max(0, Math.min(100, parseInt(aiResult.score) || 0));
    const finalScore = Math.min(100, aiScore + Math.round(engagementScore * 0.3));

    const breakdown = aiResult.score_breakdown || {};
    breakdown.engagement_bonus = Math.round(engagementScore * 0.3);
    breakdown.call_duration_seconds = duration;
    breakdown.source = 'inbound_call';
    breakdown.reasoning = aiResult.reasoning || '';

    // Merge intent signals (preserve previous, add new)
    const prevIntents = lead.intent_signals || [];
    const newIntents = aiResult.intent_signals || [];
    const mergedIntents = Array.from(new Set([...prevIntents, ...newIntents])).slice(0, 20);

    // Recompute qualification_tier from the updated score so Hot/Warm filters stay accurate.
    // Thresholds match streamAudioInbound.saveCallRecord for consistency across both paths.
    const sentiment = aiResult.sentiment || 'neutral';
    let qualificationTier = 'cold';
    let qualificationReason = '';
    if (finalScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) {
      qualificationTier = 'hot';
      qualificationReason = `Inbound score ${finalScore}/100, ${sentiment}`;
    } else if (finalScore >= 50) {
      qualificationTier = 'warm';
      qualificationReason = `Inbound score ${finalScore}/100, ${sentiment}`;
    } else if (finalScore >= 25) {
      qualificationTier = 'nurture';
      qualificationReason = `Inbound score ${finalScore}/100`;
    } else if (['negative', 'very_negative'].includes(sentiment)) {
      qualificationTier = 'disqualified';
      qualificationReason = `Low inbound score ${finalScore}/100, ${sentiment}`;
    }
    // Never demote a 'converted' lead's tier
    if (lead.status === 'converted') {
      qualificationTier = 'hot';
      qualificationReason = 'Converted';
    }

    await base44.entities.Lead.update(lead.id, {
      score: finalScore,
      sentiment,
      intent_signals: mergedIntents,
      score_breakdown: breakdown,
      qualification_tier: qualificationTier,
      qualification_reason: qualificationReason,
      last_call_date: callLog.call_end_time || callLog.call_start_time || new Date().toISOString(),
      last_engagement_date: new Date().toISOString(),
      engagement_count: (lead.engagement_count || 0) + 1
    });

    console.log(`[scoreInboundCall] Lead ${lead.id} (${lead.name}): score ${lead.score || 0} → ${finalScore}, sentiment=${aiResult.sentiment}, intents=${newIntents.join(',')}`);

    return Response.json({
      success: true,
      lead_id: lead.id,
      previous_score: lead.score || 0,
      new_score: finalScore,
      sentiment: aiResult.sentiment,
      intent_signals: newIntents
    });
  } catch (error) {
    console.error('[scoreInboundCall] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});