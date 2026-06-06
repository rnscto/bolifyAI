import { createClient } from 'npm:@base44/sdk@0.8.31';

// ─── Smartflo token cache (module-level) ───
const SMARTFLO_TOKEN_TTL_MS = 50 * 60 * 1000;
let _smartfloTokenCache = { token: null, expiresAt: 0, inFlight: null, blockedUntil: 0 };

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _smartfloTokenCache.token && _smartfloTokenCache.expiresAt > now) {
    return _smartfloTokenCache.token;
  }
  if (_smartfloTokenCache.blockedUntil > now) {
    console.error(`[Smartflo] Login skipped — rate-limited`);
    return null;
  }
  if (_smartfloTokenCache.inFlight) return _smartfloTokenCache.inFlight;
  const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
  if (!sfE || !sfP) return null;
  _smartfloTokenCache.inFlight = (async () => {
    try {
      const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email: sfE, password: sfP })
      });
      const ld = await lr.json().catch(() => ({}));
      const tk = ld.access_token || ld.token;
      if (!lr.ok || !tk) {
        if (lr.status === 429 || ld.retry_after) {
          let cooldownMs = 10 * 60 * 1000;
          if (ld.retry_after) {
            const ra = new Date(ld.retry_after.replace(' ', 'T') + '+05:30').getTime();
            if (!isNaN(ra) && ra > Date.now()) cooldownMs = ra - Date.now() + 5000;
          }
          _smartfloTokenCache.blockedUntil = Date.now() + cooldownMs;
          console.error(`[Smartflo] Login 429 — backing off for ${Math.round(cooldownMs / 1000)}s`);
        } else { console.error(`[Smartflo] Login failed: ${lr.status}`); }
        return null;
      }
      _smartfloTokenCache.token = tk;
      _smartfloTokenCache.expiresAt = Date.now() + SMARTFLO_TOKEN_TTL_MS;
      _smartfloTokenCache.blockedUntil = 0;
      console.log(`[Smartflo] ✅ New token cached (valid 50min)`);
      return tk;
    } catch (e) { console.error(`[Smartflo] Login error: ${e.message}`); return null; }
    finally { _smartfloTokenCache.inFlight = null; }
  })();
  return _smartfloTokenCache.inFlight;
}

