import { createClient } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });
    const payload = await req.json();
    const { event, data, old_data } = payload;

    if (!event || event.entity_name !== 'CallLog') {
      return Response.json({ success: true, skipped: 'not_call_log' });
    }

    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    if (!terminalStatuses.includes(data.status)) {
      return Response.json({ success: true, skipped: 'not_terminal' });
    }

    const callLogId = event.entity_id;
    const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: callLogId });
    if (campaignLeads.length === 0) {
      return Response.json({ success: true, skipped: 'not_campaign_call' });
    }

    const campaignLead = campaignLeads[0];
    if (['completed', 'failed'].includes(campaignLead.status)) {
      // Already processed — but still check if next batch needs triggering
      await triggerNextBatch(base44, campaignLead.campaign_id);
      return Response.json({ success: true, skipped: 'already_processed', next_batch_checked: true });
    }

    const callLog = data;
    const campaignId = campaignLead.campaign_id;
    console.log(`[campaignPostCall] Processing call ${callLogId} for campaign ${campaignId}`);

    // =====================================================
    // STEP 1: FAST — Determine basic outcome (no LLM)
    // =====================================================
    let outcome = 'contacted';
    let summary = callLog.conversation_summary || '';

    if (callLog.status === 'no_answer') {
      outcome = 'no_answer';
      summary = summary || 'Call was not answered.';
    } else if (callLog.status === 'failed') {
      outcome = 'no_answer';
      summary = summary || 'Call failed to connect.';
    } else if (!callLog.transcript && !callLog.conversation_summary) {
      outcome = 'contacted';
      summary = 'Call connected but no transcript captured.';
    }
    // If there IS a transcript, we'll analyze with LLM later but use 'contacted' for now

    // =====================================================
    // STEP 2: FAST — Mark campaign lead as completed immediately
    // =====================================================
    await base44.entities.CampaignLead.update(campaignLead.id, {
      status: 'completed',
      outcome: outcome,
      conversation_summary: summary,
      transcript: callLog.transcript || '',
      call_duration: callLog.duration || 0
    });
    console.log(`[campaignPostCall] Lead ${campaignLead.lead_name} marked completed: ${outcome}`);

    // =====================================================
    // STEP 3: FAST — Handle no-answer retry (before next batch)
    // =====================================================
    let retryScheduled = false;
    if (outcome === 'no_answer') {
      const campaign = await base44.entities.Campaign.get(campaignId);
      const rules = campaign?.followup_rules || {};
      if (rules.no_answer_retry !== false) {
        const maxRetries = rules.no_answer_max_retries || 3;
        const currentAttempts = (campaignLead.attempt_count || 0) + 1;
        if (currentAttempts < maxRetries) {
          const retryHours = rules.no_answer_retry_hours || 4;
          await base44.entities.CampaignLead.update(campaignLead.id, {
            status: 'pending', outcome: 'no_answer',
            attempt_count: currentAttempts, call_log_id: null,
            followup_call_date: new Date(Date.now() + retryHours * 3600000).toISOString()
          });
          console.log(`[campaignPostCall] No-answer retry ${currentAttempts}/${maxRetries} queued`);
          retryScheduled = true;
        }
      }
    }

    // =====================================================
    // STEP 4: FAST — Trigger next batch IMMEDIATELY
    // This is the critical fix — don't wait for AI analysis
    // =====================================================
    const nextBatchResult = await triggerNextBatch(base44, campaignId);
    console.log(`[campaignPostCall] Next batch: ${JSON.stringify(nextBatchResult)}`);

    // =====================================================
    // STEP 5: SLOW — AI analysis, scoring, emails, activities
    // This runs AFTER next batch is already triggered.
    // NOTE: streamAudio.saveCallRecord now does AI analysis + lead scoring.
    // If transcript & lead_status_updated already present, skip duplicate LLM calls.
    // =====================================================
    let aiResult = {};
    const alreadyAnalyzed = callLog.lead_status_updated && callLog.transcript;
    
    if (alreadyAnalyzed) {
      // streamAudio already did AI analysis — use its results for follow-up actions only
      outcome = callLog.lead_status_updated || outcome;
      summary = callLog.conversation_summary || summary;
      await base44.entities.CampaignLead.update(campaignLead.id, { outcome, conversation_summary: summary });
      
      // Still run follow-up emails/activities based on outcome
      aiResult = await doFollowUpActions(base44, callLog, campaignLead, campaignId, outcome, summary);
    } else if (outcome !== 'no_answer' && (callLog.transcript || callLog.conversation_summary)) {
      aiResult = await doAIAnalysis(base44, callLog, campaignLead, campaignId, outcome, summary);
    } else if (campaignLead.lead_id) {
      const leadStatusMap = {
        interested: 'interested', not_interested: 'not_interested', callback: 'callback',
        no_answer: 'callback', converted: 'converted', contacted: 'contacted'
      };
      await base44.entities.Lead.update(campaignLead.lead_id, {
        status: leadStatusMap[outcome] || 'contacted',
        last_call_date: new Date().toISOString(),
        last_engagement_date: new Date().toISOString()
      });
    }

    // Update campaign stats
    await updateCampaignStats(base44, campaignId);

    return Response.json({
      success: true, outcome: aiResult.outcome || outcome,
      email_sent: aiResult.emailSent || false,
      callback_scheduled: aiResult.callbackScheduled || false,
      next_batch: nextBatchResult, retry: retryScheduled
    });

  } catch (error) {
    console.error('[campaignPostCall] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});


// =====================================================
// TRIGGER NEXT BATCH — Lightweight, fast, inline
// =====================================================
async function triggerNextBatch(base44, campaignId) {
  try {
    const campaign = await base44.entities.Campaign.get(campaignId);
    if (!campaign || !['running'].includes(campaign.status)) {
      return { skipped: `campaign_${campaign?.status || 'missing'}` };
    }

    const allLeads = await base44.entities.CampaignLead.filter({ campaign_id: campaignId });
    const pendingLeads = allLeads.filter(l => l.status === 'pending');
    const callingLeads = allLeads.filter(l => l.status === 'calling');
    const maxConcurrent = campaign.max_concurrent_calls || 5;

    // Check completion
    if (pendingLeads.length === 0 && callingLeads.length === 0) {
      const completedCount = allLeads.filter(l => l.status === 'completed').length;
      const failedCount = allLeads.filter(l => l.status === 'failed').length;
      const outcomes = countOutcomes(allLeads);
      await base44.entities.Campaign.update(campaignId, {
        status: 'completed', completed_at: new Date().toISOString(),
        calls_completed: completedCount, calls_failed: failedCount, outcomes_summary: outcomes
      });
      return { completed: true };
    }

    const slotsAvailable = Math.max(0, maxConcurrent - callingLeads.length);
    if (slotsAvailable === 0 || pendingLeads.length === 0) {
      return { waiting: true, pending: pendingLeads.length, calling: callingLeads.length };
    }

    // Fetch agent + DIDs
    const agent = await base44.entities.Agent.get(campaign.agent_id);
    const agentDIDs = (agent?.assigned_dids?.length > 0)
      ? agent.assigned_dids
      : (agent?.assigned_did ? [agent.assigned_did] : []);

    if (!agent || agentDIDs.length === 0) {
      return { error: 'no_agent_dids' };
    }

    // Knowledge base (cache for all calls)
    let kbContent = '';
    if (agent.knowledge_base_ids?.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.entities.KnowledgeBase.get(kbId);
          if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
        } catch (_) {}
      }
    }

    const batch = pendingLeads.slice(0, slotsAvailable);
    let initiated = 0;

    for (let i = 0; i < batch.length; i++) {
      const cl = batch[i];
      try {
        const selectedDID = agentDIDs[i % agentDIDs.length];
        await base44.entities.CampaignLead.update(cl.id, {
          status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
        });

        const cleanPhone = (cl.lead_phone || '').replace(/[^0-9]/g, '');
        const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // Build lead context (fast, non-critical)
        let leadContext = '';
        try {
          const ctxRes = await base44.functions.invoke('buildLeadContext', {
            lead_id: cl.lead_id, client_id: campaign.client_id, phone_number: cl.lead_phone
          });
          if (ctxRes?.context_text) leadContext = ctxRes.context_text;
        } catch (_) {}

        const personalizedPrompt = [
          agent.system_prompt || '',
          campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
          campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
          campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
          campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
          leadContext ? `\n\n--- LEAD CONTEXT ---\n${leadContext}` : ''
        ].filter(Boolean).join('\n');

        const newCallLog = await base44.entities.CallLog.create({
          client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
          call_sid: callSid, caller_id: selectedDID, callee_number: cl.lead_phone,
          direction: 'outbound', status: 'initiated', call_start_time: new Date().toISOString(),
          agent_config_cache: {
            agent_name: agent.name, system_prompt: personalizedPrompt,
            persona: agent.persona || {}, knowledge_base_content: kbContent, lead_context: leadContext
          }
        });

        await base44.entities.CampaignLead.update(cl.id, { call_log_id: newCallLog.id });

        const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: Deno.env.get('SMARTFLO_API_KEY'),
            customer_number: cleanPhone,
            caller_id: selectedDID.replace(/^\+/, ''),
            async: 1
          })
        });

        const smartfloData = await smartfloResp.json();
        if (smartfloResp.ok && smartfloData.success !== false) {
          const newCallSid = smartfloData.call_id || smartfloData.call_sid || callSid;
          await base44.entities.CallLog.update(newCallLog.id, { call_sid: newCallSid, status: 'ringing' });
          initiated++;
          console.log(`[campaignPostCall] ✅ Call initiated: ${cl.lead_name} → ${cleanPhone}`);
        } else {
          await base44.entities.CallLog.update(newCallLog.id, { status: 'failed' });
          await base44.entities.CampaignLead.update(cl.id, {
            status: 'completed', outcome: 'no_answer',
            conversation_summary: `Smartflo error: ${smartfloData.message || 'Unknown'}`
          });
        }

        if (i < batch.length - 1) await new Promise(r => setTimeout(r, 500));
      } catch (callErr) {
        console.error(`[campaignPostCall] Call error for ${cl.lead_name}: ${callErr.message}`);
        await base44.entities.CampaignLead.update(cl.id, {
          status: 'completed', outcome: 'no_answer',
          conversation_summary: `Error: ${callErr.message}`
        });
      }
    }

    return { initiated, batch_size: batch.length, pending_remaining: pendingLeads.length - batch.length };
  } catch (err) {
    console.error(`[campaignPostCall] triggerNextBatch error: ${err.message}`);
    return { error: err.message };
  }
}


