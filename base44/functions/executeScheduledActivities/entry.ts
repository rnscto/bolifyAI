import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.31';

// ─── Send email via platform's native integration (noreply@bolifyai.com) ───
async function sendEmailViaACS({ to, fromName, subject, html }) {
  const appId = Deno.env.get('BASE44_APP_ID');
  const svc = createClient({ appId, asServiceRole: true });
  return await svc.integrations.Core.SendEmail({
    from_name: fromName || 'Bolify AI',
    to, subject, body: html
  });
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

// Follow-up Automation Engine — runs every 15 min.
// Can be invoked by Base44 scheduled automation OR external cron:
//   GET ?cron_secret=<SMARTFLO_WEBHOOK_SECRET>
// Picks up scheduled activities due NOW, executes them.

Deno.serve(async (req) => {
  try {
    // Support external cron: allow GET requests with shared secret or CRON_API_KEY
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronSecret = url.searchParams.get('cron_secret');
      const cronApiKey = url.searchParams.get('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      console.log('[FollowupEngine] Triggered by external cron');
    }

    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    const now = new Date();
    const results = {
      calls_initiated: 0,
      emails_sent: 0,
      admin_alerts_sent: 0,
      reminders_sent: 0,
      marked_overdue: 0,
      skipped: 0,
      errors: []
    };

    // Fetch DUE scheduled activities that haven't been processed yet (reminder_sent !== true),
    // sorted earliest-first. Prioritize call/followup over email/task. Cap at 15 per run to fit cron timeout.
    const allScheduled = await svc.entities.Activity.filter({ status: 'scheduled', reminder_sent: false }, 'scheduled_date', 500);
    const dueNow = allScheduled.filter(a => new Date(a.scheduled_date) <= now);
    const callPriority = ['call', 'followup'];
    const calls = dueNow.filter(a => callPriority.includes(a.type));
    const others = dueNow.filter(a => !callPriority.includes(a.type));
    // Cap at 8 per run (down from 15) — fits comfortably in cron's 30s window.
    // Remaining due activities will be processed in the next 5-minute cycle.
    const activities = [...calls, ...others].slice(0, 8);
    console.log(`[FollowupEngine] Fetched ${allScheduled.length} unprocessed scheduled, ${dueNow.length} due, processing ${activities.length} (calls=${calls.length})`);

    // Hard time guard — must return BEFORE cron-job.org's 30s HTTP timeout.
    // We use 22s to leave headroom for response serialization + network.
    const RUN_DEADLINE_MS = 22 * 1000;
    const runStart = Date.now();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let stoppedEarly = false;

    for (let i = 0; i < activities.length; i++) {
      const activity = activities[i];
      // Stop processing if we're close to the deadline — remaining activities will be picked up next run
      if (Date.now() - runStart > RUN_DEADLINE_MS) {
        console.log(`[FollowupEngine] Deadline reached (${Math.round((Date.now()-runStart)/1000)}s) at activity ${i+1}/${activities.length} — stopping early; remaining will run next cycle`);
        stoppedEarly = true;
        break;
      }
      // Light throttle — 200ms is enough to stay under Base44 rate limit without burning time budget
      if (i > 0) await sleep(200);
      // ── Per-activity try/catch so one failure doesn't kill the whole run ──
      try {
        const scheduledDate = new Date(activity.scheduled_date);

        // Skip future activities (not yet due)
        if (scheduledDate > now) {
          results.skipped++;
          continue;
        }

        const hoursPast = (now - scheduledDate) / (1000 * 60 * 60);
        const activityType = activity.type;

        // Only mark as overdue if >24h past AND it's a human-action type.
        // AI-handled types (call, followup) should NOT be overdue — they auto-execute.
        const humanActionTypes = ['email', 'task', 'demo', 'visit', 'meeting', 'appointment', 'booking'];
        if (hoursPast > 24 && humanActionTypes.includes(activityType)) {
          await svc.entities.Activity.update(activity.id, { status: 'overdue' });
          results.marked_overdue++;
          console.log(`[FollowupEngine] Marked overdue: ${activity.id} (${activity.title}) — requires human attention`);
          continue;
        }
        // For AI-handled types that are very old (>48h), mark them as overdue too (safety net)
        if (hoursPast > 48 && !humanActionTypes.includes(activityType)) {
          await svc.entities.Activity.update(activity.id, { status: 'overdue' });
          results.marked_overdue++;
          console.log(`[FollowupEngine] Marked overdue (safety net): ${activity.id} (${activity.title}) — 48h+ past`);
          continue;
        }

        // Skip if already processed
        if (activity.reminder_sent) {
          results.skipped++;
          continue;
        }

        // Load lead + client (with safe error handling)
        let lead = null, client = null;
        if (activity.lead_id) {
          try { lead = await svc.entities.Lead.get(activity.lead_id); } catch (e) {
            console.warn(`[FollowupEngine] Lead ${activity.lead_id} not found: ${e.message}`);
          }
        }
        if (activity.client_id) {
          try { client = await svc.entities.Client.get(activity.client_id); } catch (e) {
            console.warn(`[FollowupEngine] Client ${activity.client_id} not found: ${e.message}`);
          }
        }

        // If client doesn't exist, skip but don't crash
        if (!client) {
          console.warn(`[FollowupEngine] Skipping activity ${activity.id}: client not found`);
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + '\n[Engine] Skipped: client not found'
          });
          results.skipped++;
          continue;
        }

        console.log(`[FollowupEngine] Processing: ${activity.id} | type=${activityType} | title="${activity.title}" | lead=${lead?.name || 'N/A'}`);

        // ============================================================
        // 1. CALL / FOLLOWUP → Auto-initiate call with SAME agent
        // ============================================================
        if (activityType === 'call' || activityType === 'followup') {
          // ── DEDUP CHECK: Skip if lead is in an active/running campaign ──
          if (lead?.id) {
            try {
              const activeCampaignLeads = await svc.entities.CampaignLead.filter({ lead_id: lead.id });
              const inActiveCampaign = activeCampaignLeads.some(cl =>
                ['pending', 'calling'].includes(cl.status)
              );
              if (inActiveCampaign) {
                console.log(`[FollowupEngine] Skipped ${activity.id}: lead ${lead.name} is in an active campaign`);
                await svc.entities.Activity.update(activity.id, {
                  reminder_sent: true,
                  notes: (activity.notes || '') + `\n[Engine] Skipped: lead is in active campaign`
                });
                results.skipped++;
                continue;
              }
            } catch (e) {
              console.warn(`[FollowupEngine] Campaign check failed: ${e.message}`);
            }
          }

          // ── Fallback: if no lead/phone but activity has call_log_id, derive phone from CallLog ──
          if (!lead?.phone && activity.call_log_id) {
            try {
              const origCall = await svc.entities.CallLog.get(activity.call_log_id);
              const fallbackPhone = origCall?.direction === 'inbound' ? (origCall.caller_id || origCall.callee_number) : (origCall.callee_number || origCall.caller_id);
              const cleanFallback = (fallbackPhone || '').replace(/\D/g, '');
              if (cleanFallback.length >= 10) {
                // Try to find matching lead first; otherwise create one so future activities have a lead
                let resolvedLead = null;
                try {
                  const candidates = await svc.entities.Lead.filter({ client_id: activity.client_id });
                  resolvedLead = candidates.find(l => {
                    const lp = (l.phone || '').replace(/\D/g, '');
                    return lp && (lp === cleanFallback || lp.endsWith(cleanFallback.slice(-10)) || cleanFallback.endsWith(lp.slice(-10)));
                  });
                } catch (_) {}
                if (!resolvedLead) {
                  resolvedLead = await svc.entities.Lead.create({
                    client_id: activity.client_id,
                    name: `Lead ${cleanFallback.slice(-10)}`,
                    phone: cleanFallback,
                    status: 'contacted',
                    source: 'auto_created_from_activity'
                  });
                  console.log(`[FollowupEngine] Created fallback lead ${resolvedLead.id} for activity ${activity.id}`);
                }
                lead = resolvedLead;
                await svc.entities.Activity.update(activity.id, { lead_id: resolvedLead.id });
              }
            } catch (e) {
              console.warn(`[FollowupEngine] Phone fallback failed: ${e.message}`);
            }
          }

          if (!lead?.phone) {
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + '\n[Engine] Skipped: no lead phone'
            });
            results.skipped++;
            console.log(`[FollowupEngine] Skipped ${activity.id}: no lead phone`);
            continue;
          }

          if (lead.status === 'do_not_call') {
            await svc.entities.Activity.update(activity.id, {
              status: 'cancelled',
              notes: (activity.notes || '') + '\n[Engine] Cancelled: do_not_call'
            });
            results.skipped++;
            console.log(`[FollowupEngine] Cancelled ${activity.id}: do_not_call`);
            continue;
          }

          // Find the SAME agent from the original call (via call_log_id on activity)
          let agent = null;
          if (activity.call_log_id) {
            try {
              const origCall = await svc.entities.CallLog.get(activity.call_log_id);
              if (origCall?.agent_id) {
                try {
                  agent = await svc.entities.Agent.get(origCall.agent_id);
                  if (agent?.status !== 'active') {
                    console.log(`[FollowupEngine] Original agent ${origCall.agent_id} not active, looking for fallback`);
                    agent = null;
                  }
                } catch (e) {
                  console.warn(`[FollowupEngine] Agent ${origCall.agent_id} not found: ${e.message}`);
                }
              }
            } catch (e) {
              console.warn(`[FollowupEngine] CallLog ${activity.call_log_id} not found: ${e.message}`);
            }
          }

          // Fallback: any active agent for this client
          if (!agent) {
            try {
              const agents = await svc.entities.Agent.filter({ client_id: activity.client_id, status: 'active' });
              agent = agents.find(a => (a.assigned_dids?.length > 0) || a.assigned_did);
              if (agent) console.log(`[FollowupEngine] Using fallback agent: ${agent.name}`);
            } catch (e) {
              console.warn(`[FollowupEngine] Error finding fallback agents: ${e.message}`);
            }
          }

          if (!agent) {
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + '\n[Engine] Skipped: no active agent'
            });
            try {
              await sendAdminAlert(svc, client, activity, lead, 'auto_call_failed', 'No active agent with DID available for follow-up call.');
            } catch (alertErr) {
              console.error(`[FollowupEngine] Admin alert failed: ${alertErr.message}`);
            }
            results.skipped++;
            continue;
          }

          const callerDID = (agent.assigned_dids?.length > 0) ? agent.assigned_dids[0] : agent.assigned_did;
          if (!callerDID) {
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + '\n[Engine] Skipped: agent has no DID assigned'
            });
            console.warn(`[FollowupEngine] Agent ${agent.name} has no DID assigned`);
            results.skipped++;
            continue;
          }

          // Build lead context INLINE
          const ctxParts = [`CUSTOMER PROFILE:`, `- Name: ${lead.name || 'Unknown'}`];
          if (lead.phone) ctxParts.push(`- Phone: ${lead.phone}`);
          if (lead.email) ctxParts.push(`- Email: ${lead.email}`);
          if (lead.company) ctxParts.push(`- Company: ${lead.company}`);
          if (lead.status) ctxParts.push(`- Status: ${lead.status}`);
          if (lead.score) ctxParts.push(`- Score: ${lead.score}/100`);
          if (lead.qualification_tier) ctxParts.push(`- Tier: ${lead.qualification_tier.toUpperCase()}`);
          if (lead.notes) ctxParts.push(`\nLEAD NOTES:\n${lead.notes.substring(0, 500)}`);

          // Get recent call history
          try {
            const recentCalls = await svc.entities.CallLog.filter({ lead_id: lead.id }, '-created_date', 3);
            if (recentCalls.length > 0) {
              ctxParts.push(`\nPREVIOUS CALLS (${recentCalls.length}):`);
              recentCalls.forEach((c, i) => {
                const dt = c.call_start_time ? new Date(c.call_start_time).toLocaleDateString('en-IN') : '?';
                ctxParts.push(`  ${i+1}. ${dt} (${c.status}) — ${(c.conversation_summary || '').substring(0, 200)}`);
              });
            }
          } catch (_) {}

          ctxParts.push(`\nFOLLOW-UP CONTEXT:`);
          ctxParts.push(`- Reason: ${activity.title || 'Scheduled follow-up'}`);
          ctxParts.push(`- Details: ${activity.description || 'N/A'}`);
          if (activity.notes) ctxParts.push(`- Notes: ${activity.notes}`);
          ctxParts.push(`\nCRITICAL RULES:`);
          ctxParts.push(`- Address customer by name "${lead.name || 'Sir/Madam'}".`);
          ctxParts.push(`- Reference your previous conversation naturally.`);
          ctxParts.push(`- This is a SCHEDULED follow-up — the customer expects this call.`);
          const leadContext = ctxParts.join('\n');

          // Knowledge base
          let kbContent = '';
          if (agent.knowledge_base_ids?.length > 0) {
            for (const kbId of agent.knowledge_base_ids) {
              try {
                const doc = await svc.entities.KnowledgeBase.get(kbId);
                if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
              } catch (_) {}
            }
          }

          const personalizedPrompt = [
            agent.system_prompt || '',
            `\n\n--- FOLLOW-UP CALL CONTEXT (YOU MUST USE THIS DATA) ---\n${leadContext}`
          ].filter(Boolean).join('\n');

          const callSid = `followup_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
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
            conversation_summary: `[AUTO-FOLLOWUP] ${activity.title}\n${leadContext.substring(0, 500)}`,
            agent_config_cache: {
              agent_name: agent.name,
              system_prompt: personalizedPrompt,
              persona: agent.persona || {},
              knowledge_base_content: kbContent,
              lead_context: leadContext,
              greeting_message: agent.greeting_message || ''
            }
          });

          // Smartflo call — use agent's own API token
          const cleanPhone = lead.phone.replace(/\D/g, '');
          let followupApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
          try {
            const clientData = await svc.entities.Client.get(activity.client_id);
            if (clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding')) {
              followupApiKey = Deno.env.get('SMARTFLO_API_KEY');
            }
          } catch (_) {}

          const smartfloRes = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: followupApiKey,
              customer_number: cleanPhone,
              caller_id: callerDID.replace(/^\+/, ''),
              async: 1
            })
          });

          const smartfloData = await smartfloRes.json();
          if (!smartfloRes.ok || smartfloData.success === false) {
            await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + `\n[Engine] Call failed: ${smartfloData.message || 'Unknown'}`
            });
            results.errors.push({ activity_id: activity.id, error: smartfloData.message });
            console.error(`[FollowupEngine] Smartflo call failed for ${lead.name}: ${smartfloData.message}`);
            continue;
          }

          const actualSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id || callSid;
          await svc.entities.CallLog.update(callLog.id, { call_sid: actualSid, status: 'ringing' });

          await svc.entities.Activity.update(activity.id, {
            status: 'completed',
            completed_date: now.toISOString(),
            reminder_sent: true,
            outcome: `Auto-call initiated (${callLog.id})`,
            notes: (activity.notes || '') + `\n[Engine] Call initiated: ${callLog.id}`
          });

          await svc.entities.Lead.update(lead.id, { status: 'contacted', last_call_date: now.toISOString() });
          results.calls_initiated++;
          console.log(`[FollowupEngine] ✅ Call initiated: ${lead.name} → ${lead.phone} (activity ${activity.id})`);
        }

        // ============================================================
        // 2. EMAIL → Human action required (alert admin to send specific content)
        //    Email activities from postCallActionExtractor are requests like
        //    "send pricing", "email brochure" — these need human crafted content,
        //    NOT auto-generated AI emails.
        // ============================================================
        else if (activityType === 'email') {
          try {
            await sendAdminAlert(svc, client, activity, lead, 'human_action_required',
              `Lead requested specific content via email. Please send the appropriate materials manually.`);
            results.admin_alerts_sent++;
          } catch (alertErr) {
            console.error(`[FollowupEngine] Admin alert for email failed: ${alertErr.message}`);
          }

          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + `\n[Engine] Admin alerted — human email required at ${now.toISOString()}`
          });
        }

        // ============================================================
        // 3. APPOINTMENT / DEMO / VISIT / MEETING → Human action needed
        //    Send reminder to lead + alert to client admin
        // ============================================================
        else if (['appointment', 'demo', 'visit', 'meeting', 'booking'].includes(activityType)) {
          // Send reminder to lead — format time in IST
          if (lead?.email) {
            try {
              // Convert UTC scheduled date to IST for display in email
              const istScheduled = new Date(scheduledDate.getTime() + (5.5 * 60 * 60 * 1000));
              const istDateStr = istScheduled.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
              const reminderContent = await azureLLM(
                `Write a brief reminder email for ${lead.name || 'customer'} about their ${activityType}: "${activity.title}". Scheduled: ${istDateStr} IST. From ${client?.company_name || 'Bolify AI'}. Under 80 words, HTML body only. IMPORTANT: Show the time as ${istDateStr} IST in the email.`,
                'You are an email copywriter. Always respond in valid JSON.',
                { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" } } }
              );
              await sendEmailViaACS({
                to: lead.email,
                fromName: client?.company_name || 'Bolify AI',
                subject: reminderContent.subject,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${reminderContent.body_html}</div>`
              });
              results.reminders_sent++;
              console.log(`[FollowupEngine] ✅ Reminder sent to ${lead.email}`);
            } catch (e) {
              console.error(`[FollowupEngine] Lead reminder failed: ${e.message}`);
            }
          }

          // ALERT CLIENT ADMIN — human action required
          try {
            await sendAdminAlert(svc, client, activity, lead, 'human_action_required',
              `${activityType.toUpperCase()} scheduled. Human agent action needed.`);
            results.admin_alerts_sent++;
          } catch (alertErr) {
            console.error(`[FollowupEngine] Admin alert failed: ${alertErr.message}`);
          }

          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + `\n[Engine] Reminder + admin alert sent at ${now.toISOString()}`
          });
        }

        // ============================================================
        // 4. TASK → Alert admin, mark overdue
        // ============================================================
        else if (activityType === 'task') {
          try {
            await sendAdminAlert(svc, client, activity, lead, 'task_due',
              `Task is due and requires attention.`);
            results.admin_alerts_sent++;
          } catch (alertErr) {
            console.error(`[FollowupEngine] Admin alert failed: ${alertErr.message}`);
          }

          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true, status: hoursPast > 4 ? 'overdue' : 'scheduled',
            notes: (activity.notes || '') + `\n[Engine] Admin alerted at ${now.toISOString()}`
          });
          if (hoursPast > 4) results.marked_overdue++;
        }

        else {
          console.log(`[FollowupEngine] Unknown type: ${activityType}, skipping`);
          results.skipped++;
        }

      } catch (activityErr) {
        // ── Per-activity error: log it and continue to next ──
        console.error(`[FollowupEngine] Error processing activity ${activity.id} (${activity.title}): ${activityErr.message}`);
        results.errors.push({ activity_id: activity.id, title: activity.title, error: activityErr.message });
        // Mark as processed to avoid retrying the same broken activity forever
        try {
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + `\n[Engine] Error: ${activityErr.message}`
          });
        } catch (_) {}
      }
    }

    const elapsedSec = Math.round((Date.now() - runStart) / 1000);
    console.log(`[FollowupEngine] Done in ${elapsedSec}s. Calls:${results.calls_initiated} Emails:${results.emails_sent} Alerts:${results.admin_alerts_sent} Overdue:${results.marked_overdue} Errors:${results.errors.length} StoppedEarly:${stoppedEarly}`);
    return Response.json({ success: true, processed: activities.length, elapsed_sec: elapsedSec, stopped_early: stoppedEarly, ...results });

  } catch (error) {
    console.error('[FollowupEngine] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});


// ============================================================
// ADMIN EMAIL ALERT — Uses Azure Communication Services
// ============================================================
async function sendAdminAlert(svc, client, activity, lead, alertType, reason) {
  if (!client?.email) {
    console.warn(`[FollowupEngine] Cannot send admin alert: no client email`);
    return;
  }

  const leadName = lead?.name || 'Unknown Lead';
  const leadPhone = lead?.phone || 'N/A';
  const leadEmail = lead?.email || 'N/A';
  const companyName = client.company_name || 'Your Company';

  const typeLabels = {
    human_action_required: '🏃 Human Action Required',
    task_due: '📋 Task Due',
    auto_call_failed: '⚠️ Auto-Call Failed'
  };
  const label = typeLabels[alertType] || '🔔 Activity Alert';

  const actionGuide = {
    'visit': 'Send location details to the lead and confirm the visit timing.',
    'demo': 'Prepare the demo environment and send meeting link/instructions.',
    'appointment': 'Confirm the appointment and prepare relevant materials.',
    'meeting': 'Send meeting details (agenda, link) to all participants.',
    'booking': 'Confirm the booking and share details with the lead.',
    'task': 'Complete the assigned task and update the lead status.'
  };
  const suggestedAction = actionGuide[activity.type] || 'Review and take appropriate action.';

  const emailBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,#dc2626,#b91c1c);padding:20px 30px;border-radius:12px 12px 0 0;">
        <h2 style="color:white;margin:0;">${label}</h2>
        <p style="color:#fecaca;margin:4px 0 0;font-size:13px;">${companyName} — Bolify AI Automation Engine</p>
      </div>
      <div style="padding:24px 30px;background:white;border:1px solid #e2e8f0;border-top:none;">
        <h3 style="color:#1e293b;margin:0 0 8px;">${activity.title || activity.type}</h3>
        <p style="color:#64748b;margin:0 0 16px;font-size:14px;">${reason}</p>
        
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#64748b;width:120px;">Lead Name:</td><td style="padding:8px 0;color:#1e293b;font-weight:600;">${leadName}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Phone:</td><td style="padding:8px 0;color:#1e293b;">${leadPhone}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Email:</td><td style="padding:8px 0;color:#1e293b;">${leadEmail}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Type:</td><td style="padding:8px 0;color:#1e293b;">${activity.type?.toUpperCase()}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Priority:</td><td style="padding:8px 0;color:${activity.priority === 'high' ? '#dc2626' : '#1e293b'};font-weight:600;">${(activity.priority || 'medium').toUpperCase()}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Scheduled:</td><td style="padding:8px 0;color:#1e293b;">${new Date(activity.scheduled_date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST</td></tr>
        </table>

        ${activity.description ? `<div style="margin:16px 0;padding:12px;background:#f8fafc;border-radius:8px;border-left:3px solid #3b82f6;"><p style="margin:0;color:#334155;font-size:13px;">${activity.description}</p></div>` : ''}
        ${activity.notes ? `<div style="margin:8px 0;padding:12px;background:#fffbeb;border-radius:8px;border-left:3px solid #f59e0b;"><p style="margin:0;color:#92400e;font-size:13px;"><strong>Notes:</strong> ${activity.notes.substring(0, 300)}</p></div>` : ''}

        <div style="margin:20px 0;padding:16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
          <p style="margin:0;color:#166534;font-size:14px;"><strong>✅ Suggested Action:</strong> ${suggestedAction}</p>
        </div>

        ${lead?.notes ? `<div style="margin:12px 0;padding:12px;background:#f1f5f9;border-radius:8px;"><p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;">LEAD HISTORY:</p><p style="margin:0;color:#334155;font-size:13px;">${lead.notes.substring(0, 400)}</p></div>` : ''}
      </div>
      <div style="padding:16px 30px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
        <p style="margin:0;color:#94a3b8;font-size:12px;">Sent by Bolify AI Follow-up Automation Engine</p>
      </div>
    </div>`;

  await sendEmailViaACS({
    to: client.email,
    fromName: 'Bolify AI Automation',
    subject: `[${label}] ${activity.title || activity.type} — ${leadName}`,
    html: emailBody
  });
  console.log(`[FollowupEngine] Admin alert sent to ${client.email}: ${alertType}`);
}