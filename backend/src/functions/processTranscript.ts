import { client } from "../db/index.ts";
import { postCallActionExtractorCore } from "./postCallActionExtractor.ts";

export async function processTranscriptCore(call_log_id: string, recording_url: string) {
  try {
    const callLogRes = await (client as any).queryObject('SELECT * FROM calllog WHERE id = $1', [call_log_id]);
    const callLog = callLogRes.rows[0];
    if (!callLog) {
      return { success: false, error: 'Call log not found' };
    }

    let transcript = callLog.transcript || '';
    
    if (!transcript && !recording_url) {
      return { success: false, error: 'Missing recording_url and no existing transcript' };
    }

    if (!transcript && recording_url) {
      try {
        new URL(recording_url);
      } catch (_) {
        return { success: false, error: 'Invalid recording URL' };
      }
    }

    if (!transcript) {
      const audioResponse = await fetch(recording_url);
      if (!audioResponse.ok) {
        console.error('Recording download failed:', audioResponse.status);
        return { success: false, error: 'Failed to download recording' };
      }
      const audioBuffer = await audioResponse.arrayBuffer();
      console.log(`[processTranscript] Downloaded recording: ${audioBuffer.byteLength} bytes`);

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
        headers: {
          'api-key': Deno.env.get('AZURE_OPENAI_KEY') || ''
        },
        body: formData
      });

      if (!sttResponse.ok) {
        const errText = await sttResponse.text();
        console.error(`Azure gpt-4o-transcribe failed (${sttResponse.status}):`, errText);
        return { success: false, error: 'Speech to text failed', detail: errText };
      }

      transcript = await sttResponse.text();
      console.log(`[processTranscript] Transcript (${transcript.length} chars): ${transcript.substring(0, 200)}`);
    } else {
      console.log(`[processTranscript] Found existing transcript (${transcript.length} chars). Skipping STT.`);
    }

    let baseUrlRaw = Deno.env.get('AZURE_OPENAI_ENDPOINT') || '';
    baseUrlRaw = baseUrlRaw.replace(/\/+$/, '');
    const _oi = baseUrlRaw.indexOf('/openai/');
    if (_oi > 0) baseUrlRaw = baseUrlRaw.substring(0, _oi);

    const analysisResponse = await fetch(
      `${baseUrlRaw}/openai/v1/responses`,
      {
        method: 'POST',
        headers: {
          'api-key': Deno.env.get('AZURE_OPENAI_KEY') || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: Deno.env.get('AZURE_OPENAI_DEPLOYMENT'),
          instructions: `You are an expert sales call analyst AI. Analyze call transcripts to extract:
1. A concise summary of the conversation
2. The current lead status
3. Sentiment analysis
4. Intent signals (buying signals, objections, questions)
5. A lead score from 0-100 based on conversion likelihood

SCORING CRITERIA (total 100):
- Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
- Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, competitor_mention=+5, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10, referral=+8 (cap at 30)
- Engagement (0-25): short_answers_only=5, asked_questions=15, extended_conversation=20, highly_engaged=25
- Keywords (0-20): positive keywords like "interested","sign up","let's go","sounds good","when can we start"=+5 each (cap 20); negative keywords like "not interested","too expensive","no need","don't call"=-5 each (min 0)

Respond ONLY in valid JSON with this exact structure.`,
          input: `Analyze this sales call transcript:\n\n${transcript}\n\nReturn JSON with: summary (string), lead_status (one of: interested, not_interested, callback, converted, contacted), sentiment (one of: very_positive, positive, neutral, negative, very_negative), intent_signals (array of strings like: pricing_inquiry, demo_request, competitor_mention, budget_confirmed, timeline_mentioned, decision_maker, referral, objection_price, objection_timing, objection_need, follow_up_requested), lead_score (number 0-100), score_breakdown (object with: sentiment_score number, intent_score number, engagement_score number, keyword_score number, reasoning string), key_keywords (array of important words/phrases from the conversation)`,
          max_output_tokens: 800,
          text: { format: { type: 'json_object' } }
        })
      }
    );

    let analysisData: any = {};
    let rawContent = '{}';
    if (!analysisResponse.ok) {
      const errTxt = await analysisResponse.text();
      console.error("[processTranscript] Azure OpenAI analysis failed:", analysisResponse.status, errTxt);
    } else {
      analysisData = await analysisResponse.json();
      rawContent = analysisData.output_text || '';
      if (!rawContent && Array.isArray(analysisData.output)) {
        for (const item of analysisData.output) {
          const parts = item?.content || [];
          for (const p of parts) {
            if (p.text) rawContent += p.text;
          }
        }
      }
    }
    
    const cleanContent = rawContent.replace(/^```(?:json)?\n?/i, '').replace(/```$/i, '').trim();
    let analysis;
    try {
      analysis = JSON.parse(cleanContent);
    } catch (_) {
      analysis = { summary: cleanContent, lead_status: 'contacted', sentiment: 'neutral', lead_score: 0, intent_signals: [], score_breakdown: {}, key_keywords: [] };
    }

    const summary = analysis.summary || 'Analysis not available';
    const leadStatus = analysis.lead_status || 'contacted';
    const sentiment = analysis.sentiment || 'neutral';
    const leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
    const intentSignals = analysis.intent_signals || [];
    const scoreBreakdown = analysis.score_breakdown || {};
    const keyKeywords = analysis.key_keywords || [];

    await (client as any).queryObject(`
      UPDATE calllog 
      SET status = 'completed', 
          transcript = $2, 
          conversation_summary = $3, 
          lead_status_updated = $4,
          updated_at = NOW()
      WHERE id = $1
    `, [call_log_id, transcript, `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Signals: ${intentSignals.join(', ')}`, leadStatus]);

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

    if (leadStatus === 'do_not_call' && callLog.caller_id) {
      try {
        await (client as any).queryObject(`
          INSERT INTO complaintlog (id, created_at, did_number, client_id, agent_id, complainant_number, complaint_type, complaint_source, description, status, call_log_id)
          VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [callLog.caller_id, callLog.client_id, callLog.agent_id, callLog.callee_number, 'unsolicited', 'internal', `Auto-detected: Lead explicitly requested "do not call" during AI conversation. Call ID: ${call_log_id}`, 'open', call_log_id]);
      } catch (e) {}
    }

    const isNonAnswer = !transcript || transcript.length < 100 || 
      ['no_answer', 'failed'].includes(callLog.status) ||
      leadStatus === 'no_answer';

    if (callLog.lead_id) {
      let existingLead: any = {};
      try { 
        const leadRes = await (client as any).queryObject('SELECT * FROM lead WHERE id = $1', [callLog.lead_id]);
        if (leadRes.rows.length > 0) existingLead = leadRes.rows[0];
      } catch (_) {}
      
      const updatedEngagement = (existingLead.engagement_count || 0) + 1;
      const existingTags = typeof existingLead.tags === 'string' ? JSON.parse(existingLead.tags) : (existingLead.tags || []);
      const mergedTags = [...new Set([...existingTags, ...keyKeywords.slice(0, 10)])];
      
      if (isNonAnswer) {
        await (client as any).queryObject(`
          UPDATE lead 
          SET last_call_date = $2, 
              last_engagement_date = $3, 
              engagement_count = $4, 
              tags = $5,
              updated_at = NOW()
          WHERE id = $1
        `, [callLog.lead_id, new Date().toISOString(), new Date().toISOString(), updatedEngagement, JSON.stringify(mergedTags)]);
      } else {
        const existingScore = existingLead.score || 0;
        const existingStatus = existingLead.status || 'new';
        
        const positiveStatuses = ['interested', 'converted', 'callback'];
        const negativeStatuses = ['not_interested', 'do_not_call'];
        const wasPositive = positiveStatuses.includes(existingStatus);
        const isNowNeutral = ['contacted', 'new'].includes(leadStatus);
        
        let finalScore = leadScore;
        let finalStatus = leadStatus;
        let finalTier = qualificationTier;
        let finalReason = qualificationReason;
        let finalSentiment = sentiment;
        let finalIntents = intentSignals;
        let finalBreakdown = scoreBreakdown;
        
        if (wasPositive && isNowNeutral && existingScore > leadScore) {
          finalScore = existingScore;
          finalStatus = existingStatus;
          finalTier = existingLead.qualification_tier || qualificationTier;
          finalReason = existingLead.qualification_reason || qualificationReason;
          finalSentiment = existingLead.sentiment || sentiment;
          finalIntents = typeof existingLead.intent_signals === 'string' ? JSON.parse(existingLead.intent_signals) : (existingLead.intent_signals || intentSignals);
          finalBreakdown = typeof existingLead.score_breakdown === 'string' ? JSON.parse(existingLead.score_breakdown) : (existingLead.score_breakdown || scoreBreakdown);
        }

        await (client as any).queryObject(`
          UPDATE lead 
          SET status = $2, 
              score = $3, 
              sentiment = $4, 
              intent_signals = $5, 
              score_breakdown = $6, 
              qualification_tier = $7, 
              qualification_reason = $8, 
              tags = $9, 
              last_call_date = $10, 
              last_engagement_date = $11, 
              engagement_count = $12, 
              notes = $13,
              updated_at = NOW()
          WHERE id = $1
        `, [
          callLog.lead_id, finalStatus, finalScore, finalSentiment, JSON.stringify(finalIntents), JSON.stringify(finalBreakdown), finalTier, finalReason, JSON.stringify(mergedTags), new Date().toISOString(), new Date().toISOString(), updatedEngagement, `[Score: ${finalScore}/100 | ${finalSentiment} | ${finalTier}] ${summary.substring(0, 300)}`
        ]);
      }
    }

    function setISTHours(date: Date, hours: number, minutes = 0) {
      const utcHours = hours - 5;
      const utcMinutes = minutes - 30;
      date.setUTCHours(utcHours, utcMinutes, 0, 0);
      if (utcMinutes < 0) { date.setUTCHours(utcHours - 1, utcMinutes + 60, 0, 0); }
      return date;
    }

    let leadForActivities: any = null;
    if (callLog.lead_id && !isNonAnswer) {
      try { 
        const leadRes = await (client as any).queryObject('SELECT * FROM lead WHERE id = $1', [callLog.lead_id]);
        if (leadRes.rows.length > 0) leadForActivities = leadRes.rows[0];
      } catch (_) {}
    }

    if (callLog.lead_id && qualificationTier && leadStatus !== 'do_not_call' && !isNonAnswer) {
      const actionsCreated = [];

      if (qualificationTier === 'hot') {
        const dueDate = new Date();
        dueDate.setHours(dueDate.getHours() + 4);
        await (client as any).queryObject(`
          INSERT INTO activity (id, created_at, client_id, lead_id, call_log_id, type, title, description, scheduled_date, due_date, status, priority, auto_created)
          VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [callLog.client_id, callLog.lead_id, call_log_id, 'task', `🔥 HOT LEAD: Call ${leadForActivities?.name || callLog.callee_number} immediately`, `AI Score: ${leadScore}/100 | Tier: HOT | ${qualificationReason}\n\nSummary: ${summary}\nSignals: ${intentSignals.join(', ')}`, new Date().toISOString(), dueDate.toISOString(), 'scheduled', 'high', true]);
        actionsCreated.push('hot_task');

        if (intentSignals.includes('demo_request')) {
          const demoDate = new Date();
          demoDate.setDate(demoDate.getDate() + 1);
          if (demoDate.getDay() === 0) demoDate.setDate(demoDate.getDate() + 1);
          if (demoDate.getDay() === 6) demoDate.setDate(demoDate.getDate() + 2);
          setISTHours(demoDate, 10, 0);
          await (client as any).queryObject(`
            INSERT INTO activity (id, created_at, client_id, lead_id, call_log_id, type, title, description, scheduled_date, due_date, status, priority, auto_created)
            VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [callLog.client_id, callLog.lead_id, call_log_id, 'demo', `Schedule demo for ${leadForActivities?.name || callLog.callee_number}`, `Lead requested a demo. Score: ${leadScore}/100.`, demoDate.toISOString(), demoDate.toISOString(), 'scheduled', 'high', true]);
          actionsCreated.push('demo_scheduled');
        }
      }

      if (qualificationTier === 'warm') {
        const followupDate = new Date();
        followupDate.setDate(followupDate.getDate() + 1);
        if (followupDate.getDay() === 0) followupDate.setDate(followupDate.getDate() + 1);
        if (followupDate.getDay() === 6) followupDate.setDate(followupDate.getDate() + 2);
        setISTHours(followupDate, 11, 0);
        await (client as any).queryObject(`
          INSERT INTO activity (id, created_at, client_id, lead_id, call_log_id, type, title, description, scheduled_date, due_date, status, priority, auto_created)
          VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [callLog.client_id, callLog.lead_id, call_log_id, 'followup', `Follow up with warm lead: ${leadForActivities?.name || callLog.callee_number}`, `AI Score: ${leadScore}/100 | Tier: WARM | ${qualificationReason}\nSummary: ${summary}`, followupDate.toISOString(), followupDate.toISOString(), 'scheduled', 'medium', true]);
        actionsCreated.push('warm_followup');
      }

      if (qualificationTier === 'nurture') {
        const reengageDate = new Date();
        reengageDate.setDate(reengageDate.getDate() + 5);
        setISTHours(reengageDate, 11, 0);
        await (client as any).queryObject(`
          INSERT INTO activity (id, created_at, client_id, lead_id, call_log_id, type, title, description, scheduled_date, status, priority, auto_created)
          VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [callLog.client_id, callLog.lead_id, call_log_id, 'followup', `Nurture lead: ${leadForActivities?.name || callLog.callee_number}`, `AI Score: ${leadScore}/100 | Tier: NURTURE | ${qualificationReason}`, reengageDate.toISOString(), 'scheduled', 'low', true]);
        actionsCreated.push('nurture_followup');
      }

      if (actionsCreated.length > 0) {
        const nextFollowup = qualificationTier === 'hot' ? new Date(Date.now() + 4 * 3600000) :
          qualificationTier === 'warm' ? new Date(Date.now() + 24 * 3600000) :
          new Date(Date.now() + 5 * 86400000);
        await (client as any).queryObject(`
          UPDATE lead 
          SET next_followup_date = $2,
              updated_at = NOW()
          WHERE id = $1
        `, [callLog.lead_id, nextFollowup.toISOString()]);
      }
    }

    if (!isNonAnswer) {
      try {
        await postCallActionExtractorCore(call_log_id);
      } catch (actionErr) {
        console.error('[processTranscript] Post-call action extraction error:', actionErr);
      }
    }

    return { 
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
    };

  } catch (error: any) {
    console.error('Error processing transcript:', error);
    return { success: false, error: error.message };
  }
}

export default async function processTranscript(c: any) {
  try {
    const payload = await c.req.json();
    const result = await processTranscriptCore(payload.call_log_id, payload.recording_url);
    if (!result.success) return c.json({ data: result }, 400);
    return c.json({ data: result });
  } catch (e: any) {
    return c.json({ data: { success: false, error: e.message } }, 500);
  }
}
