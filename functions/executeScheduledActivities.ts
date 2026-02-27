import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

// Activity Execution Engine
// Runs every 15 min. Picks up scheduled activities that are due and executes them:
//  - call/followup → auto-initiates call via Smartflo
//  - email → sends AI-personalized email
//  - appointment/demo/visit/meeting → sends reminder via email + RCS
//  - task → marks overdue if past due
// Also marks overdue activities that are >24h past scheduled_date

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const svc = base44.asServiceRole;
    const now = new Date();
    const results = {
      calls_initiated: 0,
      emails_sent: 0,
      reminders_sent: 0,
      marked_overdue: 0,
      skipped: 0,
      errors: []
    };

    // Fetch all scheduled activities
    const activities = await svc.entities.Activity.filter({ status: 'scheduled' }, 'scheduled_date', 100);

    for (const activity of activities) {
      const scheduledDate = new Date(activity.scheduled_date);

      // Skip future activities (not yet due)
      if (scheduledDate > now) {
        results.skipped++;
        continue;
      }

      const hoursPast = (now - scheduledDate) / (1000 * 60 * 60);

      // Mark as overdue if >24h past and not yet executed
      if (hoursPast > 24) {
        await svc.entities.Activity.update(activity.id, { status: 'overdue' });
        results.marked_overdue++;
        continue;
      }

      // Skip if reminder already sent (avoid duplicate execution)
      if (activity.reminder_sent) {
        results.skipped++;
        continue;
      }

      // Load lead data if available
      let lead = null;
      if (activity.lead_id) {
        try { lead = await svc.entities.Lead.get(activity.lead_id); } catch (_) {}
      }

      // Load client data
      let client = null;
      if (activity.client_id) {
        try { client = await svc.entities.Client.get(activity.client_id); } catch (_) {}
      }

      const activityType = activity.type;

      // ============================================================
      // 1. CALL / FOLLOWUP → Auto-initiate call
      // ============================================================
      if (activityType === 'call' || activityType === 'followup') {
        if (!lead || !lead.phone) {
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + '\n[Auto-Engine] Skipped: no lead phone number'
          });
          results.skipped++;
          continue;
        }

        // Check if lead is do_not_call
        if (lead.status === 'do_not_call') {
          await svc.entities.Activity.update(activity.id, {
            status: 'cancelled',
            notes: (activity.notes || '') + '\n[Auto-Engine] Cancelled: lead is do_not_call'
          });
          results.skipped++;
          continue;
        }

        // Find an active agent for this client
        const agents = await svc.entities.Agent.filter({ client_id: activity.client_id, status: 'active' });
        const agent = agents.find(a => (a.assigned_dids?.length > 0) || a.assigned_did);

        if (!agent) {
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + '\n[Auto-Engine] Skipped: no active agent with DID'
          });
          results.skipped++;
          continue;
        }

        // Select DID
        const callerDID = (agent.assigned_dids?.length > 0) ? agent.assigned_dids[0] : agent.assigned_did;

        // Build lead context
        let leadContext = '';
        try {
          const ctxRes = await svc.functions.invoke('buildLeadContext', {
            lead_id: lead.id, client_id: activity.client_id, phone_number: lead.phone
          });
          if (ctxRes?.context_text) leadContext = ctxRes.context_text;
        } catch (_) {}

        // Build prompt with activity context
        const personalizedPrompt = [
          agent.system_prompt || '',
          `\nSCHEDULED ACTIVITY CONTEXT:`,
          `- Type: ${activityType}`,
          `- Title: ${activity.title || 'Follow-up call'}`,
          `- Description: ${activity.description || 'N/A'}`,
          activity.notes ? `- Agent Notes: ${activity.notes}` : '',
          leadContext ? `\n--- LEAD CONTEXT ---\n${leadContext}` : ''
        ].filter(Boolean).join('\n');

        // Pre-fetch knowledge base
        let kbContent = '';
        if (agent.knowledge_base_ids?.length > 0) {
          for (const kbId of agent.knowledge_base_ids) {
            try {
              const doc = await svc.entities.KnowledgeBase.get(kbId);
              if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
            } catch (_) {}
          }
        }

        // Create call log
        const callSid = `auto_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const callLog = await svc.entities.CallLog.create({
          client_id: activity.client_id,
          agent_id: agent.id,
          lead_id: lead.id,
          call_sid: callSid,
          caller_id: callerDID,
          callee_number: lead.phone,
          direction: 'outbound',
          status: 'initiated',
          call_start_time: now.toISOString(),
          conversation_summary: `[AUTO-FOLLOWUP] ${activity.title}\n${leadContext}`,
          agent_config_cache: {
            agent_name: agent.name,
            system_prompt: personalizedPrompt,
            persona: agent.persona || {},
            knowledge_base_content: kbContent,
            lead_context: leadContext
          }
        });

        // Initiate via Smartflo
        const cleanCallerID = callerDID.replace(/\D/g, '');
        const cleanPhone = lead.phone.replace(/\D/g, '');

        const smartfloRes = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: Deno.env.get('SMARTFLO_API_KEY'),
            customer_number: cleanPhone,
            caller_id: cleanCallerID,
            async: 1
          })
        });

        const smartfloData = await smartfloRes.json();

        if (!smartfloRes.ok || smartfloData.success === false) {
          await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + `\n[Auto-Engine] Call failed: ${smartfloData.message || 'Unknown error'}`
          });
          results.errors.push({ activity_id: activity.id, error: smartfloData.message });
          continue;
        }

        await svc.entities.CallLog.update(callLog.id, {
          call_sid: smartfloData.call_id || smartfloData.call_sid || callSid,
          status: 'ringing'
        });

        await svc.entities.Activity.update(activity.id, {
          status: 'completed',
          completed_date: now.toISOString(),
          reminder_sent: true,
          outcome: 'Auto-call initiated',
          notes: (activity.notes || '') + `\n[Auto-Engine] Call initiated: ${callLog.id}`
        });

        await svc.entities.Lead.update(lead.id, {
          status: 'contacted',
          last_call_date: now.toISOString()
        });

        results.calls_initiated++;
        console.log(`[ActivityEngine] Call initiated for activity ${activity.id} → lead ${lead.name || lead.phone}`);
      }

      // ============================================================
      // 2. EMAIL → Send AI-personalized email
      // ============================================================
      else if (activityType === 'email') {
        if (!lead?.email) {
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + '\n[Auto-Engine] Skipped: no lead email'
          });
          results.skipped++;
          continue;
        }

        const emailContent = await svc.integrations.Core.InvokeLLM({
          prompt: `Write a personalized follow-up email.
