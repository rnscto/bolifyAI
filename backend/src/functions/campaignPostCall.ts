import { base44ORM as base44 } from "../db/orm.ts";
import { processTranscriptCore } from "./processTranscript.ts";
import { postCallActionExtractorCore } from "./postCallActionExtractor.ts";
// We will also invoke executeCampaign to trigger next batch, but let's just make a fetch call or something
// to not mess with executeCampaign.ts for now.
// Better yet, we can do a local fetch to our own server, or just import it if we refactor.
// Let's just do a local fetch to `http://localhost:8000/api/executeCampaign` for simplicity.

export async function campaignPostCallCore(call_log_id: string, campaign_id: string) {
  try {
    const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id, campaign_id });
    if (campaignLeads.length === 0) return { success: true, skipped: 'not_found' };

    const cl = campaignLeads[0];

    if (['completed', 'failed', 'processing'].includes(cl.status)) {
       // Already processed
       return { success: true, skipped: 'already_processed' };
    }

    if (cl.status === 'pending') {
       return { success: true, skipped: 'already_pending_retry' };
    }

    await base44.entities.CampaignLead.update(cl.id, { status: 'processing' });
    
    const callLog = await base44.entities.CallLog.get(call_log_id);
    const callConnected = (callLog.transcript && callLog.transcript.length > 20) || !!callLog.recording_url || (callLog.duration && callLog.duration > 0);

    let outcome = 'neutral';
    let callStatus = 'answered';
    let summary = callLog.conversation_summary || '';

    if (!callConnected && callLog.status === 'no_answer') {
      outcome = 'not_answered';
      callStatus = 'not_answered';
      summary = summary || 'Call was not answered.';
    } else if (!callConnected && callLog.status === 'failed') {
      outcome = 'not_answered';
      callStatus = 'not_answered';
      summary = summary || 'Call failed to connect.';
    }

    await base44.entities.CampaignLead.update(cl.id, {
      status: 'completed',
      outcome,
      call_status: callStatus,
      conversation_summary: summary,
      transcript: callLog.transcript || '',
      call_duration: callLog.duration || 0
    });

    let retryScheduled = false;
    if (outcome === 'not_answered') {
      const campaign = await base44.entities.Campaign.get(campaign_id);
      const rules = campaign?.followup_rules || {};
      if (rules.no_answer_retry !== false) {
        const maxRetries = rules.no_answer_max_retries || 3;
        const currentAttempts = (cl.attempt_count || 0) + 1;
        if (currentAttempts < maxRetries) {
          const retryHours = rules.no_answer_retry_hours || 4;
          await base44.entities.CampaignLead.update(cl.id, {
            status: 'pending', outcome: 'not_answered',
            attempt_count: currentAttempts, call_log_id: null,
            followup_call_date: new Date(Date.now() + retryHours * 3600000).toISOString()
          });
          retryScheduled = true;
        }
      }
    }

    // Trigger next batch inline by making a local request
    try {
      fetch('http://localhost:8000/api/executeCampaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign_id })
      }).catch(err => console.error('Failed to trigger next batch', err));
    } catch (e) {}

    let aiResult: any = {};
    const alreadyAnalyzed = callLog.lead_status_updated && callLog.transcript;

    if (alreadyAnalyzed) {
      const statusToOutcome: any = {
        'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback',
        'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral',
        'do_not_call': 'do_not_call'
      };
      outcome = statusToOutcome[callLog.lead_status_updated] || outcome;
      summary = callLog.conversation_summary || summary;
      await base44.entities.CampaignLead.update(cl.id, { outcome, conversation_summary: summary });
    } else if (outcome !== 'not_answered' && (callLog.transcript || callLog.conversation_summary)) {
        // Run AI Analysis via processTranscriptCore if there is a recording url.
        // If recording URL is missing, we can't do STT, but if transcript is somehow there, we can.
        // Let's rely on processTranscript to do the heavy lifting if possible.
        // But processTranscript handles the entire LLM processing and scoring.
        if (callLog.recording_url) {
            aiResult = await processTranscriptCore(call_log_id, callLog.recording_url);
            if (aiResult.success) {
                outcome = aiResult.lead_status || outcome;
                await base44.entities.CampaignLead.update(cl.id, { outcome, conversation_summary: aiResult.summary || summary });
            }
        }
    } else if (cl.lead_id) {
      if (outcome === 'not_answered') {
        await base44.entities.Lead.update(cl.lead_id, {
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString()
        });
      } else {
        const outcomeToLeadStatus: any = {
          interested: 'interested', not_interested: 'not_interested', callback: 'callback',
          neutral: 'contacted', converted: 'converted', do_not_call: 'do_not_call'
        };
        await base44.entities.Lead.update(cl.lead_id, {
          status: outcomeToLeadStatus[outcome] || 'contacted',
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString()
        });
      }
    }

    // Call Action Extractor
    if (callLog.transcript && callLog.transcript.length > 50 && outcome !== 'not_answered') {
       try {
           await postCallActionExtractorCore(call_log_id);
       } catch (err) {}
    }

    // Update Campaign Stats
    try {
        const statuses = ['completed', 'failed', 'pending', 'calling', 'processing'];
        const allLeads = await base44.entities.CampaignLead.filter({ campaign_id });
        const completed = allLeads.filter((l: any) => l.status === 'completed' || l.status === 'failed');
        const outcomes: any = {};
        completed.forEach((l: any) => {
           outcomes[l.outcome] = (outcomes[l.outcome] || 0) + 1;
        });
        await base44.entities.Campaign.update(campaign_id, {
            calls_completed: completed.length,
            outcomes_summary: outcomes
        });
    } catch (e) {}

    return { success: true, outcome, retryScheduled };

  } catch (error: any) {
    console.error('CampaignPostCall Error:', error);
    return { success: false, error: error.message };
  }
}

export default async function campaignPostCall(c: any) {
  try {
    const payload = await c.req.json();
    const result = await campaignPostCallCore(payload.call_log_id, payload.campaign_id);
    return c.json({ data: result });
  } catch (e: any) {
    return c.json({ data: { success: false, error: e.message } }, 500);
  }
}
