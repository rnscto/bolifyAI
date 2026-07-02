import { Hono, Context } from "hono";
import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";

export const agentsRouter = new Hono();

// Helper to call Azure OpenAI
async function callAzureOpenAI({ system, user, max_tokens = 800 }: { system: string, user: string, max_tokens?: number }) {
  const rawEndpoint = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
      if (!rawEndpoint || !deployment || !apiKey) {
    throw new Error('Missing AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT / AZURE_OPENAI_KEY');
  }
  let baseUrl = rawEndpoint;
  const oI = baseUrl.indexOf('/openai/'); if (oI > 0) baseUrl = baseUrl.substring(0, oI);
  const pI = baseUrl.indexOf('/api/projects'); if (pI > 0) baseUrl = baseUrl.substring(0, pI);

    const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      max_completion_tokens: max_tokens,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Azure OpenAI ${res.status}: ${txt.substring(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

// 1. processTranscript
agentsRouter.post('/process-transcript', async (c: Context) => {
  try {
    const { call_log_id, recording_url } = await c.req.json();
    if (!call_log_id || !recording_url) {
      return c.json({ error: 'Missing required fields' }, 400);
    }
    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) return c.json({ error: 'Call log not found' }, 404);

    const audioResponse = await fetch(recording_url);
    if (!audioResponse.ok) return c.json({ error: 'Failed to download recording' }, 500);
    const audioBuffer = await audioResponse.arrayBuffer();
    
    const contentType = audioResponse.headers.get('content-type') || '';
    let fileName = 'recording.mp3';
    let mimeType = 'audio/mpeg';
    if (contentType.includes('wav')) { fileName = 'recording.wav'; mimeType = 'audio/wav'; }
    else if (contentType.includes('ogg')) { fileName = 'recording.ogg'; mimeType = 'audio/ogg'; }
    else if (contentType.includes('mp4') || contentType.includes('m4a')) { fileName = 'recording.m4a'; mimeType = 'audio/mp4'; }
    else if (contentType.includes('webm')) { fileName = 'recording.webm'; mimeType = 'audio/webm'; }

    const azureSttEndpoint = 'https://ai-yadavnand8860531ai976911404567.cognitiveservices.azure.com';
    const sttDeployment = 'gpt-4o-transcribe';
    const sttApiVersion = '2025-01-01-preview';
    const sttUrl = `${azureSttEndpoint}/openai/deployments/${sttDeployment}/audio/transcriptions?api-version=${sttApiVersion}`;

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), fileName);
    formData.append('language', 'hi');
    formData.append('response_format', 'text');

    const sttResponse = await fetch(sttUrl, {
      method: 'POST',
      headers: { 'api-key': Deno.env.get('AZURE_OPENAI_KEY') || '' },
      body: formData
    });

    if (!sttResponse.ok) {
      const errText = await sttResponse.text();
      return c.json({ error: 'Speech to text failed', detail: errText }, 500);
    }

    const transcript = await sttResponse.text();

    const analysis = await callAzureOpenAI({
      system: `You are an expert sales call analyst AI. Analyze call transcripts to extract:
1. A brief summary of the conversation
2. Lead status classification
3. Sentiment analysis
4. Intent signals (buying signals, objections, questions)
5. A lead score from 0-100 based on conversion likelihood

SCORING CRITERIA (total 100):
- Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
- Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, competitor_mention=+5, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10, referral=+8 (cap at 30)
- Engagement (0-25): short_answers_only=5, asked_questions=15, extended_conversation=20, highly_engaged=25
- Keywords (0-20): positive keywords like "interested","sign up"=+5 each (cap 20); negative keywords like "not interested"=-5 each (min 0)

Respond ONLY in valid JSON with this exact structure.`,
      user: `Analyze this sales call transcript:\n\n${transcript}\n\nReturn JSON with: summary (string), lead_status (one of: interested, not_interested, callback, converted, contacted), sentiment (one of: very_positive, positive, neutral, negative, very_negative), intent_signals (array of strings), lead_score (number 0-100), score_breakdown (object), key_keywords (array of strings)`
    });

    const summary = analysis.summary || 'Analysis not available';
    const leadStatus = analysis.lead_status || 'contacted';
    const sentiment = analysis.sentiment || 'neutral';
    const leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
    const intentSignals = analysis.intent_signals || [];

    await base44.entities.CallLog.update(call_log_id, {
      status: 'completed',
      transcript,
      conversation_summary: `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Signals: ${intentSignals.join(', ')}`,
      lead_status_updated: leadStatus
    });

    let qualificationTier = 'cold';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) qualificationTier = 'hot';
    else if (leadScore >= 75 && sentiment === 'neutral') qualificationTier = 'warm';
    else if (leadScore >= 50) qualificationTier = 'warm';
    else if (leadScore >= 25) qualificationTier = 'nurture';
    else if (['negative', 'very_negative'].includes(sentiment)) qualificationTier = 'disqualified';

    const isNonAnswer = !transcript || transcript.length < 100 || leadStatus === 'no_answer';

    if (callLog.lead_id && !isNonAnswer) {
      await base44.entities.Lead.update(callLog.lead_id, {
        status: leadStatus,
        score: leadScore,
        sentiment: sentiment,
        intent_signals: intentSignals,
        qualification_tier: qualificationTier,
        last_call_date: new Date().toISOString()
      });
    }

    return c.json({ success: true, transcript, summary, lead_status: leadStatus, lead_score: leadScore, sentiment, qualification_tier: qualificationTier });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 2. postCallActionExtractor
agentsRouter.post('/post-call-action-extractor', async (c: Context) => {
  try {
    const { call_log_id } = await c.req.json();
    if (!call_log_id) return c.json({ error: 'Missing call_log_id' }, 400);

    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog || !callLog.transcript) return c.json({ skipped: true, reason: 'No transcript available' });
    if (callLog.transcript.length < 100) return c.json({ skipped: true, reason: 'Transcript too short' });
    if (['no_answer', 'failed'].includes(callLog.status)) return c.json({ skipped: true, reason: 'No real conversation' });

    const now = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const todayStr = istNow.toISOString().split('T')[0];

    const extracted = await callAzureOpenAI({
      system: `You are an expert at extracting actionable items from sales call transcripts. Today is ${todayStr}. Return JSON with this exact structure:
{
  "lead_notes": "string — Key information about the lead",
  "actions": [
    {
      "type": "call|email|demo|appointment|visit|meeting|task|followup",
      "title": "Brief title",
      "description": "Details",
      "scheduled_date": "ISO date-time string in UTC",
      "priority": "low|medium|high",
      "confirmed": true/false,
      "trigger": "Quote from transcript"
    }
  ]
}`,
      user: `Call transcript:\n\n${callLog.transcript}\n\nAI Summary: ${callLog.conversation_summary || ''}`,
      max_tokens: 1000
    });

    let activities_created = 0;
    if (callLog.lead_id && extracted.lead_notes) {
      const lead = await base44.entities.Lead.get(callLog.lead_id);
      const updatedNotes = lead.notes ? `${lead.notes}\n\n[${todayStr}] ${extracted.lead_notes}` : `[${todayStr}] ${extracted.lead_notes}`;
      await base44.entities.Lead.update(callLog.lead_id, { notes: updatedNotes });
    }

    if (extracted.actions && Array.isArray(extracted.actions)) {
      for (const action of extracted.actions) {
        await base44.entities.Activity.create({
          client_id: callLog.client_id,
          lead_id: callLog.lead_id || null,
          call_log_id: call_log_id,
          type: action.type || 'task',
          title: action.title || 'Follow-up',
          description: action.description || '',
          scheduled_date: action.scheduled_date || new Date().toISOString(),
          status: 'scheduled',
          priority: action.priority || 'medium',
          auto_created: true
        });
        activities_created++;
      }
    }

    return c.json({ success: true, activities_created, lead_notes_extracted: !!extracted.lead_notes });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 3. scoreInboundCall
agentsRouter.post('/score-inbound-call', async (c: Context) => {
  try {
    const { call_log_id } = await c.req.json();
    if (!call_log_id) return c.json({ error: 'call_log_id required' }, 400);

    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) return c.json({ error: 'CallLog not found' }, 404);
    if (callLog.direction !== 'inbound') return c.json({ skipped: 'not_inbound' });
    if (!callLog.lead_id) return c.json({ skipped: 'no_lead_linked' });

    const lead = await base44.entities.Lead.get(callLog.lead_id);
    if (!lead) return c.json({ skipped: 'lead_not_found' });

    if (!callLog.transcript && !callLog.conversation_summary) {
      return c.json({ skipped: 'no_transcript_or_summary' });
    }

    const aiResult = await callAzureOpenAI({
      system: 'You are an expert sales lead scoring AI. Always respond in valid JSON.',
      user: `Analyze this INBOUND call transcript. Score the lead's purchase intent (0-100), detect sentiment, and extract intent signals.
TRANSCRIPT: ${callLog.transcript}
SUMMARY: ${callLog.conversation_summary}
Respond in JSON matching schema: { score: number, sentiment: string, intent_signals: string[], reasoning: string }`
    });

    const finalScore = Math.min(100, Math.max(0, parseInt(aiResult.score) || 0));
    const sentiment = aiResult.sentiment || 'neutral';
    const newIntents = aiResult.intent_signals || [];
    const mergedIntents = Array.from(new Set([...(lead.intent_signals || []), ...newIntents])).slice(0, 20);

    let qualificationTier = 'cold';
    if (finalScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) qualificationTier = 'hot';
    else if (finalScore >= 50) qualificationTier = 'warm';
    else if (finalScore >= 25) qualificationTier = 'nurture';
    else if (['negative', 'very_negative'].includes(sentiment)) qualificationTier = 'disqualified';

    await base44.entities.Lead.update(lead.id, {
      score: finalScore,
      sentiment,
      intent_signals: mergedIntents,
      qualification_tier: qualificationTier,
      last_call_date: new Date().toISOString()
    });

    return c.json({ success: true, lead_id: lead.id, new_score: finalScore, sentiment, intent_signals: newIntents });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 4. generatePromptAndPersona
agentsRouter.post('/generate-prompt-and-persona', async (c: Context) => {
  try {
    const { business_name, industry, goal, languages = ['en-IN'], tone = 'friendly', business_description = '' } = await c.req.json();
    if (!business_name || !industry || !goal) return c.json({ error: 'business_name, industry and goal are required' }, 400);

    const llmOut = await callAzureOpenAI({
      system: `You are an expert at writing system prompts for Indian AI voice agents. Return ONLY a JSON object with these keys: { business_section: string, greeting: string, agent_persona_name: string, recommended_tone: string }`,
      user: `Create the system prompt for this AI voice agent:
Business name: ${business_name}
Industry: ${industry}
Call goal: ${goal}
Languages: ${languages.join(', ')}
Tone: ${tone}
Description: ${business_description}
Return JSON only.`,
      max_tokens: 3500
    });

    const businessSection = (llmOut.business_section || '').trim();
    const hardRules = `\n============================================================\nGLOBAL HARD RULES — DO NOT VIOLATE\n============================================================\n1. NO HALLUCINATION\n2. BACKGROUND NOISE HANDLING\n3. VOICE & TONE STABILITY\n4. HUMAN-LIKE CONVERSATION\n============================================================`;
    const fullPrompt = `${businessSection}\n${hardRules}`.substring(0, 10000);

    return c.json({
      success: true,
      system_prompt: fullPrompt,
      greeting_message: llmOut.greeting || '',
      persona_name: llmOut.agent_persona_name || '',
      recommended_tone: llmOut.recommended_tone || tone
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
// 5. Agent Tools CRUD
agentsRouter.get('/:agent_id/tools', async (c: Context) => {
  try {
    const agent_id = c.req.param('agent_id');
    const res = await client.queryObject(`SELECT * FROM "agent_tools" WHERE agent_id = $1 ORDER BY created_at DESC`, [agent_id]);
    return c.json({ success: true, tools: res.rows });
  } catch(e: any) {
    return c.json({ error: e.message }, 500);
  }
});

agentsRouter.post('/:agent_id/tools', async (c: Context) => {
  try {
    const agent_id = c.req.param('agent_id');
    const body = await c.req.json();
    const { client_id, name, description, method, url, headers, parameters_schema } = body;
    const res = await client.queryObject(
      `INSERT INTO "agent_tools" (agent_id, client_id, name, description, method, url, headers, parameters_schema) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [agent_id, client_id, name, description, method, url, JSON.stringify(headers || {}), JSON.stringify(parameters_schema || {})]
    );
    return c.json({ success: true, tool: res.rows[0] });
  } catch(e: any) {
    return c.json({ error: e.message }, 500);
  }
});

agentsRouter.delete('/tools/:tool_id', async (c: Context) => {
  try {
    const tool_id = c.req.param('tool_id');
    await client.queryObject(`DELETE FROM "agent_tools" WHERE id = $1`, [tool_id]);
    return c.json({ success: true });
  } catch(e: any) {
    return c.json({ error: e.message }, 500);
  }
});