// =====================================================
// AI ANALYSIS — Runs after next batch is already triggered
// =====================================================
async function doAIAnalysis(base44, callLog, campaignLead, campaignId, initialOutcome, initialSummary) {
  let outcome = initialOutcome;
  let summary = initialSummary;
  let emailSent = false;
  let callbackScheduled = false;

  // 1. LLM Outcome Analysis
  try {
    const analysis = await base44.integrations.Core.InvokeLLM({
      prompt: `Analyze this sales call and determine the outcome.

TRANSCRIPT:
${callLog.transcript || 'No transcript available'}

SUMMARY:
${callLog.conversation_summary || 'No summary available'}

Determine:
1. outcome: one of "interested", "not_interested", "callback", "no_answer", "converted", "contacted"
2. summary: A brief 2-3 sentence summary.

Rules:
- "interested" = expressed clear interest, asked about pricing/details
- "callback" = asked to be called back later
- "not_interested" = explicitly declined
- "no_answer" = no real conversation happened
- "converted" = agreed to sign up/purchase
- "contacted" = conversation but no clear outcome`,
      response_json_schema: {
        type: "object",
        properties: { outcome: { type: "string" }, summary: { type: "string" } }
      }
    });
    outcome = analysis.outcome || outcome;
    summary = analysis.summary || summary;
  } catch (e) {
    console.error(`[campaignPostCall] LLM outcome analysis failed: ${e.message}`);
  }

  // Update campaign lead with refined outcome
  await base44.entities.CampaignLead.update(campaignLead.id, { outcome, conversation_summary: summary });

  // 2. AI Lead Scoring
  let aiScore = 0, aiSentiment = 'neutral', aiIntentSignals = [], aiScoreBreakdown = {};
  let qualificationTier = 'cold', qualificationReason = '';

  if (campaignLead.lead_id) {
    try {
      const scoringResult = await base44.integrations.Core.InvokeLLM({
        prompt: `Analyze this sales call and score the lead (0-100).

TRANSCRIPT: ${callLog.transcript || 'N/A'}
SUMMARY: ${summary}
OUTCOME: ${outcome}

SCORING (total 100):
- Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
- Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10
- Engagement (0-25): short_answers=5, asked_questions=15, highly_engaged=25
- Keywords (0-20): positive="interested","sign up","sounds good"=+5 each; negative="not interested","too expensive"=-5 each`,
        response_json_schema: {
          type: "object",
          properties: {
            lead_score: { type: "number" }, sentiment: { type: "string" },
            intent_signals: { type: "array", items: { type: "string" } },
            score_breakdown: { type: "object", properties: {
              sentiment_score: { type: "number" }, intent_score: { type: "number" },
              engagement_score: { type: "number" }, keyword_score: { type: "number" }, reasoning: { type: "string" }
            }},
            conversion_probability: { type: "number" },
            objections: { type: "array", items: { type: "string" } },
            recommended_next_action: { type: "string" },
            key_topics: { type: "array", items: { type: "string" } }
          }
        }
      });

      aiScore = Math.min(100, Math.max(0, scoringResult.lead_score || 0));
      aiSentiment = scoringResult.sentiment || 'neutral';
      aiIntentSignals = scoringResult.intent_signals || [];
      aiScoreBreakdown = {
        ...(scoringResult.score_breakdown || {}),
        conversion_probability: scoringResult.conversion_probability || 0,
        objections: scoringResult.objections || [],
        recommended_next_action: scoringResult.recommended_next_action || '',
        key_topics: scoringResult.key_topics || []
      };

      // Determine tier
      const highIntents = ['demo_request', 'budget_confirmed', 'timeline_mentioned', 'decision_maker']
        .filter(s => aiIntentSignals.includes(s));

      if (aiScore >= 75 && ['very_positive', 'positive'].includes(aiSentiment)) {
        qualificationTier = 'hot';
        qualificationReason = `Score ${aiScore}/100, ${aiSentiment}, signals: ${highIntents.join(', ') || 'high engagement'}`;
      } else if (aiScore >= 50) {
        qualificationTier = 'warm';
        qualificationReason = `Score ${aiScore}/100, ${aiSentiment} sentiment`;
      } else if (aiScore >= 25) {
        qualificationTier = 'nurture';
        qualificationReason = `Score ${aiScore}/100 — needs nurturing`;
      } else if (['negative', 'very_negative'].includes(aiSentiment)) {
        qualificationTier = 'disqualified';
        qualificationReason = `Low score ${aiScore}/100, ${aiSentiment}`;
      }
      if (outcome === 'converted') { qualificationTier = 'hot'; qualificationReason = 'Converted'; }
      if (outcome === 'not_interested' && aiScore < 25) { qualificationTier = 'disqualified'; }

      console.log(`[campaignPostCall] AI Score: ${aiScore}, Tier: ${qualificationTier}`);
    } catch (e) {
      console.error(`[campaignPostCall] AI scoring failed: ${e.message}`);
    }

    // Update lead
    const leadUpdate = {
      status: { interested: 'interested', not_interested: 'not_interested', callback: 'callback',
        converted: 'converted', contacted: 'contacted' }[outcome] || 'contacted',
      last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString()
    };
    if (aiScore > 0) {
      Object.assign(leadUpdate, {
        score: aiScore, sentiment: aiSentiment, intent_signals: aiIntentSignals,
        score_breakdown: aiScoreBreakdown, qualification_tier: qualificationTier,
        qualification_reason: qualificationReason,
        notes: `[Score: ${aiScore}/100 | ${aiSentiment} | ${qualificationTier}] ${summary.substring(0, 300)}`
      });
    }
    await base44.entities.Lead.update(campaignLead.lead_id, leadUpdate);
  }

  // 3. Follow-up actions (emails, callbacks, activities)
  const campaign = await base44.entities.Campaign.get(campaignId);
  const rules = campaign?.followup_rules || {};
  const lead = campaignLead.lead_id ? await base44.entities.Lead.get(campaignLead.lead_id) : null;
  const client = await base44.entities.Client.get(campaign.client_id);

  // INTERESTED → email + callback
  if (outcome === 'interested') {
    if (rules.interested_email !== false && lead?.email) {
      try {
        const emailContent = await base44.integrations.Core.InvokeLLM({
          prompt: `Write a personalized follow-up email for ${client?.company_name || 'our company'}.
Lead: ${lead.name || 'Valued Customer'}, Company: ${lead.company || 'N/A'}
Call Summary: ${summary}
Reference specific topics discussed. Include a CTA. Under 200 words. HTML format.`,
          response_json_schema: {
            type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" } }
          }
        });
        await base44.integrations.Core.SendEmail({
          to: lead.email, from_name: client?.company_name || 'VaaniAI',
          subject: emailContent.subject,
          body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${emailContent.body_html}</div>`
        });
        emailSent = true;
        await base44.entities.OutreachLog.create({
          client_id: campaign.client_id, lead_id: campaignLead.lead_id, call_log_id: callLog.id || '',
          channel: 'email', recipient_email: lead.email, subject: emailContent.subject,
          body: emailContent.body_html, outreach_type: 'lead_followup', call_outcome: outcome,
          ai_summary: summary.substring(0, 500), status: 'sent'
        });
      } catch (e) { console.error(`[campaignPostCall] Email failed: ${e.message}`); }
    }

    const cbDays = rules.interested_callback_days || 2;
    const cbDate = new Date(); cbDate.setDate(cbDate.getDate() + cbDays); cbDate.setHours(10, 0, 0, 0);
    await base44.entities.Activity.create({
      client_id: campaign.client_id, lead_id: campaignLead.lead_id, type: 'followup',
      title: `Follow-up: ${lead?.name || campaignLead.lead_phone} (Interested)`,
      description: `Campaign "${campaign.name}"\nSummary: ${summary}`,
      scheduled_date: cbDate.toISOString(), status: 'scheduled', priority: 'high', auto_created: true
    });
    callbackScheduled = true;
  }

  // CALLBACK → task + email
  if (outcome === 'callback') {
    const cbDate = new Date(); cbDate.setDate(cbDate.getDate() + 1);
    if (cbDate.getDay() === 0) cbDate.setDate(cbDate.getDate() + 1);
    if (cbDate.getDay() === 6) cbDate.setDate(cbDate.getDate() + 2);
    cbDate.setHours(10, 0, 0, 0);
    await base44.entities.Activity.create({
      client_id: campaign.client_id, lead_id: campaignLead.lead_id, type: 'call',
      title: `Callback: ${lead?.name || campaignLead.lead_phone}`,
      description: `Lead requested callback.\nSummary: ${summary}`,
      scheduled_date: cbDate.toISOString(), status: 'scheduled', priority: 'high', auto_created: true
    });
    callbackScheduled = true;
  }

  // Tier-based activities
  if (campaignLead.lead_id && qualificationTier && outcome !== 'no_answer') {
    if (qualificationTier === 'hot' && !callbackScheduled) {
      const due = new Date(); due.setHours(due.getHours() + 4);
      await base44.entities.Activity.create({
        client_id: campaign.client_id, lead_id: campaignLead.lead_id, type: 'task',
        title: `🔥 HOT: ${lead?.name || campaignLead.lead_phone} — Contact now`,
        description: `Score: ${aiScore}/100 | ${qualificationReason}\nSummary: ${summary}`,
        scheduled_date: new Date().toISOString(), due_date: due.toISOString(),
        status: 'scheduled', priority: 'high', auto_created: true
      });
    }
    if (qualificationTier === 'warm' && !callbackScheduled) {
      const fDate = new Date(); fDate.setDate(fDate.getDate() + 1); fDate.setHours(11, 0, 0, 0);
      await base44.entities.Activity.create({
        client_id: campaign.client_id, lead_id: campaignLead.lead_id, type: 'followup',
        title: `Warm lead: ${lead?.name || campaignLead.lead_phone}`,
        description: `Score: ${aiScore}/100 | ${qualificationReason}\nSummary: ${summary}`,
        scheduled_date: fDate.toISOString(), status: 'scheduled', priority: 'medium', auto_created: true
      });
    }
    if (qualificationTier === 'nurture') {
      const rDate = new Date(); rDate.setDate(rDate.getDate() + 5);
      await base44.entities.Activity.create({
        client_id: campaign.client_id, lead_id: campaignLead.lead_id, type: 'followup',
        title: `Nurture: ${lead?.name || campaignLead.lead_phone}`,
        description: `Score: ${aiScore}/100 | ${qualificationReason}`,
        scheduled_date: rDate.toISOString(), status: 'scheduled', priority: 'low', auto_created: true
      });
    }

    // Update next followup
    const nextF = qualificationTier === 'hot' ? new Date(Date.now() + 4 * 3600000) :
      qualificationTier === 'warm' ? new Date(Date.now() + 24 * 3600000) :
      new Date(Date.now() + 5 * 86400000);
    await base44.entities.Lead.update(campaignLead.lead_id, {
      next_followup_date: nextF.toISOString(),
      engagement_count: (lead?.engagement_count || 0) + 1
    });
  }

  // Update campaign lead follow-up flags
  await base44.entities.CampaignLead.update(campaignLead.id, {
    followup_email_sent: emailSent, followup_scheduled: callbackScheduled,
    ...(callbackScheduled ? { followup_call_date: new Date(Date.now() + 2 * 86400000).toISOString() } : {})
  });

  // ============================================================
  // AUTO-ENROLL INTO AI EMAIL SEQUENCE based on tier
  // ============================================================
  if (campaignLead.lead_id && qualificationTier && !['disqualified'].includes(qualificationTier) && outcome !== 'no_answer') {
    try {
      const enrollResult = await base44.functions.invoke('autoEnrollSequence', {
        lead_id: campaignLead.lead_id,
        client_id: campaign.client_id,
        qualification_tier: qualificationTier,
        call_outcome: outcome,
        call_summary: summary.substring(0, 500),
        call_topics: aiScoreBreakdown.key_topics || [],
        objections: aiScoreBreakdown.objections || [],
        intent_signals: aiIntentSignals,
        ai_score: aiScore
      });
      if (enrollResult?.enrolled) {
        console.log(`[campaignPostCall] ✉️ Auto-enrolled in sequence: ${enrollResult.sequence_name}`);
      }
    } catch (seqErr) {
      console.error(`[campaignPostCall] Auto-enroll failed: ${seqErr.message}`);
    }
  }

  return { outcome, emailSent, callbackScheduled, aiScore, qualificationTier };
}


// =====================================================
// HELPER: Update campaign statistics
// =====================================================
async function updateCampaignStats(base44, campaignId) {
  try {
    const allLeads = await base44.entities.CampaignLead.filter({ campaign_id: campaignId });
    const outcomes = countOutcomes(allLeads);
    const completedCount = allLeads.filter(l => l.status === 'completed').length;
    const failedCount = allLeads.filter(l => l.status === 'failed').length;
    const pending = allLeads.filter(l => ['pending', 'calling'].includes(l.status)).length;

    const update = { outcomes_summary: outcomes, calls_completed: completedCount, calls_failed: failedCount };
    if (pending === 0) {
      update.status = 'completed';
      update.completed_at = new Date().toISOString();
    }
    await base44.entities.Campaign.update(campaignId, update);
  } catch (e) {
    console.error(`[campaignPostCall] Stats update error: ${e.message}`);
  }
}

function countOutcomes(allLeads) {
  const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
  allLeads.forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
  return outcomes;
}