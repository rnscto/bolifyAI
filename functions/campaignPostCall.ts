import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();

    const { event, data, old_data } = payload;

    // Only process CallLog updates with terminal statuses
    if (!event || event.entity_name !== 'CallLog') {
      return Response.json({ success: true, skipped: 'not_call_log' });
    }

    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    const isTerminal = terminalStatuses.includes(data.status);
    const wasAlreadyTerminal = terminalStatuses.includes(old_data?.status);

    if (!isTerminal || wasAlreadyTerminal) {
      return Response.json({ success: true, skipped: 'not_newly_terminal' });
    }

    const callLog = data;
    const callLogId = event.entity_id;

    // Check if this call belongs to a campaign
    const campaignLeads = await base44.asServiceRole.entities.CampaignLead.filter({
      call_log_id: callLogId
    });

    if (campaignLeads.length === 0) {
      return Response.json({ success: true, skipped: 'not_campaign_call' });
    }

    const campaignLead = campaignLeads[0];
    const campaignId = campaignLead.campaign_id;

    console.log(`[campaignPostCall] Processing call ${callLogId} for campaign ${campaignId}`);

    // Determine outcome based on call status and transcript
    let outcome = 'contacted';
    let summary = callLog.conversation_summary || '';

    // For calls that never connected (no_answer, failed), set outcome directly
    if (callLog.status === 'no_answer') {
      outcome = 'no_answer';
      summary = summary || 'Call was not answered.';
    } else if (callLog.status === 'failed') {
      outcome = 'no_answer';
      summary = summary || 'Call failed to connect.';
    } else if (callLog.transcript || callLog.conversation_summary) {
      // For calls with conversation data, analyze with LLM
      try {
        const analysis = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: `Analyze this sales call and determine the outcome.

TRANSCRIPT:
${callLog.transcript || 'No transcript available'}

SUMMARY:
${callLog.conversation_summary || 'No summary available'}

Determine:
1. outcome: one of "interested", "not_interested", "callback", "no_answer", "converted", "contacted"
2. summary: A brief 2-3 sentence summary of the conversation and key points discussed.

Rules:
- "interested" = caller expressed clear interest, asked about pricing/details, wanted next steps
- "callback" = caller asked to be called back later, was busy, rescheduling
- "not_interested" = caller explicitly declined, not a fit
- "no_answer" = no real conversation happened, voicemail, cut off quickly
- "converted" = caller agreed to sign up/purchase/commit
- "contacted" = had a conversation but no clear outcome yet`,
          response_json_schema: {
            type: "object",
            properties: {
              outcome: { type: "string" },
              summary: { type: "string" }
            }
          }
        });
        outcome = analysis.outcome || 'contacted';
        summary = analysis.summary || summary;
      } catch (llmErr) {
        console.error(`[campaignPostCall] LLM analysis failed:`, llmErr.message);
      }
    }

    // Update campaign lead
    await base44.asServiceRole.entities.CampaignLead.update(campaignLead.id, {
      status: 'completed',
      outcome: outcome,
      conversation_summary: summary,
      transcript: callLog.transcript || '',
      call_duration: callLog.duration || 0
    });

    // Update lead status
    if (campaignLead.lead_id) {
      await base44.asServiceRole.entities.Lead.update(campaignLead.lead_id, {
        status: outcome,
        last_call_date: new Date().toISOString()
      });
    }

    // Fetch campaign for follow-up rules
    const campaign = await base44.asServiceRole.entities.Campaign.get(campaignId);
    const rules = campaign?.followup_rules || {};

    // Pre-fetch lead and client for follow-ups (shared across actions)
    const lead = campaignLead.lead_id ? await base44.asServiceRole.entities.Lead.get(campaignLead.lead_id) : null;
    const client = await base44.asServiceRole.entities.Client.get(campaign.client_id);

    let emailSent = false;
    let callbackScheduled = false;

    // ============================================================
    // 1. INTERESTED: AI-personalized follow-up email + callback
    // ============================================================
    if (outcome === 'interested') {
      // 1a. AI-personalized email using transcript context
      if (rules.interested_email !== false && lead?.email) {
        try {
          const useAI = rules.interested_ai_email !== false;
          const emailPrompt = useAI
            ? `You are a follow-up email writer for ${client?.company_name || 'our company'} (Industry: ${client?.industry || 'General'}).

Write a highly personalized follow-up email to a lead who just expressed INTEREST in a sales call.

LEAD INFO:
- Name: ${lead.name || 'Valued Customer'}
- Company: ${lead.company || 'N/A'}
- Source: ${lead.source || 'N/A'}

CALL TRANSCRIPT:
${callLog.transcript || 'Not available'}

CALL SUMMARY:
${summary}

INSTRUCTIONS:
- Reference SPECIFIC topics, questions, or concerns the lead raised during the call
- If they asked about pricing, include a mention of next steps for pricing info
- If they asked about features, highlight the relevant features discussed
- Include a personalized call-to-action based on what they showed interest in
- Tone: Warm, professional, and consultative
- Keep under 200 words
- HTML format (just body content, no html/head/body tags)
- Include a clear next-step CTA (book demo, schedule meeting, etc.)`
            : `Write a standard follow-up email for an interested lead.
Lead: ${lead.name || 'Valued Customer'}
Company: ${client?.company_name}
Summary: ${summary}
Under 150 words. HTML format.`;

          const emailContent = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: emailPrompt,
            response_json_schema: {
              type: "object",
              properties: {
                subject: { type: "string" },
                body_html: { type: "string" }
              }
            }
          });

          await base44.asServiceRole.integrations.Core.SendEmail({
            to: lead.email,
            from_name: client?.company_name || 'VaaniAI',
            subject: emailContent.subject,
            body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:linear-gradient(135deg,#2563eb,#1e40af);padding:24px 30px;border-radius:12px 12px 0 0;">
                <h2 style="color:white;margin:0;">${client?.company_name || 'VaaniAI'}</h2>
              </div>
              <div style="padding:30px;background:white;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
                ${emailContent.body_html}
              </div>
            </div>`
          });

          await base44.asServiceRole.entities.OutreachLog.create({
            client_id: campaign.client_id,
            lead_id: campaignLead.lead_id,
            call_log_id: callLogId,
            channel: 'email',
            recipient_email: lead.email,
            subject: emailContent.subject,
            body: emailContent.body_html,
            outreach_type: 'lead_followup',
            call_outcome: outcome,
            ai_summary: summary.substring(0, 500),
            status: 'sent',
            is_retention: false
          });

          emailSent = true;
          console.log(`[campaignPostCall] AI-personalized follow-up email sent to ${lead.email}`);
        } catch (emailErr) {
          console.error(`[campaignPostCall] Interested email failed:`, emailErr.message);
        }
      }

      // 1b. Schedule callback with AI context
      const callbackDays = rules.interested_callback_days || 2;
      const callbackDate = new Date();
      callbackDate.setDate(callbackDate.getDate() + callbackDays);
      callbackDate.setHours(10, 0, 0, 0);

      await base44.asServiceRole.entities.Activity.create({
        client_id: campaign.client_id,
        lead_id: campaignLead.lead_id,
        type: 'followup',
        title: `Follow-up call: ${lead?.name || campaignLead.lead_phone} (Interested)`,
        description: `Auto-scheduled from campaign "${campaign.name}".\nOutcome: Interested\n\nCall Summary:\n${summary}\n\nKey Discussion Points:\n- Review transcript for specific interests mentioned\n- Prepare pricing/demo materials based on call context`,
        scheduled_date: callbackDate.toISOString(),
        status: 'scheduled',
        priority: 'high',
        auto_created: true
      });

      callbackScheduled = true;
      console.log(`[campaignPostCall] Interested callback scheduled for ${callbackDate.toISOString()}`);
    }

    // ============================================================
    // 2. CALLBACK: AI talking points + task + confirmation email
    // ============================================================
    if (outcome === 'callback') {
      // 2a. Create task with AI-generated talking points
      if (rules.callback_create_task !== false) {
        let talkingPoints = '';

        if (rules.callback_ai_talking_points !== false && (callLog.transcript || summary)) {
          try {
            const tpResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
              prompt: `You are a sales coach. Based on this call transcript and summary, generate concise talking points for the agent's next callback with this lead.

LEAD: ${lead?.name || 'Unknown'} (${lead?.company || 'N/A'})
CALL TRANSCRIPT:
${callLog.transcript || 'Not available'}

CALL SUMMARY:
${summary}

Generate:
1. talking_points: Array of 3-5 bullet points the agent should cover in the next call
2. recommended_approach: One sentence describing the best approach for the callback
3. callback_time_suggestion: Best suggested time context (e.g. "Lead mentioned mornings work best" or "Try afternoon as they were busy in AM")
4. objections_to_address: Array of any objections or concerns raised that need addressing`,
              response_json_schema: {
                type: "object",
                properties: {
                  talking_points: { type: "array", items: { type: "string" } },
                  recommended_approach: { type: "string" },
                  callback_time_suggestion: { type: "string" },
                  objections_to_address: { type: "array", items: { type: "string" } }
                }
              }
            });

            const tp = tpResult.talking_points || [];
            const objections = tpResult.objections_to_address || [];
            talkingPoints = `\n\n🎯 AI-Generated Talking Points:\n${tp.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
            if (tpResult.recommended_approach) {
              talkingPoints += `\n\n📋 Recommended Approach:\n${tpResult.recommended_approach}`;
            }
            if (tpResult.callback_time_suggestion) {
              talkingPoints += `\n\n🕐 Timing Insight:\n${tpResult.callback_time_suggestion}`;
            }
            if (objections.length > 0) {
              talkingPoints += `\n\n⚠️ Objections to Address:\n${objections.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
            }
          } catch (tpErr) {
            console.error(`[campaignPostCall] AI talking points failed:`, tpErr.message);
            talkingPoints = '\n\n(AI talking points generation failed - review transcript manually)';
          }
        }

        // Determine callback time - default to next business day at 10 AM
        const callbackDate = new Date();
        callbackDate.setDate(callbackDate.getDate() + 1);
        // Skip weekends
        if (callbackDate.getDay() === 0) callbackDate.setDate(callbackDate.getDate() + 1);
        if (callbackDate.getDay() === 6) callbackDate.setDate(callbackDate.getDate() + 2);
        callbackDate.setHours(10, 0, 0, 0);

        await base44.asServiceRole.entities.Activity.create({
          client_id: campaign.client_id,
          lead_id: campaignLead.lead_id,
          type: 'call',
          title: `Callback: ${lead?.name || campaignLead.lead_phone} (Requested)`,
          description: `Lead requested callback from campaign "${campaign.name}".\n\nCall Summary:\n${summary}${talkingPoints}`,
          scheduled_date: callbackDate.toISOString(),
          status: 'scheduled',
          priority: 'high',
          auto_created: true
        });

        callbackScheduled = true;
        console.log(`[campaignPostCall] Callback task with AI talking points created for ${callbackDate.toISOString()}`);
      }

      // 2b. Send callback confirmation email
      if (rules.callback_email !== false && lead?.email) {
        try {
          const emailContent = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Write a brief, warm callback confirmation email.
Lead: ${lead.name || 'there'}
Company: ${client?.company_name}
Call summary: ${summary}
Let them know we'll call back soon. Keep under 80 words. HTML format (body content only).`,
            response_json_schema: {
              type: "object",
              properties: {
                subject: { type: "string" },
                body_html: { type: "string" }
              }
            }
          });

          await base44.asServiceRole.integrations.Core.SendEmail({
            to: lead.email,
            from_name: client?.company_name || 'VaaniAI',
            subject: emailContent.subject,
            body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${emailContent.body_html}</div>`
          });

          emailSent = true;
          console.log(`[campaignPostCall] Callback confirmation email sent to ${lead.email}`);
        } catch (e) {
          console.error(`[campaignPostCall] Callback email failed:`, e.message);
        }
      }
    }

    // ============================================================
    // 3. NO ANSWER: Auto-retry mechanism
    // ============================================================
    if (outcome === 'no_answer' && rules.no_answer_retry !== false) {
      const maxRetries = rules.no_answer_max_retries || 3;
      const currentAttempts = (campaignLead.attempt_count || 0) + 1;

      if (currentAttempts < maxRetries) {
        const retryHours = rules.no_answer_retry_hours || 4;
        const retryDate = new Date(Date.now() + retryHours * 3600000);

        // Re-add lead to campaign queue as pending for retry
        await base44.asServiceRole.entities.CampaignLead.update(campaignLead.id, {
          status: 'pending',
          outcome: 'no_answer',
          attempt_count: currentAttempts,
          call_log_id: null,
          followup_call_date: retryDate.toISOString()
        });

        console.log(`[campaignPostCall] No-answer retry ${currentAttempts}/${maxRetries} scheduled for ${retryDate.toISOString()}`);

        // Don't count this as completed in campaign stats yet
        // Update campaign to reflect the retry
        const allLeads = await base44.asServiceRole.entities.CampaignLead.filter({ campaign_id: campaignId });
        const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
        const completedCount = allLeads.filter(l => l.status === 'completed').length;
        const failedCount = allLeads.filter(l => l.status === 'failed').length;
        allLeads.forEach(l => {
          if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
        });

        await base44.asServiceRole.entities.Campaign.update(campaignId, {
          outcomes_summary: outcomes,
          calls_completed: completedCount,
          calls_failed: failedCount
        });

        return Response.json({
          success: true,
          outcome,
          retry_scheduled: true,
          attempt: currentAttempts,
          max_retries: maxRetries,
          retry_at: retryDate.toISOString()
        });
      } else {
        // Max retries exhausted - mark as final no_answer
        console.log(`[campaignPostCall] No-answer max retries (${maxRetries}) exhausted for lead ${campaignLead.lead_id}`);
        await base44.asServiceRole.entities.CampaignLead.update(campaignLead.id, {
          attempt_count: currentAttempts
        });
      }
    }

    // Update campaign lead with follow-up status
    const updatePayload = {
      followup_email_sent: emailSent,
      followup_scheduled: callbackScheduled,
    };
    if (callbackScheduled) {
      const cbDays = outcome === 'interested' ? (rules.interested_callback_days || 2) : 1;
      updatePayload.followup_call_date = new Date(Date.now() + cbDays * 86400000).toISOString();
    }
    await base44.asServiceRole.entities.CampaignLead.update(campaignLead.id, updatePayload);

    // Update campaign outcomes summary
    const allLeads = await base44.asServiceRole.entities.CampaignLead.filter({ campaign_id: campaignId });
    const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
    const completedCount = allLeads.filter(l => l.status === 'completed').length;
    const failedCount = allLeads.filter(l => l.status === 'failed').length;

    allLeads.forEach(l => {
      if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
    });

    const updateData = {
      outcomes_summary: outcomes,
      calls_completed: completedCount,
      calls_failed: failedCount
    };

    // Check if campaign is done (no pending or calling leads)
    const pending = allLeads.filter(l => ['pending', 'calling'].includes(l.status)).length;
    if (pending === 0) {
      updateData.status = 'completed';
      updateData.completed_at = new Date().toISOString();
    }

    await base44.asServiceRole.entities.Campaign.update(campaignId, updateData);

    // === AUTO-TRIGGER NEXT BATCH ===
    // If campaign is still running and there are pending leads with available slots,
    // immediately trigger the next batch instead of waiting for the 5-min poller.
    if (!updateData.status || updateData.status === 'running') {
      const pendingLeads = allLeads.filter(l => l.status === 'pending').length;
      const callingLeads = allLeads.filter(l => l.status === 'calling').length;
      const maxConcurrent = campaign.max_concurrent_calls || 5;

      if (pendingLeads > 0 && callingLeads < maxConcurrent) {
        console.log(`[campaignPostCall] 🚀 Auto-triggering next batch: ${pendingLeads} pending, ${callingLeads}/${maxConcurrent} calling`);
        try {
          await base44.asServiceRole.functions.invoke('executeCampaign', {
            campaign_id: campaignId,
            action: 'start',
            _internal: true
          });
        } catch (batchErr) {
          console.error(`[campaignPostCall] Next batch trigger failed: ${batchErr.message}`);
        }
      }
    }

    return Response.json({
      success: true,
      outcome,
      email_sent: emailSent,
      callback_scheduled: callbackScheduled,
      next_batch_triggered: !updateData.status || updateData.status === 'running'
    });

  } catch (error) {
    console.error('[campaignPostCall] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});