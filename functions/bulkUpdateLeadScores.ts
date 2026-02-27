import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const svc = base44.asServiceRole;
    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

    if (!baseUrl || !deployment || !apiKey) {
      return Response.json({ error: 'Missing Azure OpenAI credentials' }, { status: 500 });
    }

    // Get all completed call logs with transcripts
    const allCallLogs = await svc.entities.CallLog.filter({ status: 'completed' }, '-created_date', 100);
    const callLogsWithTranscripts = allCallLogs.filter(cl => cl.transcript && cl.transcript.trim().length > 30);

    console.log(`[bulkUpdate] Found ${callLogsWithTranscripts.length} call logs with transcripts out of ${allCallLogs.length} total`);

    const results = {
      total_processed: 0,
      leads_updated: 0,
      campaign_leads_updated: 0,
      errors: [],
      details: []
    };

    for (const callLog of callLogsWithTranscripts) {
      try {
        const transcript = callLog.transcript;
        const leadId = callLog.lead_id;

        // Run AI analysis
        const analysisResponse = await fetch(
          `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
          {
            method: 'POST',
            headers: {
              'api-key': apiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messages: [
                {
                  role: 'system',
                  content: `You are an expert sales call analyst AI. Analyze call transcripts to extract:
1. Lead status classification
2. Sentiment analysis
3. Intent signals (buying signals, objections, questions)
4. A lead score from 0-100 based on conversion likelihood

SCORING CRITERIA (total 100):
- Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
- Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, competitor_mention=+5, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10, referral=+8 (cap at 30)
- Engagement (0-25): short_answers_only=5, asked_questions=15, extended_conversation=20, highly_engaged=25
- Keywords (0-20): positive keywords like "interested","sign up","let's go","sounds good","when can we start"=+5 each (cap 20); negative like "not interested","too expensive"=-5 each (min 0)

Respond ONLY in valid JSON.`
                },
                {
                  role: 'user',
                  content: `Analyze this sales call transcript:\n\n${transcript}\n\nReturn JSON with: lead_status (one of: interested, not_interested, callback, converted, contacted), sentiment (one of: very_positive, positive, neutral, negative, very_negative), intent_signals (array of strings), lead_score (number 0-100), score_breakdown (object with: sentiment_score, intent_score, engagement_score, keyword_score, reasoning), key_keywords (array of strings), qualification_tier (one of: hot, warm, nurture, cold, disqualified), qualification_reason (string)`
                }
              ],
              max_completion_tokens: 700,
              temperature: 0.2,
              response_format: { type: "json_object" }
            })
          }
        );

        let analysis = {};
        if (analysisResponse.ok) {
          const analysisData = await analysisResponse.json();
          const rawContent = analysisData.choices?.[0]?.message?.content || '{}';
          try { analysis = JSON.parse(rawContent); } catch (_) { analysis = {}; }
        } else {
          const errText = await analysisResponse.text();
          console.error(`[bulkUpdate] AI analysis failed for ${callLog.id}: ${errText}`);
          results.errors.push({ call_log_id: callLog.id, error: 'AI analysis failed' });
          continue;
        }

        const leadStatus = analysis.lead_status || 'contacted';
        const sentiment = analysis.sentiment || 'neutral';
        const leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
        const intentSignals = analysis.intent_signals || [];
        const scoreBreakdown = analysis.score_breakdown || {};
        const keyKeywords = analysis.key_keywords || [];
        const qualificationTier = analysis.qualification_tier || 'cold';
        const qualificationReason = analysis.qualification_reason || '';

        // Update the CallLog with lead_status_updated
        await svc.entities.CallLog.update(callLog.id, {
          lead_status_updated: leadStatus
        });

        // Update the Lead
        if (leadId && leadId !== 'unknown') {
          try {
            const existingLead = await svc.entities.Lead.get(leadId);
            const existingTags = existingLead.tags || [];
            const mergedTags = [...new Set([...existingTags, ...keyKeywords.slice(0, 10)])];
            const updatedEngagement = (existingLead.engagement_count || 0) > 0 ? existingLead.engagement_count : 1;

            // Generate summary from transcript
            let summary = callLog.conversation_summary || '';
            if (!summary && transcript.length > 30) {
              summary = transcript.substring(0, 300);
            }

            await svc.entities.Lead.update(leadId, {
              status: leadStatus,
              score: leadScore,
              sentiment: sentiment,
              intent_signals: intentSignals,
              score_breakdown: scoreBreakdown,
              qualification_tier: qualificationTier,
              qualification_reason: qualificationReason,
              tags: mergedTags,
              last_call_date: callLog.call_start_time || existingLead.last_call_date,
              last_engagement_date: callLog.call_start_time || existingLead.last_engagement_date,
              engagement_count: updatedEngagement,
              notes: `[${(callLog.call_start_time || new Date().toISOString()).split('T')[0]}] [Score: ${leadScore}/100 | ${sentiment}] ${summary.substring(0, 300)}`
            });

            results.leads_updated++;
            results.details.push({
              lead_id: leadId,
              lead_name: existingLead.name,
              old_status: existingLead.status,
              new_status: leadStatus,
              score: leadScore,
              sentiment: sentiment,
              tier: qualificationTier
            });

            console.log(`[bulkUpdate] Lead ${existingLead.name} (${leadId}): ${existingLead.status} → ${leadStatus}, Score: ${leadScore}, Tier: ${qualificationTier}`);
          } catch (leadErr) {
            console.error(`[bulkUpdate] Lead update failed for ${leadId}: ${leadErr.message}`);
            results.errors.push({ lead_id: leadId, error: leadErr.message });
          }
        }

        // Check if this call is from a campaign and update CampaignLead
        if (callLog.call_sid?.startsWith('camp_')) {
          try {
            const campaignLeads = await svc.entities.CampaignLead.filter({ call_log_id: callLog.id });
            if (campaignLeads.length > 0) {
              const cl = campaignLeads[0];
              const outcomeMap = {
                'interested': 'interested',
                'not_interested': 'not_interested',
                'callback': 'callback',
                'converted': 'converted',
                'contacted': 'contacted'
              };
              await svc.entities.CampaignLead.update(cl.id, {
                outcome: outcomeMap[leadStatus] || 'contacted',
                status: 'completed',
                conversation_summary: callLog.conversation_summary || '',
                transcript: transcript,
                call_duration: callLog.duration || 0
              });
              results.campaign_leads_updated++;
              console.log(`[bulkUpdate] CampaignLead ${cl.id} updated: outcome=${leadStatus}`);
            }
          } catch (clErr) {
            console.error(`[bulkUpdate] CampaignLead update failed: ${clErr.message}`);
          }
        }

        results.total_processed++;

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));

      } catch (callErr) {
        console.error(`[bulkUpdate] Error processing call ${callLog.id}: ${callErr.message}`);
        results.errors.push({ call_log_id: callLog.id, error: callErr.message });
      }
    }

    // Also trigger postCallFollowup and postCallActionExtractor for the most recent call
    if (callLogsWithTranscripts.length > 0) {
      const mostRecent = callLogsWithTranscripts[0];
      try {
        await svc.functions.invoke('postCallFollowup', { call_log_id: mostRecent.id });
        results.followup_triggered = mostRecent.id;
      } catch (e) {
        console.log(`[bulkUpdate] postCallFollowup trigger skipped: ${e.message}`);
      }
      try {
        await svc.functions.invoke('postCallActionExtractor', { call_log_id: mostRecent.id });
        results.actions_triggered = mostRecent.id;
      } catch (e) {
        console.log(`[bulkUpdate] postCallActionExtractor trigger skipped: ${e.message}`);
      }
    }

    console.log(`[bulkUpdate] Complete: ${results.total_processed} processed, ${results.leads_updated} leads updated, ${results.campaign_leads_updated} campaign leads updated, ${results.errors.length} errors`);

    return Response.json({
      success: true,
      ...results
    });

  } catch (error) {
    console.error('[bulkUpdate] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});