// Process the FULL recording from Smartflo for calls that were transferred to a human agent.
// The AI's WebSocket only captured the pre-transfer transcript. Smartflo records the ENTIRE call
// including the human agent portion. This function fetches that full recording, transcribes it,
// and re-analyzes to get the real outcome (did the human close the deal? schedule demo? etc.)

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const body = await req.json();
    const { call_log_id } = body;

    if (!call_log_id) {
      return Response.json({ error: 'call_log_id required' }, { status: 400 });
    }

    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return Response.json({ error: 'Call log not found' }, { status: 404 });
    }

    // Only process transferred calls
    if (!callLog.transferred_to) {
      return Response.json({ skipped: true, reason: 'Not a transferred call' });
    }

    // Need a recording URL from Smartflo
    if (!callLog.recording_url) {
      console.log(`[processTransferRecording] CallLog ${call_log_id} — no recording_url yet, will retry later`);
      return Response.json({ skipped: true, reason: 'No recording_url available yet' });
    }

    console.log(`[processTransferRecording] Processing transferred call ${call_log_id}`);
    console.log(`[processTransferRecording] Transfer info: ${callLog.transferred_to}`);
    console.log(`[processTransferRecording] Recording URL: ${callLog.recording_url}`);

    // ═══ STEP 1: Download the full recording from Smartflo ═══
    // Smartflo may require auth to download — try with and without JWT
    let audioResponse = await fetch(callLog.recording_url);

    // If direct download fails, try with Smartflo JWT auth (cached token)
    if (!audioResponse.ok) {
      console.log(`[processTransferRecording] Direct download failed (${audioResponse.status}), trying with Smartflo auth...`);
      const token = await getSmartfloToken();
      if (token) {
        audioResponse = await fetch(callLog.recording_url, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
      }

      if (!audioResponse.ok) {
        console.error(`[processTransferRecording] Recording download failed: ${audioResponse.status}`);
        return Response.json({ error: 'Failed to download recording', status: audioResponse.status }, { status: 500 });
      }
    }

    const audioBuffer = await audioResponse.arrayBuffer();
    console.log(`[processTransferRecording] Downloaded recording: ${audioBuffer.byteLength} bytes`);

    if (audioBuffer.byteLength < 1000) {
      console.log(`[processTransferRecording] Recording too small (${audioBuffer.byteLength} bytes) — likely empty`);
      return Response.json({ skipped: true, reason: 'Recording file too small' });
    }

    // Detect file format
    const contentType = audioResponse.headers.get('content-type') || '';
    let fileName = 'recording.mp3';
    let mimeType = 'audio/mpeg';
    if (contentType.includes('wav')) { fileName = 'recording.wav'; mimeType = 'audio/wav'; }
    else if (contentType.includes('ogg')) { fileName = 'recording.ogg'; mimeType = 'audio/ogg'; }
    else if (contentType.includes('mp4') || contentType.includes('m4a')) { fileName = 'recording.m4a'; mimeType = 'audio/mp4'; }
    else if (contentType.includes('webm')) { fileName = 'recording.webm'; mimeType = 'audio/webm'; }

    // ═══ STEP 2: Transcribe the FULL recording using Azure OpenAI ═══
    const azureSttEndpoint = 'https://ai-yadavnand8860531ai976911404567.cognitiveservices.azure.com';
    const sttDeployment = 'gpt-4o-transcribe';
    const sttApiVersion = '2025-01-01-preview';
    const sttUrl = `${azureSttEndpoint}/openai/deployments/${sttDeployment}/audio/transcriptions?api-version=${sttApiVersion}`;

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), fileName);
    formData.append('language', 'hi');
    formData.append('response_format', 'text');

    console.log(`[processTransferRecording] Transcribing full recording...`);

    const sttResponse = await fetch(sttUrl, {
      method: 'POST',
      headers: { 'api-key': Deno.env.get('AZURE_OPENAI_KEY') },
      body: formData
    });

    if (!sttResponse.ok) {
      const errText = await sttResponse.text();
      console.error(`[processTransferRecording] Transcription failed (${sttResponse.status}): ${errText}`);
      return Response.json({ error: 'Transcription failed', detail: errText }, { status: 500 });
    }

    const fullTranscript = await sttResponse.text();
    console.log(`[processTransferRecording] Full transcript (${fullTranscript.length} chars): ${fullTranscript.substring(0, 300)}`);

    if (fullTranscript.length < 30) {
      console.log(`[processTransferRecording] Transcript too short — no meaningful conversation`);
      return Response.json({ skipped: true, reason: 'Transcript too short' });
    }

    // ═══ STEP 3: AI Analysis of the FULL conversation ═══
    // This includes both the AI agent portion AND the human agent portion
    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

    const existingAiTranscript = callLog.transcript || '';

    const analysisResponse = await fetch(
      `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
      {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `You are an expert sales call analyst. This call was TRANSFERRED from an AI agent to a human agent mid-conversation.

The full recording transcript includes BOTH parts:
1. AI agent conversation (beginning of call)
2. Human agent conversation (after transfer)

Your job is to analyze the COMPLETE call — especially the human agent portion — to determine the FINAL outcome.

IMPORTANT: The human agent's portion is what matters most for the final outcome. The AI's initial conversation was just qualification/routing.

SCORING (total 100):
- Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
- Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10
- Engagement (0-25): short_answers=5, asked_questions=15, highly_engaged=25
- Keywords (0-20): positive="interested","sign up","sounds good"=+5 each; negative="not interested","too expensive"=-5 each

Respond ONLY in valid JSON.`
            },
            {
              role: 'user',
              content: `TRANSFERRED CALL ANALYSIS

Previous AI transcript (before transfer):
${existingAiTranscript || '(not available)'}

Full recording transcript (AI + human agent portions):
${fullTranscript}

Transfer reason: ${callLog.transferred_to}

Analyze the FULL conversation and return JSON:
{
  "summary": "2-3 sentence summary focusing on the human agent's conversation outcome",
  "ai_portion_summary": "Brief summary of what happened during AI portion",
  "human_portion_summary": "Brief summary of what happened after transfer to human",
  "lead_status": "interested|not_interested|callback|converted|contacted|do_not_call",
  "sentiment": "very_positive|positive|neutral|negative|very_negative",
  "lead_score": 0-100,
  "intent_signals": ["pricing_inquiry","demo_request","budget_confirmed","timeline_mentioned","decision_maker","referral","objection_price","objection_timing","follow_up_requested"],
  "score_breakdown": {"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},
  "transfer_outcome": "resolved|escalated|demo_scheduled|converted|callback_set|unresolved",
  "human_agent_actions": ["what the human agent did/promised"],
  "recommended_next_action": "..."
}`
            }
          ],
          max_completion_tokens: 1000,
          response_format: { type: "json_object" }
        })
      }
    );

    let analysis = {};
    if (analysisResponse.ok) {
      const data = await analysisResponse.json();
      try {
        analysis = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      } catch (_) {
        analysis = {};
      }
    } else {
      console.error(`[processTransferRecording] Analysis failed: ${analysisResponse.status}`);
    }

    const summary = analysis.summary || 'Full recording analyzed after transfer.';
    const leadStatus = analysis.lead_status || 'contacted';
    const sentiment = analysis.sentiment || 'neutral';
    const leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
    const intentSignals = analysis.intent_signals || [];
    const scoreBreakdown = analysis.score_breakdown || {};
    const transferOutcome = analysis.transfer_outcome || 'unresolved';

    console.log(`[processTransferRecording] Full analysis: score=${leadScore}, status=${leadStatus}, sentiment=${sentiment}, transfer_outcome=${transferOutcome}`);

    // ═══ STEP 4: Determine qualification tier ═══
    let qualificationTier = 'cold';
    let qualificationReason = '';

    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) {
      qualificationTier = 'hot';
      qualificationReason = `Full-call score ${leadScore}/100, ${sentiment}, transfer outcome: ${transferOutcome}`;
    } else if (leadScore >= 50) {
      qualificationTier = 'warm';
      qualificationReason = `Full-call score ${leadScore}/100, transfer outcome: ${transferOutcome}`;
    } else if (leadScore >= 25) {
      qualificationTier = 'nurture';
      qualificationReason = `Full-call score ${leadScore}/100 — needs nurturing`;
    } else if (['negative', 'very_negative'].includes(sentiment)) {
      qualificationTier = 'disqualified';
      qualificationReason = `Low score ${leadScore}/100, ${sentiment}`;
    }
    if (leadStatus === 'converted') { qualificationTier = 'hot'; qualificationReason = 'Converted during human agent call'; }
    if (leadStatus === 'do_not_call') { qualificationTier = 'disqualified'; qualificationReason = 'Do not call'; }

    // ═══ STEP 5: Update CallLog with full transcript and re-analysis ═══
    const enrichedSummary = [
      `[FULL RECORDING ANALYSIS — TRANSFERRED CALL]`,
      summary,
      ``,
      `AI portion: ${analysis.ai_portion_summary || 'N/A'}`,
      `Human portion: ${analysis.human_portion_summary || 'N/A'}`,
      `Transfer outcome: ${transferOutcome}`,
      analysis.human_agent_actions?.length > 0 ? `Human agent actions: ${analysis.human_agent_actions.join('; ')}` : '',
      ``,
      `---`,
      `Score: ${leadScore}/100 | Sentiment: ${sentiment} | Tier: ${qualificationTier} | Signals: ${intentSignals.join(', ')}`,
      analysis.recommended_next_action ? `Next action: ${analysis.recommended_next_action}` : ''
    ].filter(Boolean).join('\n');

    // Build combined transcript: AI portion (from WebSocket) + Full recording transcript
    const combinedTranscript = [
      existingAiTranscript ? `=== AI AGENT PORTION (WebSocket) ===\n${existingAiTranscript}` : '',
      `\n=== FULL RECORDING TRANSCRIPT (AI + Human Agent) ===\n${fullTranscript}`
    ].filter(Boolean).join('\n\n');

    await base44.entities.CallLog.update(call_log_id, {
      transcript: combinedTranscript,
      conversation_summary: enrichedSummary,
      lead_status_updated: leadStatus
    });

    console.log(`[processTransferRecording] CallLog ${call_log_id} updated with full recording analysis`);

    // ═══ STEP 6: Update Lead with re-analyzed score/outcome ═══
    if (callLog.lead_id) {
      try {
        const lead = await base44.entities.Lead.get(callLog.lead_id);
        const existingTags = lead.tags || [];
        const newTags = [...new Set([...existingTags, 'transferred_call', `transfer_${transferOutcome}`])];

        await base44.entities.Lead.update(callLog.lead_id, {
          status: leadStatus,
          score: leadScore,
          sentiment: sentiment,
          intent_signals: intentSignals,
          score_breakdown: scoreBreakdown,
          qualification_tier: qualificationTier,
          qualification_reason: qualificationReason,
          tags: newTags,
          last_engagement_date: new Date().toISOString(),
          notes: `[TRANSFER OUTCOME: ${transferOutcome}] Score: ${leadScore}/100 | ${sentiment} | ${qualificationTier}\n${summary.substring(0, 300)}`
        });
        console.log(`[processTransferRecording] Lead ${callLog.lead_id} re-scored: ${leadScore}/100, tier=${qualificationTier}, status=${leadStatus}`);
      } catch (leadErr) {
        console.error(`[processTransferRecording] Lead update failed: ${leadErr.message}`);
      }
    }

    // ═══ STEP 7: Update CampaignLead if this was a campaign call ═══
    try {
      const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: call_log_id });
      if (campaignLeads.length > 0) {
        const statusToOutcome = {
          'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback',
          'converted': 'converted', 'contacted': 'neutral', 'do_not_call': 'do_not_call'
        };
        await base44.entities.CampaignLead.update(campaignLeads[0].id, {
          outcome: statusToOutcome[leadStatus] || 'neutral',
          conversation_summary: enrichedSummary,
          transcript: combinedTranscript
        });
        console.log(`[processTransferRecording] CampaignLead ${campaignLeads[0].id} updated with transfer outcome`);
      }
    } catch (clErr) {
      console.error(`[processTransferRecording] CampaignLead update failed: ${clErr.message}`);
    }

    return Response.json({
      success: true,
      call_log_id,
      transfer_outcome: transferOutcome,
      lead_status: leadStatus,
      lead_score: leadScore,
      sentiment,
      qualification_tier: qualificationTier,
      full_transcript_length: fullTranscript.length
    });

  } catch (error) {
    console.error('[processTransferRecording] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});