Company: ${client?.company_name || 'Our Team'}
Industry: ${client?.industry || 'General'}
Lead: ${lead.name || 'Valued Customer'}
Lead Company: ${lead.company || 'N/A'}
Lead Status: ${lead.status || 'N/A'}
Activity: ${activity.title || 'Follow-up'}
Context: ${activity.description || 'General follow-up'}
${activity.notes ? 'Notes: ' + activity.notes : ''}

Professional, concise (<150 words), HTML body only. Indian business context.`,
          response_json_schema: {
            type: "object",
            properties: {
              subject: { type: "string" },
              body_html: { type: "string" }
            }
          }
        });

        await svc.integrations.Core.SendEmail({
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

        await svc.entities.OutreachLog.create({
          client_id: activity.client_id,
          lead_id: lead.id,
          channel: 'email',
          recipient_email: lead.email,
          subject: emailContent.subject,
          body: emailContent.body_html,
          outreach_type: 'lead_followup',
          status: 'sent',
          is_retention: false
        });

        await svc.entities.Activity.update(activity.id, {
          status: 'completed',
          completed_date: now.toISOString(),
          reminder_sent: true,
          outcome: `Email sent: ${emailContent.subject}`
        });

        results.emails_sent++;
        console.log(`[ActivityEngine] Email sent for activity ${activity.id} → ${lead.email}`);
      }

      // ============================================================
      // 3. APPOINTMENT / DEMO / VISIT / MEETING → Send reminder
      // ============================================================
      else if (['appointment', 'demo', 'visit', 'meeting', 'booking'].includes(activityType)) {
        // Send reminder email if lead has email
        if (lead?.email) {
          const reminderContent = await svc.integrations.Core.InvokeLLM({
            prompt: `Write a brief, friendly reminder email for an upcoming ${activityType}.
