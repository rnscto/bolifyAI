import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    // Inject Base44-App-Id if missing (called from other functions/webhooks)
    let base44Req = req;
    if (!req.headers.get('Base44-App-Id')) {
      const appId = Deno.env.get('BASE44_APP_ID');
      if (appId) {
        const newHeaders = new Headers(req.headers);
        newHeaders.set('Base44-App-Id', appId);
        base44Req = new Request(req.url, {
          method: req.method,
          headers: newHeaders,
          body: req.body,
          duplex: 'half'
        });
      }
    }
    const base44 = createClientFromRequest(base44Req);

    const { call_log_id, recording_url } = await req.json();

    if (!call_log_id || !recording_url) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate recording_url is a proper URL
    try {
      new URL(recording_url);
    } catch (_) {
      return Response.json({ error: 'Invalid recording URL' }, { status: 400 });
    }

    const callLog = await base44.asServiceRole.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return Response.json({ error: 'Call log not found' }, { status: 404 });
    }

    // Download audio file
    const audioResponse = await fetch(recording_url);
    const audioBlob = await audioResponse.blob();

    // Azure Speech to Text
    const sttResponse = await fetch(Deno.env.get('AZURE_SPEECH_ENDPOINT'), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
        'Content-Type': 'audio/wav'
      },
      body: audioBlob
    });

    if (!sttResponse.ok) {
      console.error('STT failed:', await sttResponse.text());
      return Response.json({ error: 'Speech to text failed' }, { status: 500 });
    }

    const sttData = await sttResponse.json();
    const transcript = sttData.DisplayText || sttData.NBest?.[0]?.Display || '';

    // Use Azure OpenAI to analyze conversation + score lead
    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const analysisResponse = await fetch(
      `${baseUrl}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`,
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
              content: `Analyze this sales call transcript:\n\n${transcript}\n\nReturn JSON with: summary (string), lead_status (one of: interested, not_interested, callback, converted, contacted), sentiment (one of: very_positive, positive, neutral, negative, very_negative), intent_signals (array of strings like: pricing_inquiry, demo_request, competitor_mention, budget_confirmed, timeline_mentioned, decision_maker, referral, objection_price, objection_timing, objection_need, follow_up_requested), lead_score (number 0-100), score_breakdown (object with: sentiment_score number, intent_score number, engagement_score number, keyword_score number, reasoning string), key_keywords (array of important words/phrases from the conversation)`
            }
          ],
          max_tokens: 800,
          temperature: 0.2,
          response_format: { type: "json_object" }
        })
      }
    );

    if (!analysisResponse.ok) {
      console.error('OpenAI analysis failed:', await analysisResponse.text());
    }

    const analysisData = await analysisResponse.json();
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
    await base44.asServiceRole.entities.CallLog.update(call_log_id, {
      status: 'completed',
      transcript,
      conversation_summary: `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Signals: ${intentSignals.join(', ')}`,
      lead_status_updated: leadStatus
    });

    // Update lead with status, score, sentiment, and intent signals
    if (callLog.lead_id) {
      // Get existing lead to merge engagement count
      let existingLead = {};
      try { existingLead = await base44.asServiceRole.entities.Lead.get(callLog.lead_id); } catch (_) {}
      
      const updatedEngagement = (existingLead.engagement_count || 0) + 1;
      // Merge existing tags with new keywords (deduplicate)
      const existingTags = existingLead.tags || [];
      const mergedTags = [...new Set([...existingTags, ...keyKeywords.slice(0, 10)])];

      await base44.asServiceRole.entities.Lead.update(callLog.lead_id, {
        status: leadStatus,
        score: leadScore,
        sentiment: sentiment,
        intent_signals: intentSignals,
        score_breakdown: scoreBreakdown,
        tags: mergedTags,
        last_call_date: new Date().toISOString(),
        last_engagement_date: new Date().toISOString(),
        engagement_count: updatedEngagement,
        notes: `[Score: ${leadScore}/100 | ${sentiment}] ${summary.substring(0, 300)}`
      });
      console.log(`[processTranscript] Lead ${callLog.lead_id} updated — Score: ${leadScore}, Sentiment: ${sentiment}`);
    }

    // Trigger post-call follow-up emails & RCS
    try {
      await base44.asServiceRole.functions.invoke('postCallFollowup', {
        call_log_id: call_log_id
      });
      console.log('[processTranscript] Post-call follow-up triggered');
    } catch (followupErr) {
      console.error('[processTranscript] Post-call follow-up error:', followupErr.message);
    }

    return Response.json({ 
      success: true,
      transcript,
      summary,
      lead_status: leadStatus,
      lead_score: leadScore,
      sentiment,
      intent_signals: intentSignals,
      score_breakdown: scoreBreakdown
    });

  } catch (error) {
    console.error('Error processing transcript:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});