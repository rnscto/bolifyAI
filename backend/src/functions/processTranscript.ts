import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function processTranscript(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Called from smartfloWebhook (no user session) — use service role
    const appId = Deno.env.get('BASE44_APP_ID');
    /* const base44 = ... */;

    const { call_log_id, recording_url } = await c.req.json();

    if (!call_log_id || !recording_url) {
      return c.json({ data: { error: 'Missing required fields' } }, 400);
    }

    // Validate recording_url is a proper URL
    try {
      new URL(recording_url);
    } catch (_) {
      return c.json({ data: { error: 'Invalid recording URL' } }, 400);
    }

    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return c.json({ data: { error: 'Call log not found' } }, 404);
    }

    // Download audio file
    const audioResponse = await fetch(recording_url);
    if (!audioResponse.ok) {
      console.error('Recording download failed:', audioResponse.status);
      return c.json({ data: { error: 'Failed to download recording' } }, 500);
    }
    const audioBuffer = await audioResponse.arrayBuffer();
    console.log(`[processTranscript] Downloaded recording: ${audioBuffer.byteLength} bytes`);

    // Detect file extension from content-type or URL
    const contentType = audioResponse.headers.get('content-type') || '';
    let fileName = 'recording.mp3';
    let mimeType = 'audio/mpeg';
    if (contentType.includes('wav')) { fileName = 'recording.wav'; mimeType = 'audio/wav'; }
    else if (contentType.includes('ogg')) { fileName = 'recording.ogg'; mimeType = 'audio/ogg'; }
    else if (contentType.includes('mp4') || contentType.includes('m4a')) { fileName = 'recording.m4a'; mimeType = 'audio/mp4'; }
    else if (contentType.includes('webm')) { fileName = 'recording.webm'; mimeType = 'audio/webm'; }
    console.log(`[processTranscript] Audio content-type: ${contentType}, using: ${fileName}`);

    // Transcribe using Azure OpenAI gpt-4o-transcribe (best Hindi/Hinglish/English accuracy)
    const azureSttEndpoint = 'https://ai-yadavnand8860531ai976911404567.cognitiveservices.azure.com';
    const sttDeployment = 'gpt-4o-transcribe';
    const sttApiVersion = '2025-01-01-preview';
    const sttUrl = `${azureSttEndpoint}/openai/deployments/${sttDeployment}/audio/transcriptions?api-version=${sttApiVersion}`;

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), fileName);
    formData.append('language', 'hi');
    formData.append('response_format', 'text');

    console.log(`[processTranscript] Calling Azure STT: ${sttUrl.substring(0, 80)}...`);

    const sttResponse = await fetch(sttUrl, {
      method: 'POST',
      headers: {
        'api-key': Deno.env.get('AZURE_OPENAI_KEY')
      },
      body: formData
    });

    if (!sttResponse.ok) {
      const errText = await sttResponse.text();
      console.error(`Azure gpt-4o-transcribe failed (${sttResponse.status}):`, errText);
      return c.json({ data: { error: 'Speech to text failed', detail: errText } }, 500);
    }

    const transcript = await sttResponse.text();
    console.log(`[processTranscript] Transcript (${transcript.length} chars): ${transcript.substring(0, 200)}`);

    // Use Azure OpenAI to analyze conversation + score lead
    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const analysisResponse = await fetch(
      `${baseUrl}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2025-04-01-preview`,
      {
        method: 'POST',
        headers: {
          'api-key': Deno.env.get('AZURE_OPENAI_KEY'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `You are an expert sales call analyst AI. Analyze call transcripts to extract:
1. A brief summary of the conversation
2. Lead status classification
3. Sentiment analysis
4. Intent signals (buying signals, objections, questions)
5. A lead score from 0-100 based on conversion likelihood

SCORING CRITERIA (total 100):
- Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
- Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, competitor_mention=+5, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10, referral=+8 (cap at 30)
- Engagement (0-25): short_answers_only=5, asked_questions=15, extended_conversation=20, highly_engaged=25
- Keywords (0-20): positive keywords like "interested","sign up","let's go","sounds good","when can we start"=+5 each (cap 20); negative keywords like "not interested","too expensive","no need","don't call"=-5 each (min 0)

Respond ONLY in valid JSON with this exact structure.`
            },
            {
              role: 'user',
              content: `Analyze this sales call transcript:\n\n${transcript}\n\nReturn JSON with: summary (string), lead_status (one of: interested, not_interested, callback, voicemail, converted, contacted; use "voicemail" ONLY when the call clearly hit an answering machine / voicemail with no real human conversation), sentiment (one of: very_positive, positive, neutral, negative, very_negative), intent_signals (array of strings like: pricing_inquiry, demo_request, competitor_mention, budget_confirmed, timeline_mentioned, decision_maker, referral, objection_price, objection_timing, objection_need, follow_up_requested), lead_score (number 0-100), score_breakdown (object with: sentiment_score number, intent_score number, engagement_score number, keyword_score number, reasoning string), key_keywords (array of important words/phrases from the conversation)`
            }
          ],
          max_completion_tokens: 800,
          response_format: { type: "json_object" }
        })
      }
    );

    let analysisData = {};
    if (!analysisResponse.ok) {
      const errBody = await analysisResponse.text();
      console.error('OpenAI analysis failed:', errBody);
      analysisData = { choices: [{ message: { content: '{}' } }] };
    } else {
      analysisData = await analysisResponse.json();
    }
    const rawContent = analysisData.choices?.[0]?.message?.content || '{}';
    
    let analysis;
    try {
      analysis = JSON.parse(rawContent);
    } catch (_) {
      console.error('Failed to parse analysis JSON, using fallback');
      analysis = { summary: rawContent, lead_status: 'contacted', sentiment: 'neutral', lead_score: 0, intent_signals: [], score_breakdown: {}, key_keywords: [] };
    }

    const summary = analysis.summary || 'Analysis not available';
    const leadStatus = analysis.lead_status || 'contacted';
    const sentiment = analysis.sentiment || 'neutral';
    const leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
    const intentSignals = analysis.intent_signals || [];
    const scoreBreakdown = analysis.score_breakdown || {};
    const keyKeywords = analysis.key_keywords || [];

    console.log(`[processTranscript] Lead Score: ${leadScore} | Sentiment: ${sentiment} | Status: ${leadStatus} | Intents: ${intentSignals.join(', ')}`);

    // Update call log with transcript, summary, analysis, and mark as completed
    // This update triggers the CallLog entity automation → campaignPostCall
    await base44.entities.CallLog.update(call_log_id, {
      status: 'completed',
      transcript,
      conversation_summary: `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Signals: ${intentSignals.join(', ')}`,
      lead_status_updated: leadStatus
    });

    // ===== AI-DRIVEN QUALIFICATION TIER =====
    const highIntents = ['demo_request', 'budget_confirmed', 'timeline_mentioned', 'decision_maker']
      .filter(s => intentSignals.includes(s));
    let qualificationTier = 'cold';
    let qualificationReason = '';

    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) {
      qualificationTier = 'hot';
      qualificationReason = `Score ${leadScore}/100, ${sentiment} sentiment, strong signals: ${highIntents.join(', ') || 'high engagement'}`;
    } else if (leadScore >= 75 && sentiment === 'neutral') {
      qualificationTier = 'warm';
      qualificationReason = `High score ${leadScore}/100 but neutral sentiment`;
    } else if (leadScore >= 50) {
      qualificationTier = 'warm';
      qualificationReason = `Moderate score ${leadScore}/100, ${sentiment} sentiment`;
    } else if (leadScore >= 25) {
      qualificationTier = 'nurture';
      qualificationReason = `Low-moderate score ${leadScore}/100 — needs nurturing`;
    } else if (['negative', 'very_negative'].includes(sentiment)) {
      qualificationTier = 'disqualified';
      qualificationReason = `Very low score ${leadScore}/100 with ${sentiment} sentiment`;
    } else {
      qualificationTier = 'cold';
      qualificationReason = `Low score ${leadScore}/100 — minimal engagement`;
    }
    if (leadStatus === 'converted') { qualificationTier = 'hot'; qualificationReason = 'Lead converted'; }
    if (leadStatus === 'do_not_call') { qualificationTier = 'disqualified'; qualificationReason = 'Marked do not call'; }

    // ===== AUTO-CREATE COMPLAINT ON DO_NOT_CALL =====
    if (leadStatus === 'do_not_call' && callLog.caller_id) {
      try {
        await base44.entities.ComplaintLog.create({
          did_number: callLog.caller_id,
          client_id: callLog.client_id,
          agent_id: callLog.agent_id,
          complainant_number: callLog.callee_number,
          complaint_type: 'unsolicited',
          complaint_source: 'internal',
          description: `Auto-detected: Lead explicitly requested "do not call" during AI conversation. Call ID: ${call_log_id}`,
          status: 'open',
          call_log_id: call_log_id,
        });
        console.log(`[processTranscript] ⚠️ Auto-complaint created for DID ${callLog.caller_id} — do_not_call detected`);
      } catch (complaintErr) {
        console.error('[processTranscript] Failed to create auto-complaint:', complaintErr.message);
      }
    }

    console.log(`[processTranscript] Tier: ${qualificationTier} — ${qualificationReason}`);

    // ===== DETECT NON-ANSWER / VOICEMAIL CALLS (wide scope) =====
    // Voicemail greetings get transcribed but are NOT real conversations.
    // We must skip all activity creation, sequence enrollment, and action extraction for these.
    const isNonAnswer = !transcript || transcript.length < 100 || 
      ['no_answer', 'failed'].includes(callLog.status) ||
      leadStatus === 'no_answer' || leadStatus === 'voicemail';
    
    if (isNonAnswer) {
      console.log(`[processTranscript] ⚠️ NON-ANSWER/VOICEMAIL detected (transcript: ${(transcript || '').length} chars, status: ${callLog.status}, leadStatus: ${leadStatus}) — skipping all activity creation & post-call triggers`);
    }

    // Update lead with status, score, sentiment, tier, and intent signals
    // CRITICAL: Only update score/status if this call had a real conversation.
    // If call was not answered or had no meaningful transcript, preserve existing lead score & status.
    if (callLog.lead_id) {
      let existingLead = {};
      try { existingLead = await base44.entities.Lead.get(callLog.lead_id); } catch (_) {}
      
      const updatedEngagement = (existingLead.engagement_count || 0) + 1;
      const existingTags = existingLead.tags || [];
      const mergedTags = [...new Set([...existingTags, ...keyKeywords.slice(0, 10)])];
      
      // For non-answer calls: only update engagement metadata, NEVER overwrite score/status/tier
      if (isNonAnswer) {
        const nonAnswerUpdate = {
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString(),
          engagement_count: updatedEngagement,
          tags: mergedTags,
        };
        await base44.entities.Lead.update(callLog.lead_id, nonAnswerUpdate);
        console.log(`[processTranscript] Lead ${callLog.lead_id} — non-answer call, preserved existing score (${existingLead.score}) & status (${existingLead.status})`);
      } else {
        // Real conversation: only upgrade score, never downgrade from a higher previous score
        // unless the lead explicitly said "not interested" or "do not call"
        const existingScore = existingLead.score || 0;
        const existingStatus = existingLead.status || 'new';
        
        // Determine if we should downgrade
        const positiveStatuses = ['interested', 'converted', 'callback'];
        const negativeStatuses = ['not_interested', 'do_not_call'];
        const wasPositive = positiveStatuses.includes(existingStatus);
        const isNowNegative = negativeStatuses.includes(leadStatus);
        const isNowNeutral = ['contacted', 'new'].includes(leadStatus);
        
        // Only allow downgrade if lead explicitly expressed negativity
        let finalScore = leadScore;
        let finalStatus = leadStatus;
        let finalTier = qualificationTier;
        let finalReason = qualificationReason;
        let finalSentiment = sentiment;
        let finalIntents = intentSignals;
        let finalBreakdown = scoreBreakdown;
        
        if (wasPositive && isNowNeutral && existingScore > leadScore) {
          // Lead was "interested" before, new call is just "contacted" with lower score
          // → Preserve the higher previous state
          finalScore = existingScore;
          finalStatus = existingStatus;
          finalTier = existingLead.qualification_tier || qualificationTier;
          finalReason = existingLead.qualification_reason || qualificationReason;
          finalSentiment = existingLead.sentiment || sentiment;
          finalIntents = existingLead.intent_signals || intentSignals;
          finalBreakdown = existingLead.score_breakdown || scoreBreakdown;
          console.log(`[processTranscript] Lead ${callLog.lead_id} — preserving higher previous score ${existingScore} (was ${existingStatus}), new call scored ${leadScore} (${leadStatus})`);
        } else if (wasPositive && isNowNegative) {
          // Lead explicitly said "not interested" or "do not call" — allow downgrade
          console.log(`[processTranscript] Lead ${callLog.lead_id} — downgrading: was ${existingStatus}(${existingScore}), now ${leadStatus}(${leadScore}) — explicit negative response`);
        }

        await base44.entities.Lead.update(callLog.lead_id, {
          status: finalStatus,
          score: finalScore,
          sentiment: finalSentiment,
          intent_signals: finalIntents,
          score_breakdown: finalBreakdown,
          qualification_tier: finalTier,
          qualification_reason: finalReason,
          tags: mergedTags,
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString(),
          engagement_count: updatedEngagement,
          notes: `[Score: ${finalScore}/100 | ${finalSentiment} | ${finalTier}] ${summary.substring(0, 300)}`
        });
        console.log(`[processTranscript] Lead ${callLog.lead_id} updated — Score: ${finalScore}, Tier: ${finalTier}, Status: ${finalStatus}`);
      }
    }

    // ===== IST TIMEZONE HELPER =====
    // Server runs in UTC. IST = UTC + 5:30. To schedule at 10:00 IST, set UTC to 04:30.
    function setISTHours(date, hours, minutes = 0) {
      const utcHours = hours - 5;
      const utcMinutes = minutes - 30;
      date.setUTCHours(utcHours, utcMinutes, 0, 0);
      // Handle underflow (negative minutes/hours)
      if (utcMinutes < 0) { date.setUTCHours(utcHours - 1, utcMinutes + 60, 0, 0); }
      return date;
    }

    // ===== CREATE AI-DRIVEN ACTIVITIES BASED ON TIER =====
    // SKIP entirely for non-answer/voicemail calls
    let leadForActivities = null;
    if (callLog.lead_id && !isNonAnswer) {
      try { leadForActivities = await base44.entities.Lead.get(callLog.lead_id); } catch (_) {}
    }

    if (callLog.lead_id && qualificationTier && leadStatus !== 'do_not_call' && !isNonAnswer) {
      const actionsCreated = [];

      if (qualificationTier === 'hot') {
        const dueDate = new Date();
        dueDate.setHours(dueDate.getHours() + 4);
        await base44.entities.Activity.create({
          client_id: callLog.client_id, lead_id: callLog.lead_id, call_log_id: call_log_id,
          type: 'task',
          title: `🔥 HOT LEAD: Call ${leadForActivities?.name || callLog.callee_number} immediately`,
          description: `AI Score: ${leadScore}/100 | Tier: HOT | ${qualificationReason}\n\nSummary: ${summary}\nSignals: ${intentSignals.join(', ')}`,
          scheduled_date: new Date().toISOString(), due_date: dueDate.toISOString(),
          status: 'scheduled', priority: 'high', auto_created: true
        });
        actionsCreated.push('hot_task');

        if (intentSignals.includes('demo_request')) {
          const demoDate = new Date();
          demoDate.setDate(demoDate.getDate() + 1);
          if (demoDate.getDay() === 0) demoDate.setDate(demoDate.getDate() + 1);
          if (demoDate.getDay() === 6) demoDate.setDate(demoDate.getDate() + 2);
          setISTHours(demoDate, 10, 0); // 10:00 AM IST
          await base44.entities.Activity.create({
            client_id: callLog.client_id, lead_id: callLog.lead_id, call_log_id: call_log_id,
            type: 'demo',
            title: `Schedule demo for ${leadForActivities?.name || callLog.callee_number}`,
            description: `Lead requested a demo. Score: ${leadScore}/100.`,
            scheduled_date: demoDate.toISOString(), due_date: demoDate.toISOString(),
            status: 'scheduled', priority: 'high', auto_created: true
          });
          actionsCreated.push('demo_scheduled');
        }
      }

      if (qualificationTier === 'warm') {
        const followupDate = new Date();
        followupDate.setDate(followupDate.getDate() + 1);
        if (followupDate.getDay() === 0) followupDate.setDate(followupDate.getDate() + 1);
        if (followupDate.getDay() === 6) followupDate.setDate(followupDate.getDate() + 2);
        setISTHours(followupDate, 11, 0); // 11:00 AM IST
        await base44.entities.Activity.create({
          client_id: callLog.client_id, lead_id: callLog.lead_id, call_log_id: call_log_id,
          type: 'followup',
          title: `Follow up with warm lead: ${leadForActivities?.name || callLog.callee_number}`,
          description: `AI Score: ${leadScore}/100 | Tier: WARM | ${qualificationReason}\nSummary: ${summary}`,
          scheduled_date: followupDate.toISOString(), due_date: followupDate.toISOString(),
          status: 'scheduled', priority: 'medium', auto_created: true
        });
        actionsCreated.push('warm_followup');
      }

      if (qualificationTier === 'nurture') {
        const reengageDate = new Date();
        reengageDate.setDate(reengageDate.getDate() + 5);
        setISTHours(reengageDate, 11, 0); // 11:00 AM IST
        await base44.entities.Activity.create({
          client_id: callLog.client_id, lead_id: callLog.lead_id, call_log_id: call_log_id,
          type: 'followup',
          title: `Nurture lead: ${leadForActivities?.name || callLog.callee_number}`,
          description: `AI Score: ${leadScore}/100 | Tier: NURTURE | ${qualificationReason}`,
          scheduled_date: reengageDate.toISOString(),
          status: 'scheduled', priority: 'low', auto_created: true
        });
        actionsCreated.push('nurture_followup');
      }

      if (actionsCreated.length > 0) {
        const nextFollowup = qualificationTier === 'hot' ? new Date(Date.now() + 4 * 3600000) :
          qualificationTier === 'warm' ? new Date(Date.now() + 24 * 3600000) :
          new Date(Date.now() + 5 * 86400000);
        await base44.entities.Lead.update(callLog.lead_id, {
          next_followup_date: nextFollowup.toISOString()
        });
        console.log(`[processTranscript] AI activities created: ${actionsCreated.join(', ')}`);
      }
    }

    // Auto-enroll into AI email sequence based on tier
    // SKIP for non-answer/voicemail calls
    if (callLog.lead_id && qualificationTier && !['disqualified'].includes(qualificationTier) && !isNonAnswer) {
      try {
        const enrollResult = await base44.functions.invoke('autoEnrollSequence', {
          lead_id: callLog.lead_id,
          client_id: callLog.client_id,
          qualification_tier: qualificationTier,
          call_outcome: leadStatus,
          call_summary: summary.substring(0, 500),
          call_topics: keyKeywords.slice(0, 10),
          objections: [],
          intent_signals: intentSignals,
          ai_score: leadScore
        });
        if (enrollResult?.enrolled) {
          console.log(`[processTranscript] ✉️ Auto-enrolled in sequence: ${enrollResult.sequence_name}`);
        }
      } catch (seqErr) {
        console.error(`[processTranscript] Auto-enroll failed: ${seqErr.message}`);
      }
    }

    // Trigger post-call follow-up emails & RCS — SKIP for non-answer/voicemail
    if (!isNonAnswer) {
      try {
        await base44.functions.invoke('postCallFollowup', {
          call_log_id: call_log_id
        });
        console.log('[processTranscript] Post-call follow-up triggered');
      } catch (followupErr) {
        console.error('[processTranscript] Post-call follow-up error:', followupErr.message);
      }

      // Trigger post-call action extraction (notes, scheduled activities, emails)
      try {
        await base44.functions.invoke('postCallActionExtractor', {
          call_log_id: call_log_id
        });
        console.log('[processTranscript] Post-call action extraction triggered');
      } catch (actionErr) {
        console.error('[processTranscript] Post-call action extraction error:', actionErr.message);
      }
    }

    return c.json({ data: { 
      success: true,
      transcript,
      summary,
      lead_status: leadStatus,
      lead_score: leadScore,
      sentiment,
      intent_signals: intentSignals,
      score_breakdown: scoreBreakdown,
      qualification_tier: qualificationTier,
      qualification_reason: qualificationReason
    } });

  } catch (error) {
    console.error('Error processing transcript:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};