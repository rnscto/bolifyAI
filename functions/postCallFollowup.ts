import { createClient } from 'npm:@base44/sdk@0.8.20';
import { Resend } from 'npm:resend@4.0.0';

const resend = new Resend(Deno.env.get('RESEND_API_KEY'));

// ─── Send lead email via Resend (zero Base44 credits) ───
async function sendLeadEmail({ to, fromName, subject, html }) {
  const { data, error } = await resend.emails.send({
    from: `${fromName} <noreply@vaaniai.io>`,
    to,
    subject,
    html
  });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  return data;
}

// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
async function azureLLM(prompt, systemPrompt, jsonSchema) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = createClient({ appId, asServiceRole: true });

    const payload = await req.json();
    const { event, data, old_data } = payload;

    // Can be triggered via entity automation or direct invocation
    let callLog = data;
    if (event) {
      // Entity automation trigger — only process completed calls with transcripts
      if (event.entity_name !== 'CallLog') {
        return Response.json({ success: true, skipped: 'not_call_log' });
      }
      if (data.status !== 'completed' || old_data?.status === 'completed') {
        return Response.json({ success: true, skipped: 'not_newly_completed' });
      }
      if (!data.conversation_summary && !data.transcript) {
        return Response.json({ success: true, skipped: 'no_transcript_yet' });
      }
    } else if (payload.call_log_id) {
      // Direct invocation
      callLog = await svc.entities.CallLog.get(payload.call_log_id);
    } else {
      return Response.json({ error: 'Invalid payload' }, { status: 400 });
    }

    // Skip campaign calls — campaignPostCall handles their follow-up emails to avoid duplicates
    // Check BOTH by call_log_id AND by lead_id to catch race conditions where
    // call_log_id hasn't been linked yet but the lead is in an active campaign
    const callLogId_check = callLog.id || event?.entity_id;
    let isCampaignCall = false;
    if (callLogId_check) {
      const campaignLeadCheck = await svc.entities.CampaignLead.filter({ call_log_id: callLogId_check });
      if (campaignLeadCheck.length > 0) isCampaignCall = true;
    }
    if (!isCampaignCall && callLog.lead_id) {
      const leadCampaignCheck = await svc.entities.CampaignLead.filter({ lead_id: callLog.lead_id });
      const inActiveCampaign = leadCampaignCheck.some(cl => 
        ['pending', 'calling', 'processing', 'completed'].includes(cl.status)
      );
      if (inActiveCampaign) isCampaignCall = true;
    }
    if (isCampaignCall) {
      console.log('[postCallFollowup] Skipping campaign call — handled by campaignPostCall');
      return Response.json({ success: true, skipped: 'campaign_call' });
    }

    const results = {
      emails_sent: [],
      rcs_sent: [],
      skipped: [],
      errors: []
    };

    const callLogId = callLog.id || event?.entity_id;
    const clientId = callLog.client_id;
    const leadId = callLog.lead_id;
    const transcript = callLog.transcript || '';
    const summary = callLog.conversation_summary || '';
    const callDirection = callLog.direction || 'outbound';
    const leadStatusAfterCall = callLog.lead_status_updated || '';
    const callerNumber = callLog.caller_id || callLog.callee_number || '';

    console.log(`[postCallFollowup] Processing call ${callLogId} | Client: ${clientId} | Lead: ${leadId} | Status: ${leadStatusAfterCall}`);

    // Skip system/unknown calls with no real data
    if (!clientId || clientId === 'unknown') {
      console.log('[postCallFollowup] Skipping unknown client call');
      return Response.json({ success: true, skipped: 'unknown_client' });
    }

    // ===== LOAD CONTEXT =====
    const client = await svc.entities.Client.get(clientId);
    if (!client) {
      return Response.json({ success: true, skipped: 'client_not_found' });
    }

    let lead = null;
    if (leadId && leadId !== 'unknown') {
      try { lead = await svc.entities.Lead.get(leadId); } catch (_) {}
    }

    // Load retention config
    const configs = await svc.entities.RetentionConfig.list('-created_date', 1);
    const retentionConfig = configs[0] || {};

    // ===================================================================
    // PART 1: CLIENT LEAD FOLLOW-UP EMAILS (for all client leads)
    // ===================================================================
    if (lead && lead.email) {
      const aiContent = await azureLLM(
        `You are an AI email copywriter for "${client.company_name}", a business in the ${client.industry || 'general'} industry.
A call just ended with a lead. Based on the call transcript/summary, write a personalized follow-up email.

CALL DETAILS:
- Direction: ${callDirection}
- Lead Name: ${lead.name || 'Valued Contact'}
- Lead Phone: ${lead.phone}
- Lead Company: ${lead.company || 'N/A'}
- Call Outcome/Status: ${leadStatusAfterCall}
- Call Summary: ${summary}
${transcript ? `- Transcript excerpt: ${transcript.substring(0, 1000)}` : ''}

INSTRUCTIONS:
- Match the tone to the call outcome
- Keep it concise (under 200 words)
- Use the company's name naturally
- Include a clear call-to-action
- Write in professional Indian business English
- Format as HTML email body (no full html/head tags, just the content div)

Generate the subject line and HTML body.`,
        'You are an email copywriter. Always respond in valid JSON.',
        { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" }, tone: { type: "string" }, cta_text: { type: "string" }, follow_up_recommended_days: { type: "number" } } }
      );

      // Send the email via Resend
      try {
        const emailHtml = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #2563eb, #1e40af); padding: 24px 30px; border-radius: 12px 12px 0 0;">
    <h2 style="color: white; margin: 0; font-size: 20px;">${client.company_name}</h2>
  </div>
  <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
    ${aiContent.body_html}
    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
    <p style="color: #94a3b8; font-size: 12px; text-align: center;">
      Sent by ${client.company_name} powered by VaaniAI
    </p>
  </div>
</div>`;
        await sendLeadEmail({ to: lead.email, fromName: client.company_name, subject: aiContent.subject, html: emailHtml });

        // Log the outreach
        await svc.entities.OutreachLog.create({
          client_id: clientId,
          lead_id: leadId,
          call_log_id: callLogId,
          channel: 'email',
          recipient_email: lead.email,
          recipient_phone: lead.phone,
          subject: aiContent.subject,
          body: aiContent.body_html,
          outreach_type: leadStatusAfterCall === 'callback' ? 'callback_reminder' :
                         leadStatusAfterCall === 'converted' ? 'thank_you' :
                         leadStatusAfterCall === 'interested' ? 'proposal' : 'lead_followup',
          call_outcome: leadStatusAfterCall,
          ai_summary: summary.substring(0, 500),
          status: 'sent',
          is_retention: false
        });

        results.emails_sent.push({
          lead_id: leadId,
          email: lead.email,
          subject: aiContent.subject,
          type: 'lead_followup'
        });
        console.log(`[postCallFollowup] Lead email sent to ${lead.email}`);

      } catch (emailErr) {
        console.error(`[postCallFollowup] Email failed for lead ${leadId}:`, emailErr.message);
        await svc.entities.OutreachLog.create({
          client_id: clientId,
          lead_id: leadId,
          call_log_id: callLogId,
          channel: 'email',
          recipient_email: lead.email,
          outreach_type: 'lead_followup',
          call_outcome: leadStatusAfterCall,
          status: 'failed',
          error_message: emailErr.message,
          is_retention: false
        });
        results.errors.push({ lead_id: leadId, error: emailErr.message });
      }

      // Also send RCS if lead has phone (via Smartflo SMS/RCS API)
      if (lead.phone) {
        try {
          const rcsContent = await azureLLM(
            `Write a short follow-up RCS/SMS message (max 160 chars) for a lead after a call.
Lead: ${lead.name || 'there'}
Company: ${client.company_name}
Call outcome: ${leadStatusAfterCall}
Summary: ${summary.substring(0, 200)}

Keep it personal, mention key point from the call, include CTA. No links.`,
            'You are an SMS copywriter. Always respond in valid JSON.',
            { type: "object", properties: { message: { type: "string" } } }
          );

          // Send RCS/SMS via Smartflo API
          const smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
          if (smartfloApiKey) {
            const smsResponse = await fetch('https://api.smartflo.in/v1/messages/send', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${smartfloApiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                to: lead.phone,
                message: rcsContent.message,
                type: 'rcs',
                fallback: 'sms'
              })
            });

            const smsResult = await smsResponse.json();
            console.log(`[postCallFollowup] RCS/SMS sent to ${lead.phone}:`, smsResult);

            await svc.entities.OutreachLog.create({
              client_id: clientId,
              lead_id: leadId,
              call_log_id: callLogId,
              channel: 'rcs',
              recipient_phone: lead.phone,
              subject: 'Post-call follow-up',
              body: rcsContent.message,
              outreach_type: 'lead_followup',
              call_outcome: leadStatusAfterCall,
              status: smsResponse.ok ? 'sent' : 'failed',
              error_message: smsResponse.ok ? '' : JSON.stringify(smsResult),
              is_retention: false
            });

            if (smsResponse.ok) {
              results.rcs_sent.push({ lead_id: leadId, phone: lead.phone });
            }
          } else {
            console.log('[postCallFollowup] SMARTFLO_API_KEY not set, skipping RCS');
            results.skipped.push({ lead_id: leadId, reason: 'no_smartflo_key_for_rcs' });
          }
        } catch (rcsErr) {
          console.error(`[postCallFollowup] RCS failed for ${lead.phone}:`, rcsErr.message);
          results.errors.push({ lead_id: leadId, channel: 'rcs', error: rcsErr.message });
        }
      }
    } else if (lead && !lead.email) {
      results.skipped.push({ lead_id: leadId, reason: 'no_email' });
    }

    // ===================================================================
    // PART 1.5: CREATE CALLBACK/FOLLOWUP ACTIVITY (for manual non-campaign calls)
    // This ensures manual calls appear in Automation Engine & Callbacks page
    // ===================================================================
    if (lead && leadId && ['callback', 'interested'].includes(leadStatusAfterCall)) {
      // Check if an activity already exists for this call to avoid duplicates
      const existingActivities = await svc.entities.Activity.filter({ 
        client_id: clientId, 
        lead_id: leadId, 
        call_log_id: callLogId 
      });

      if (existingActivities.length === 0) {
        // Determine follow-up date: callback = 1 day, interested = 2 days
        const followupDays = leadStatusAfterCall === 'callback' ? 1 : 2;
        const followupDate = new Date();
        followupDate.setDate(followupDate.getDate() + followupDays);
        followupDate.setHours(10, 0, 0, 0); // Default to 10 AM IST

        const activityType = leadStatusAfterCall === 'callback' ? 'followup' : 'call';
        const activityTitle = leadStatusAfterCall === 'callback' 
          ? `Callback: ${lead.name || lead.phone}` 
          : `Follow-up call: ${lead.name || lead.phone}`;

        await svc.entities.Activity.create({
          client_id: clientId,
          lead_id: leadId,
          call_log_id: callLogId,
          type: activityType,
          title: activityTitle,
          description: `Auto-created from manual call. Outcome: ${leadStatusAfterCall}. Summary: ${summary.substring(0, 300)}`,
          scheduled_date: followupDate.toISOString(),
          due_date: followupDate.toISOString(),
          status: 'scheduled',
          priority: leadStatusAfterCall === 'callback' ? 'high' : 'medium',
          auto_created: true,
          notes: `Call ID: ${callLogId}`
        });

        // Also update lead's next_followup_date
        await svc.entities.Lead.update(leadId, { 
          next_followup_date: followupDate.toISOString() 
        });

        console.log(`[postCallFollowup] Created ${activityType} activity for lead ${leadId}, scheduled ${followupDate.toISOString()}`);
        results.activity_created = { lead_id: leadId, type: activityType, scheduled: followupDate.toISOString() };
      } else {
        console.log(`[postCallFollowup] Activity already exists for call ${callLogId}, skipping`);
      }
    }

    // ===================================================================
    // PART 2: RETENTION — Platform clients who didn't subscribe
    // ===================================================================
    const isRetentionCall = callLog.agent_id === 'system_inbound' || 
                            callLog.agent_id === 'retention' ||
                            (summary && summary.toLowerCase().includes('retention'));
    const isExpiredClient = client.account_status === 'expired' || client.account_status === 'suspended';

    if (isExpiredClient || isRetentionCall) {
      console.log(`[postCallFollowup] Retention outreach for expired client: ${client.company_name}`);

      const retentionEmail = await azureLLM(
        `You are VaaniAI's retention email specialist. Write a personalized retention email for a platform client who hasn't subscribed.

CLIENT CONTEXT:
- Company: ${client.company_name}
- Industry: ${client.industry || 'General'}
- Account Status: ${client.account_status}
- Email: ${client.email}
- Trial Start: ${client.trial_start_date || 'N/A'}
- Trial End: ${client.trial_end_date || 'N/A'}
- Total Channels: ${client.total_channels || 1}
- Phone: ${client.phone || 'N/A'}

CALL CONTEXT:
- Direction: ${callDirection}
- Summary: ${summary}
${transcript ? `- Key Transcript: ${transcript.substring(0, 800)}` : ''}

${retentionConfig.active_offer ? `ACTIVE OFFER: ${retentionConfig.active_offer}${retentionConfig.offer_code ? ' | Code: ' + retentionConfig.offer_code : ''}${retentionConfig.offer_expiry ? ' | Expires: ' + retentionConfig.offer_expiry : ''}` : ''}

${retentionConfig.custom_instructions || ''}

INSTRUCTIONS:
- Reference specific things discussed in the call
- Address any objections or concerns mentioned
- Highlight value they're missing (AI calling saves 80% time, 24/7 availability)
- Include the active offer if available
- Create urgency without being pushy
- Pricing: ₹6,500/month per channel, quarterly billing
- Include clear CTA to subscribe
- Professional Indian business tone
- Under 250 words
- Format as HTML email body`,
        'You are a retention email specialist. Always respond in valid JSON.',
        { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" }, urgency_level: { type: "string" }, key_objection_addressed: { type: "string" }, offer_highlighted: { type: "boolean" } } }
      );

      // Send retention email
      try {
        await sendLeadEmail({
          to: client.email,
          fromName: 'VaaniAI',
          subject: retentionEmail.subject,
          html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 24px 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h2 style="color: white; margin: 0;">VaaniAI</h2>
    <p style="color: #a0aec0; margin: 4px 0 0 0; font-size: 13px;">AI Voice Calling Platform</p>
  </div>
  <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none;">
    ${retentionEmail.body_html}
  </div>
  ${retentionConfig.active_offer ? `
  <div style="background: linear-gradient(135deg, #f6e05e, #ecc94b); padding: 16px 30px; text-align: center;">
    <p style="margin: 0; font-weight: bold; color: #744210;">🎉 ${retentionConfig.active_offer}${retentionConfig.offer_code ? ' — Use code: ' + retentionConfig.offer_code : ''}</p>
  </div>` : ''}
  <div style="padding: 20px 30px; background: #f7fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
    <a href="https://vaaniai.in" style="display: inline-block; background: linear-gradient(135deg, #e67e22, #d35400); color: white; padding: 14px 40px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Subscribe Now — ₹6,500/mo</a>
    <p style="color: #a0aec0; font-size: 12px; margin-top: 12px;">Questions? Reply to this email or call us.</p>
  </div>
</div>`
        });

        await svc.entities.OutreachLog.create({
          client_id: clientId,
          call_log_id: callLogId,
          channel: 'email',
          recipient_email: client.email,
          subject: retentionEmail.subject,
          body: retentionEmail.body_html,
          outreach_type: 'retention',
          call_outcome: leadStatusAfterCall || callLog.status,
          ai_summary: `Objection: ${retentionEmail.key_objection_addressed || 'None'}. Urgency: ${retentionEmail.urgency_level}`,
          status: 'sent',
          is_retention: true
        });

        results.emails_sent.push({
          client_id: clientId,
          email: client.email,
          subject: retentionEmail.subject,
          type: 'retention'
        });
        console.log(`[postCallFollowup] Retention email sent to ${client.email}`);

      } catch (retErr) {
        console.error(`[postCallFollowup] Retention email failed:`, retErr.message);
        await svc.entities.OutreachLog.create({
          client_id: clientId,
          call_log_id: callLogId,
          channel: 'email',
          recipient_email: client.email,
          outreach_type: 'retention',
          status: 'failed',
          error_message: retErr.message,
          is_retention: true
        });
        results.errors.push({ client_id: clientId, type: 'retention', error: retErr.message });
      }

      // Send retention RCS to client phone
      if (client.phone) {
        try {
          const retentionRCS = await azureLLM(
            `Write a short retention RCS/SMS (max 160 chars) for ${client.company_name}. Account expired. ${retentionConfig.active_offer ? 'Offer: ' + retentionConfig.active_offer : ''} Mention VaaniAI. Include urgency.`,
            'You are an SMS copywriter. Always respond in valid JSON.',
            { type: "object", properties: { message: { type: "string" } } }
          );

          const smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
          if (smartfloApiKey) {
            const rcsResp = await fetch('https://api.smartflo.in/v1/messages/send', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${smartfloApiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                to: client.phone,
                message: retentionRCS.message,
                type: 'rcs',
                fallback: 'sms'
              })
            });

            const rcsResult = await rcsResp.json();
            console.log(`[postCallFollowup] Retention RCS to ${client.phone}:`, rcsResult);

            await svc.entities.OutreachLog.create({
              client_id: clientId,
              call_log_id: callLogId,
              channel: 'rcs',
              recipient_phone: client.phone,
              subject: 'Retention follow-up',
              body: retentionRCS.message,
              outreach_type: 'retention',
              call_outcome: callLog.status,
              status: rcsResp.ok ? 'sent' : 'failed',
              error_message: rcsResp.ok ? '' : JSON.stringify(rcsResult),
              is_retention: true
            });

            if (rcsResp.ok) {
              results.rcs_sent.push({ client_id: clientId, phone: client.phone, type: 'retention' });
            }
          }
        } catch (rcsErr) {
          console.error(`[postCallFollowup] Retention RCS failed:`, rcsErr.message);
          results.errors.push({ client_id: clientId, channel: 'retention_rcs', error: rcsErr.message });
        }
      }
    }

    console.log(`[postCallFollowup] Done. Emails: ${results.emails_sent.length}, RCS: ${results.rcs_sent.length}, Errors: ${results.errors.length}`);

    return Response.json({
      success: true,
      ...results
    });

  } catch (error) {
    console.error('[postCallFollowup] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});