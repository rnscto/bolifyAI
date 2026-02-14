import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();

    const { event, data, old_data } = payload;

    // Only process CallLog updates that just completed
    if (!event || event.entity_name !== 'CallLog') {
      return Response.json({ success: true, skipped: 'not_call_log' });
    }
    if (data.status !== 'completed' || old_data?.status === 'completed') {
      return Response.json({ success: true, skipped: 'not_newly_completed' });
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

    // Determine outcome from transcript using LLM
    let outcome = 'contacted';
    let summary = callLog.conversation_summary || '';

    if (callLog.transcript || callLog.conversation_summary) {
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

    // === AUTOMATED FOLLOW-UPS ===
    let emailSent = false;
    let callbackScheduled = false;

    // 1. If interested → send email + schedule callback in 2 days
    if (outcome === 'interested' && rules.interested_email !== false) {
      const lead = await base44.asServiceRole.entities.Lead.get(campaignLead.lead_id);
      const client = await base44.asServiceRole.entities.Client.get(campaign.client_id);

      if (lead?.email) {
        try {
          const emailContent = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Write a follow-up email for an interested lead after a sales call.
Lead: ${lead.name || 'Valued Customer'}
Company calling: ${client?.company_name || 'Our company'}
Industry: ${client?.industry || 'General'}
Call summary: ${summary}

Write a warm, professional follow-up that:
- Thanks them for their time
- References specific points from the conversation
- Provides clear next steps
- Includes a call-to-action
- Under 150 words
- HTML format (just body content, no html/head tags)`,
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
          console.log(`[campaignPostCall] Follow-up email sent to ${lead.email}`);
        } catch (emailErr) {
          console.error(`[campaignPostCall] Email failed:`, emailErr.message);
        }
      }

      // Schedule callback in X days
      const callbackDays = rules.interested_callback_days || 2;
      const callbackDate = new Date();
      callbackDate.setDate(callbackDate.getDate() + callbackDays);
      callbackDate.setHours(10, 0, 0, 0); // 10 AM

      await base44.asServiceRole.entities.Activity.create({
        client_id: campaign.client_id,
        lead_id: campaignLead.lead_id,
        type: 'followup',
        title: `Campaign follow-up: ${lead?.name || campaignLead.lead_phone}`,
        description: `Auto-scheduled from campaign "${campaign.name}". Outcome: interested.\n\nSummary: ${summary}`,
        scheduled_date: callbackDate.toISOString(),
        status: 'scheduled',
        priority: 'high',
        auto_created: true
      });

      callbackScheduled = true;
      console.log(`[campaignPostCall] Callback scheduled for ${callbackDate.toISOString()}`);
    }

    // 2. If callback → send confirmation email
    if (outcome === 'callback' && rules.callback_email !== false) {
      const lead = await base44.asServiceRole.entities.Lead.get(campaignLead.lead_id);
      const client = await base44.asServiceRole.entities.Client.get(campaign.client_id);

      if (lead?.email) {
        try {
          const emailContent = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Write a brief callback confirmation email.
Lead: ${lead.name || 'there'}
Company: ${client?.company_name}
Summary: ${summary}
Keep it under 80 words. HTML format.`,
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
        } catch (e) {
          console.error(`[campaignPostCall] Callback email failed:`, e.message);
        }
      }
    }

    // Update campaign lead with follow-up status
    await base44.asServiceRole.entities.CampaignLead.update(campaignLead.id, {
      followup_email_sent: emailSent,
      followup_scheduled: callbackScheduled,
      followup_call_date: callbackScheduled ? new Date(Date.now() + (rules.interested_callback_days || 2) * 86400000).toISOString() : undefined
    });

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

    // Check if campaign is done
    const pending = allLeads.filter(l => ['pending', 'calling'].includes(l.status)).length;
    if (pending === 0) {
      updateData.status = 'completed';
      updateData.completed_at = new Date().toISOString();
    }

    await base44.asServiceRole.entities.Campaign.update(campaignId, updateData);

    return Response.json({
      success: true,
      outcome,
      email_sent: emailSent,
      callback_scheduled: callbackScheduled
    });

  } catch (error) {
    console.error('[campaignPostCall] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});