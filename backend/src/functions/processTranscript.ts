import { base44ORM as base44 } from "../db/orm.ts";
import { postCallActionExtractorCore } from "./postCallActionExtractor.ts";

export async function processTranscriptCore(call_log_id: string, recording_url: string) {
  try {
    if (!call_log_id || !recording_url) {
      return { success: false, error: 'Missing required fields' };
    }

    try {
      new URL(recording_url);
    } catch (_) {
      return { success: false, error: 'Invalid recording URL' };
    }

    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return { success: false, error: 'Call log not found' };
    }

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

    const transcript = await sttResponse.text();
    console.log(`[processTranscript] Transcript (${transcript.length} chars): ${transcript.substring(0, 200)}`);

    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const analysisResponse = await fetch(
      `${baseUrl}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`,
      {
        method: 'POST',
        headers: {
          'api-key': Deno.env.get('AZURE_OPENAI_KEY') || '',
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
              content: `Analyze this sales call transcript:\n\n${transcript}\n\nReturn JSON with: summary (string), lead_status (one of: interested, not_interested, callback, converted, contacted), sentiment (one of: very_positive, positive, neutral, negative, very_negative), intent_signals (array of strings like: pricing_inquiry, demo_request, competitor_mention, budget_confirmed, timeline_mentioned, decision_maker, referral, objection_price, objection_timing, objection_need, follow_up_requested), lead_score (number 0-100), score_breakdown (object with: sentiment_score number, intent_score number, engagement_score number, keyword_score number, reasoning string), key_keywords (array of important words/phrases from the conversation)`
            }
          ],
          max_completion_tokens: 800,
          response_format: { type: "json_object" }
        })
      }
    );

    let analysisData: any = {};
    if (!analysisResponse.ok) {
      analysisData = { choices: [{ message: { content: '{}' } }] };
    } else {
      analysisData = await analysisResponse.json();
    }
    const rawContent = analysisData.choices?.[0]?.message?.content || '{}';
    
    let analysis;
    try {
      analysis = JSON.parse(rawContent);
    } catch (_) {
      analysis = { summary: rawContent, lead_status: 'contacted', sentiment: 'neutral', lead_score: 0, intent_signals: [], score_breakdown: {}, key_keywords: [] };
    }

    const summary = analysis.summary || 'Analysis not available';
    const leadStatus = analysis.lead_status || 'contacted';
    const sentiment = analysis.sentiment || 'neutral';
    const leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
    const intentSignals = analysis.intent_signals || [];
    const scoreBreakdown = analysis.score_breakdown || {};
    const keyKeywords = analysis.key_keywords || [];

    await base44.entities.CallLog.update(call_log_id, {
      status: 'completed',
      transcript,
      conversation_summary: `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Signals: ${intentSignals.join(', ')}`,
      lead_status_updated: leadStatus
    });

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
      } catch (e) {}
    }

    const isNonAnswer = !transcript || transcript.length < 100 || 
      ['no_answer', 'failed'].includes(callLog.status) ||
      leadStatus === 'no_answer';

    if (callLog.lead_id) {
      let existingLead: any = {};
      try { existingLead = await base44.entities.Lead.get(callLog.lead_id); } catch (_) {}
      
      const updatedEngagement = (existingLead.engagement_count || 0) + 1;
      const existingTags = existingLead.tags || [];
      const mergedTags = [...new Set([...existingTags, ...keyKeywords.slice(0, 10)])];
      
      if (isNonAnswer) {
        await base44.entities.Lead.update(callLog.lead_id, {
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString(),
          engagement_count: updatedEngagement,
          tags: mergedTags,
        });
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
          finalIntents = existingLead.intent_signals || intentSignals;
          finalBreakdown = existingLead.score_breakdown || scoreBreakdown;
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
          setISTHours(demoDate, 10, 0);
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
        setISTHours(followupDate, 11, 0);
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
        setISTHours(reengageDate, 11, 0);
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
