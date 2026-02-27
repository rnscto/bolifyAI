import { createClient } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    // Entity automation — no user session, use service role directly
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

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
      callLog = await base44.entities.CallLog.get(payload.call_log_id);
    } else {
      return Response.json({ error: 'Invalid payload' }, { status: 400 });
    }

    // Skip campaign calls — campaignPostCall handles their follow-up emails to avoid duplicates
    const callLogId_check = callLog.id || event?.entity_id;
    if (callLogId_check) {
      const campaignLeadCheck = await base44.entities.CampaignLead.filter({ call_log_id: callLogId_check });
      if (campaignLeadCheck.length > 0) {
        console.log('[postCallFollowup] Skipping campaign call — handled by campaignPostCall');
        return Response.json({ success: true, skipped: 'campaign_call' });
      }
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
    const client = await base44.entities.Client.get(clientId);
    if (!client) {
      return Response.json({ success: true, skipped: 'client_not_found' });
    }

    let lead = null;
    if (leadId && leadId !== 'unknown') {
      try { lead = await base44.entities.Lead.get(leadId); } catch (_) {}
    }

    // Load retention config
    const configs = await base44.entities.RetentionConfig.list('-created_date', 1);
    const retentionConfig = configs[0] || {};

    // ===================================================================
    // PART 1: CLIENT LEAD FOLLOW-UP EMAILS (for all client leads)
    // ===================================================================
    if (lead && lead.email) {
      const aiContent = await base44.integrations.Core.InvokeLLM({
        prompt: `You are an AI email copywriter for "${client.company_name}", a business in the ${client.industry || 'general'} industry.
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
- Match the tone to the call outcome:
  * "interested" → enthusiastic, provide next steps, share relevant info
  * "callback" → confirm callback time, offer flexibility
  * "not_interested" → gracious, leave door open, no hard sell
  * "contacted" → thank them, summarize discussion, suggest next step
  * "converted" → congratulate, welcome aboard, onboarding details
- Keep it concise (under 200 words)
- Use the company's name naturally
- Include a clear call-to-action
- Write in professional Indian business English
- Format as HTML email body (no full html/head tags, just the content div)

Generate the subject line and HTML body.`,
        response_json_schema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            body_html: { type: "string" },
            tone: { type: "string" },
            cta_text: { type: "string" },
            follow_up_recommended_days: { type: "number" }
          }
        }
      });

      // Send the email
      try {
        await base44.integrations.Core.SendEmail({
          to: lead.email,
          from_name: client.company_name,
          subject: aiContent.subject,
          body: `
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
</div>`
        });

        // Log the outreach
        await base44.entities.OutreachLog.create({
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
        await base44.entities.OutreachLog.create({
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

      // Also send RCS if lead has phone — auto-generate disposable template, save, fill & send
      if (lead.phone) {
        try {
          // Step 1: AI generates a template with variables from call context
          const rcsTemplateData = await base44.integrations.Core.InvokeLLM({
            prompt: `You are an RCS message template designer for "${client.company_name}" (${client.industry || 'general'} industry).
Based on this call, create a reusable RCS message template with {{variable}} placeholders AND the filled values.

CALL CONTEXT:
- Lead: ${lead.name || 'Unknown'} | Phone: ${lead.phone} | Company: ${lead.company || 'N/A'}
- Agent Company: ${client.company_name}
- Call Outcome: ${leadStatusAfterCall}
- Summary: ${summary.substring(0, 500)}
${transcript ? `- Key Transcript: ${transcript.substring(0, 500)}` : ''}

RULES:
- Template body must use {{variable_name}} placeholders (e.g. {{customer_name}}, {{topic}}, {{next_step}})
- Max 300 chars for body
- Be personal, reference specific call details
- Include a clear CTA
- Determine a fitting template name and category
- Provide the filled_message with all variables replaced with actual values from this call
- For each variable, specify: key, label, default_value, and source (one of: manual, lead_name, lead_phone, lead_email, lead_company, agent_name, client_company)

Return the template definition AND the filled message.`,
            response_json_schema: {
              type: "object",
              properties: {
                template_name: { type: "string" },
                category: { type: "string", enum: ["followup", "reminder", "promotion", "notification", "welcome", "custom"] },
                body: { type: "string", description: "Template body with {{variable}} placeholders" },
                variables: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      label: { type: "string" },
                      default_value: { type: "string" },
                      source: { type: "string" },
                      filled_value: { type: "string" }
                    }
                  }
                },
                filled_message: { type: "string", description: "Final message with all variables replaced" }
              }
            }
          });

          console.log(`[postCallFollowup] AI generated RCS template: ${rcsTemplateData.template_name}`);

          // Step 2: Save the disposable template to RCSTemplate entity
          const savedTemplate = await base44.entities.RCSTemplate.create({
            client_id: clientId,
            name: rcsTemplateData.template_name || `Follow-up - ${lead.name || lead.phone} - ${new Date().toISOString().split('T')[0]}`,
            category: rcsTemplateData.category || 'followup',
            body: rcsTemplateData.body,
            variables: (rcsTemplateData.variables || []).map(v => ({
              key: v.key,
              label: v.label,
              default_value: v.default_value || '',
              source: v.source || 'manual'
            })),
            status: 'active',
            usage_count: 1
          });

          console.log(`[postCallFollowup] Saved RCS template ID: ${savedTemplate.id}`);

          // Step 3: Send the filled message via sendRCS
          const filledMessage = rcsTemplateData.filled_message || rcsTemplateData.body;
          const rcsResult = await base44.functions.invoke('sendRCS', {
            client_id: clientId,
            recipient: lead.phone,
            message: filledMessage
          });

          console.log(`[postCallFollowup] RCS sent to ${lead.phone} using template "${rcsTemplateData.template_name}":`, JSON.stringify(rcsResult));

          // Step 4: Log the outreach
          await base44.entities.OutreachLog.create({
            client_id: clientId,
            lead_id: leadId,
            call_log_id: callLogId,
            channel: 'rcs',
            recipient_phone: lead.phone,
            subject: `RCS Template: ${rcsTemplateData.template_name}`,
            body: filledMessage,
            outreach_type: 'lead_followup',
            call_outcome: leadStatusAfterCall,
            status: rcsResult.success ? 'sent' : 'failed',
            error_message: rcsResult.success ? '' : (rcsResult.error || ''),
            is_retention: false
          });

          if (rcsResult.success) {
            results.rcs_sent.push({ lead_id: leadId, phone: lead.phone, template_id: savedTemplate.id, template_name: rcsTemplateData.template_name });
          }
        } catch (rcsErr) {
          console.error(`[postCallFollowup] RCS template generation/send failed for ${lead.phone}:`, rcsErr.message);
          results.errors.push({ lead_id: leadId, channel: 'rcs', error: rcsErr.message });
        }
      }
    } else if (lead && !lead.email) {
      results.skipped.push({ lead_id: leadId, reason: 'no_email' });
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

      const retentionEmail = await base44.integrations.Core.InvokeLLM({
        prompt: `You are VaaniAI's retention email specialist. Write a personalized retention email for a platform client who hasn't subscribed.

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
        response_json_schema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            body_html: { type: "string" },
            urgency_level: { type: "string", enum: ["low", "medium", "high"] },
            key_objection_addressed: { type: "string" },
            offer_highlighted: { type: "boolean" }
          }
        }
      });

      // Send retention email
      try {
        await base44.integrations.Core.SendEmail({
          to: client.email,
          from_name: 'VaaniAI',
          subject: retentionEmail.subject,
          body: `
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

        await base44.entities.OutreachLog.create({
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
        await base44.entities.OutreachLog.create({
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

      // Send retention RCS — auto-generate disposable template, save, fill & send
      if (client.phone) {
        try {
          const retRcsTemplate = await base44.integrations.Core.InvokeLLM({
            prompt: `You are a retention RCS template designer for VaaniAI platform.
Create a reusable RCS template with {{variable}} placeholders for a retention message to an expired client.

CLIENT CONTEXT:
- Company: ${client.company_name}
- Industry: ${client.industry || 'General'}
- Account Status: ${client.account_status}
- Phone: ${client.phone}
${retentionConfig.active_offer ? `- Active Offer: ${retentionConfig.active_offer}` : ''}
${retentionConfig.offer_code ? `- Offer Code: ${retentionConfig.offer_code}` : ''}
- Call Summary: ${summary.substring(0, 300)}

RULES:
- Template body max 300 chars with {{variable}} placeholders
- Include urgency, mention VaaniAI
- Highlight offer if available
- Provide filled_message with all variables replaced
- Variables should use source: manual, client_company, or lead_name as appropriate

Return template definition and filled message.`,
            response_json_schema: {
              type: "object",
              properties: {
                template_name: { type: "string" },
                category: { type: "string", enum: ["followup", "reminder", "promotion", "notification", "welcome", "custom"] },
                body: { type: "string" },
                variables: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      label: { type: "string" },
                      default_value: { type: "string" },
                      source: { type: "string" },
                      filled_value: { type: "string" }
                    }
                  }
                },
                filled_message: { type: "string" }
              }
            }
          });

          // Save retention RCS template
          const savedRetTemplate = await base44.entities.RCSTemplate.create({
            client_id: clientId,
            name: retRcsTemplate.template_name || `Retention - ${client.company_name} - ${new Date().toISOString().split('T')[0]}`,
            category: retRcsTemplate.category || 'promotion',
            body: retRcsTemplate.body,
            variables: (retRcsTemplate.variables || []).map(v => ({
              key: v.key,
              label: v.label,
              default_value: v.default_value || '',
              source: v.source || 'manual'
            })),
            status: 'active',
            usage_count: 1
          });

          console.log(`[postCallFollowup] Saved retention RCS template ID: ${savedRetTemplate.id}`);

          const retFilledMsg = retRcsTemplate.filled_message || retRcsTemplate.body;
          const retRcsResult = await base44.functions.invoke('sendRCS', {
            client_id: clientId,
            recipient: client.phone,
            message: retFilledMsg
          });

          console.log(`[postCallFollowup] Retention RCS to ${client.phone} using template "${retRcsTemplate.template_name}":`, JSON.stringify(retRcsResult));

          await base44.entities.OutreachLog.create({
            client_id: clientId,
            call_log_id: callLogId,
            channel: 'rcs',
            recipient_phone: client.phone,
            subject: `RCS Template: ${retRcsTemplate.template_name}`,
            body: retFilledMsg,
            outreach_type: 'retention',
            call_outcome: callLog.status,
            status: retRcsResult.success ? 'sent' : 'failed',
            error_message: retRcsResult.success ? '' : (retRcsResult.error || ''),
            is_retention: true
          });

          if (retRcsResult.success) {
            results.rcs_sent.push({ client_id: clientId, phone: client.phone, type: 'retention', template_id: savedRetTemplate.id });
          }
        } catch (rcsErr) {
          console.error(`[postCallFollowup] Retention RCS template failed:`, rcsErr.message);
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