Company: ${client?.company_name || 'Our Team'}
Lead: ${lead.name || 'Valued Customer'}
Activity: ${activity.title || activityType}
Scheduled: ${scheduledDate.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
${activity.description ? 'Details: ' + activity.description : ''}

Keep under 80 words. HTML body only. Professional and warm.`,
            response_json_schema: {
              type: "object",
              properties: {
                subject: { type: "string" },
                body_html: { type: "string" }
              }
            }
          });

          await svc.integrations.Core.SendEmail({
            to: lead.email,
            from_name: client?.company_name || 'VaaniAI',
            subject: reminderContent.subject,
            body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${reminderContent.body_html}</div>`
          });

          await svc.entities.OutreachLog.create({
            client_id: activity.client_id,
            lead_id: lead.id,
            channel: 'email',
            recipient_email: lead.email,
            subject: reminderContent.subject,
            body: reminderContent.body_html,
            outreach_type: 'callback_reminder',
            status: 'sent',
            is_retention: false
          });

          results.reminders_sent++;
          console.log(`[ActivityEngine] Reminder email for ${activityType} → ${lead.email}`);
        }

        // Send RCS/SMS reminder if lead has phone
        if (lead?.phone) {
          const smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
          if (smartfloApiKey) {
            const smsContent = await svc.integrations.Core.InvokeLLM({
              prompt: `Write a short reminder SMS (max 160 chars) for ${lead.name || 'customer'} about their ${activityType}: "${activity.title || activityType}" scheduled at ${scheduledDate.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}. From ${client?.company_name || 'VaaniAI'}. Friendly and brief.`,
              response_json_schema: {
                type: "object",
                properties: { message: { type: "string" } }
              }
            });

            await fetch('https://api.smartflo.in/v1/messages/send', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${smartfloApiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                to: lead.phone,
                message: smsContent.message,
                type: 'rcs',
                fallback: 'sms'
              })
            });

            await svc.entities.OutreachLog.create({
              client_id: activity.client_id,
              lead_id: lead.id,
              channel: 'rcs',
              recipient_phone: lead.phone,
              subject: `${activityType} reminder`,
              body: smsContent.message,
              outreach_type: 'callback_reminder',
              status: 'sent',
              is_retention: false
            });

            results.reminders_sent++;
            console.log(`[ActivityEngine] RCS reminder for ${activityType} → ${lead.phone}`);
          }
        }

        // Mark reminder sent (don't complete — human needs to conduct the meeting)
        await svc.entities.Activity.update(activity.id, {
          reminder_sent: true,
          notes: (activity.notes || '') + `\n[Auto-Engine] Reminders sent at ${now.toISOString()}`
        });
      }

      // ============================================================
      // 4. TASK → Just mark overdue if past due
      // ============================================================
      else if (activityType === 'task') {
        if (hoursPast > 0) {
          await svc.entities.Activity.update(activity.id, { status: 'overdue' });
          results.marked_overdue++;
        } else {
          results.skipped++;
        }
      }

      else {
        results.skipped++;
      }
    }

    console.log(`[ActivityEngine] Done. Calls: ${results.calls_initiated}, Emails: ${results.emails_sent}, Reminders: ${results.reminders_sent}, Overdue: ${results.marked_overdue}, Skipped: ${results.skipped}, Errors: ${results.errors.length}`);

    return Response.json({ success: true, ...results });

  } catch (error) {
    console.error('[ActivityEngine] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});