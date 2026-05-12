import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Paginated fetch: returns ALL CampaignLeads for a campaign (handles >1000 leads).
// Base44's filter() defaults to 1000-record cap — using this avoids premature completion.
async function fetchAllCampaignLeads(svc, campaignId) {
  const PAGE = 500;
  let all = [];
  let skip = 0;
  while (true) {
    const batch = await svc.entities.CampaignLead.filter(
      { campaign_id: campaignId }, 'created_date', PAGE, skip
    );
    if (!batch || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < PAGE) break;
    skip += PAGE;
    if (skip > 100000) break; // safety hard-cap at 100k leads
  }
  return all;
}

// This function runs every 5 minutes to:
// 1. Fix stuck "calling" leads (calls that never got a webhook callback)
// 2. Automatically trigger next batch of calls for running campaigns
// 3. Auto-complete campaigns when all leads are processed

// TRAI Compliance: promotional/transactional voice calls allowed only between 9 AM and 9 PM IST
// Returns { inWindow, istHour, istString }
function getISTWindowStatus() {
  const now = new Date();
  // IST = UTC+5:30 — derive IST hour without relying on server tz
  const istMs = now.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
  const istHour = ist.getUTCHours();
  const istMin = ist.getUTCMinutes();
  // Window: 09:00 (inclusive) to 21:00 (exclusive)
  const inWindow = istHour >= 9 && istHour < 21;
  const istString = `${String(istHour).padStart(2, '0')}:${String(istMin).padStart(2, '0')} IST`;
  return { inWindow, istHour, istString };
}

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
      console.log('[campaignPoller] Triggered by external cron');
    }

    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const results = { campaigns_processed: 0, stuck_fixed: 0, batches_triggered: 0, completed: 0, scheduled_started: 0, auto_paused: 0, auto_resumed: 0, errors: [] };

    // === TRAI WINDOW CHECK (9 AM – 9 PM IST) ===
    const { inWindow, istString } = getISTWindowStatus();
    console.log(`[campaignPoller] Current time: ${istString} — TRAI window ${inWindow ? 'OPEN' : 'CLOSED'}`);

    // === AUTO-PAUSE running campaigns outside window ===
    if (!inWindow) {
      const activeCampaigns = await svc.entities.Campaign.filter({ status: 'running' }, 'created_date', 500);
      for (const c of activeCampaigns) {
        await svc.entities.Campaign.update(c.id, {
          status: 'paused',
          notes: `${c.notes || ''}\n[${new Date().toISOString()}] Auto-paused: outside TRAI 9AM-9PM IST window (paused at ${istString}).`.trim()
        });
        results.auto_paused++;
        console.log(`[campaignPoller] TRAI auto-pause: "${c.name}" paused at ${istString}`);
      }
    }

    // === AUTO-RESUME paused (auto-paused) campaigns when window opens ===
    let autoResumed = 0;
    if (inWindow) {
      const pausedCampaigns = await svc.entities.Campaign.filter({ status: 'paused' }, 'created_date', 500);
      for (const c of pausedCampaigns) {
        // Only auto-resume campaigns that were auto-paused by TRAI window check
        if (c.notes && c.notes.includes('Auto-paused: outside TRAI')) {
          await svc.entities.Campaign.update(c.id, {
            status: 'running',
            notes: `${c.notes}\n[${new Date().toISOString()}] Auto-resumed: TRAI window opened (resumed at ${istString}).`
          });
          autoResumed++;
          results.auto_resumed++;
          console.log(`[campaignPoller] TRAI auto-resume: "${c.name}" resumed at ${istString}`);
        }
      }
    }

    // Auto-start any scheduled campaigns whose time has arrived (only if window is open)
    const nowMs = Date.now();
    let autoStarted = 0;
    if (inWindow) {
      const scheduledCampaigns = await svc.entities.Campaign.filter({ status: 'scheduled' }, 'created_date', 200);
      for (const sc of scheduledCampaigns) {
        if (!sc.scheduled_date) continue;
        const schedMs = new Date(sc.scheduled_date).getTime();
        if (isNaN(schedMs)) continue;
        if (schedMs <= nowMs) {
          await svc.entities.Campaign.update(sc.id, {
            status: 'running',
            started_at: new Date().toISOString()
          });
          autoStarted++;
          console.log(`[campaignPoller] Auto-started scheduled campaign "${sc.name}" (scheduled ${sc.scheduled_date})`);
        }
      }
    } else {
      // TRAI window closed — auto-pause any scheduled campaigns whose start time has arrived,
      // so they're visible as paused (not stuck "scheduled") and will auto-resume at 9 AM IST.
      const dueScheduled = await svc.entities.Campaign.filter({ status: 'scheduled' }, 'created_date', 200);
      let scheduledPaused = 0;
      for (const sc of dueScheduled) {
        if (!sc.scheduled_date) continue;
        const schedMs = new Date(sc.scheduled_date).getTime();
        if (isNaN(schedMs) || schedMs > nowMs) continue;
        await svc.entities.Campaign.update(sc.id, {
          status: 'paused',
          notes: `${sc.notes || ''}\n[${new Date().toISOString()}] Auto-paused: scheduled start fell outside TRAI 9AM-9PM IST window (paused at ${istString}). Will auto-resume at 9 AM IST.`.trim()
        });
        scheduledPaused++;
        console.log(`[campaignPoller] TRAI auto-pause (scheduled): "${sc.name}" — start time was outside window`);
      }
      results.auto_paused += scheduledPaused;
      console.log(`[campaignPoller] TRAI window closed — auto-paused ${scheduledPaused} due scheduled campaign(s)`);
    }

    // If outside window, skip the dialing loop entirely (campaigns already paused above)
    if (!inWindow) {
      console.log(`[campaignPoller] Outside TRAI window — paused ${results.auto_paused} campaign(s), skipping dialing.`);
      return Response.json({ success: true, trai_window_open: false, current_ist: istString, ...results });
    }

    // Find all running campaigns (includes the ones just auto-started/resumed)
    const runningCampaigns = await svc.entities.Campaign.filter({ status: 'running' });
    console.log(`[campaignPoller] Found ${runningCampaigns.length} running campaigns (${autoStarted} just auto-started, ${autoResumed} auto-resumed)`);

    for (const campaign of runningCampaigns) {
      try {
        results.campaigns_processed++;
        const campaignId = campaign.id;

        // === STEP 1: Fix stuck "calling" and "processing" leads ===
        const stuckCalling = await svc.entities.CampaignLead.filter(
          { campaign_id: campaignId, status: 'calling' }, 'created_date', 100
        );
        const stuckProcessing = await svc.entities.CampaignLead.filter(
          { campaign_id: campaignId, status: 'processing' }, 'created_date', 100
        );
        // Processing leads stuck >5 min → force to completed (campaignPostCall died mid-execution)
        for (const pl of stuckProcessing) {
          const procAge = Date.now() - new Date(pl.updated_date || pl.created_date).getTime();
          if (procAge > 5 * 60 * 1000) {
            console.log(`[campaignPoller] Processing lead ${pl.lead_name} stuck >5min — forcing to completed`);
            await svc.entities.CampaignLead.update(pl.id, {
              status: 'completed', outcome: pl.outcome || 'neutral',
              conversation_summary: (pl.conversation_summary || '') + '\n[Poller] Recovered from stuck processing state.'
            });
            results.stuck_fixed++;
          }
        }
        const stuckLeads = stuckCalling;

        for (const cl of stuckLeads) {
          const leadAge = Date.now() - new Date(cl.updated_date || cl.created_date).getTime();
          const STUCK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

          if (leadAge < STUCK_TIMEOUT_MS) continue; // Still fresh, skip

          if (cl.call_log_id) {
            try {
              const callLog = await svc.entities.CallLog.get(cl.call_log_id);
              const terminalStatuses = ['completed', 'failed', 'no_answer'];

              if (callLog && terminalStatuses.includes(callLog.status)) {
                // CallLog reached terminal — sync CampaignLead
                let outcome = 'neutral';
                let callStatusVal = 'answered';
                if (callLog.status === 'no_answer' || callLog.status === 'failed') { outcome = 'not_answered'; callStatusVal = 'not_answered'; }
                if (callLog.transcript && callLog.transcript.length > 30) { outcome = 'neutral'; callStatusVal = 'answered'; }

                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed', outcome, call_status: callStatusVal,
                  conversation_summary: callLog.conversation_summary || 'Call completed (recovered by poller)',
                  transcript: callLog.transcript || '',
                  call_duration: callLog.duration || 0
                });
                console.log(`[campaignPoller] Fixed stuck lead ${cl.lead_name}: CallLog was ${callLog.status} → outcome=${outcome}`);
                results.stuck_fixed++;
              } else if (callLog && callLog.status === 'answered') {
                // Call is actively in progress (WebSocket streaming) — skip, don't time it out
                // Use a longer timeout (10 min) for answered calls since conversations can be long
                const ACTIVE_CALL_TIMEOUT = 10 * 60 * 1000;
                if (leadAge > ACTIVE_CALL_TIMEOUT) {
                  console.log(`[campaignPoller] Answered call for ${cl.lead_name} exceeded 10min — forcing completion`);
                  await svc.entities.CallLog.update(cl.call_log_id, {
                    status: 'completed', call_end_time: new Date().toISOString(),
                    conversation_summary: callLog.conversation_summary || 'Call timed out (10min limit).'
                  });
                  results.stuck_fixed++;
                } else {
                  console.log(`[campaignPoller] Skipping ${cl.lead_name} — call actively answered (${Math.round(leadAge/1000)}s)`);
                }
              } else {
                // CallLog in ringing/initiated or missing — true timeout
                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
                  conversation_summary: 'Call timed out — no response from telephony provider.'
                });
                if (cl.call_log_id) {
                  await svc.entities.CallLog.update(cl.call_log_id, {
                    status: 'no_answer', call_end_time: new Date().toISOString(),
                    conversation_summary: 'Call timed out — no Smartflo webhook callback received.'
                  });
                }
                console.log(`[campaignPoller] Timed out stuck lead ${cl.lead_name} (${cl.lead_phone})`);
                results.stuck_fixed++;
              }
            } catch (e) {
              console.error(`[campaignPoller] Error fixing lead ${cl.lead_name}: ${e.message}`);
            }
          } else {
            await svc.entities.CampaignLead.update(cl.id, { status: 'pending', call_log_id: null });
            console.log(`[campaignPoller] Reset orphan lead ${cl.lead_name} to pending`);
            results.stuck_fixed++;
          }
        }

        // === STEP 2: Check if campaign should be completed ===
        // Paginated fetch — handles campaigns with >1000 leads (previously capped at 1000)
        const allLeads = await fetchAllCampaignLeads(svc, campaignId);
        const pendingCount = allLeads.filter(l => l.status === 'pending').length;
        const callingCount = allLeads.filter(l => ['calling', 'processing'].includes(l.status)).length;
        const completedCount = allLeads.filter(l => l.status === 'completed').length;
        const failedCount = allLeads.filter(l => l.status === 'failed').length;

        const outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
        allLeads.forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
        await svc.entities.Campaign.update(campaignId, {
          calls_completed: completedCount, calls_failed: failedCount, outcomes_summary: outcomes
        });

        // Filter out leads with future retry dates
        const now = new Date();
        const pendingReadyCount = allLeads.filter(l => 
          l.status === 'pending' && (!l.followup_call_date || new Date(l.followup_call_date) <= now)
        ).length;
        const pendingRetryLaterCount = allLeads.filter(l => 
          l.status === 'pending' && l.followup_call_date && new Date(l.followup_call_date) > now
        ).length;

        if (pendingReadyCount === 0 && callingCount === 0 && pendingRetryLaterCount === 0) {
          await svc.entities.Campaign.update(campaignId, {
            status: 'completed', completed_at: new Date().toISOString()
          });
          console.log(`[campaignPoller] Campaign "${campaign.name}" completed: ${completedCount} done, ${failedCount} failed`);
          results.completed++;
          continue;
        }

        if (pendingRetryLaterCount > 0 && pendingReadyCount === 0 && callingCount === 0) {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingRetryLaterCount} leads waiting for retry later. Skipping.`);
          continue;
        }

        // === STEP 3: Trigger next batch INLINE (no cross-function invoke) ===
        const maxConcurrent = campaign.max_concurrent_calls || 5;
        if (pendingReadyCount > 0 && callingCount < maxConcurrent) {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingCount} pending, ${callingCount} calling — triggering next batch`);
          try {
            const agent = await svc.entities.Agent.get(campaign.agent_id);
            const agentDIDs = (agent?.assigned_dids?.length > 0)
              ? agent.assigned_dids
              : (agent?.assigned_did ? [agent.assigned_did] : []);

            if (!agent || agentDIDs.length === 0) {
              console.log(`[campaignPoller] Agent has no DIDs for "${campaign.name}"`);
              continue;
            }

            // KB is searched on-demand via search_knowledge_base tool — store URI only
            const kbFileUri = agent.kb_file_uri || '';

            const slotsAvailable = Math.max(0, maxConcurrent - callingCount);
            const pendingBatchRaw = await svc.entities.CampaignLead.filter(
              { campaign_id: campaignId, status: 'pending' }, 'created_date', 200
            );
            // Only pick leads that are ready to call (no future retry date)
            const pendingBatch = pendingBatchRaw.filter(l => 
              !l.followup_call_date || new Date(l.followup_call_date) <= now
            ).slice(0, slotsAvailable);

            for (let i = 0; i < pendingBatch.length; i++) {
              const cl = pendingBatch[i];
              try {
                // RE-READ to prevent race with campaignPostCall.triggerNextBatch
                const freshLead = await svc.entities.CampaignLead.get(cl.id);
                if (freshLead.status !== 'pending') {
                  console.log(`[campaignPoller] Lead ${cl.lead_name} status changed to ${freshLead.status} — skipping (race avoided)`);
                  continue;
                }

                const selectedDID = agentDIDs[i % agentDIDs.length];
                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
                });

                const cleanPhone = (cl.lead_phone || '').replace(/[^0-9]/g, '');
                const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

                let leadContext = '';
                try {
                  let lead = null;
                  if (cl.lead_id) {
                    try { lead = await svc.entities.Lead.get(cl.lead_id); } catch (_) {}
                  }
                  if (lead) {
                    const ctxParts = [`CUSTOMER PROFILE:`, `- Name: ${lead.name || cl.lead_name || 'Unknown'}`];
                    if (lead.phone) ctxParts.push(`- Phone: ${lead.phone}`);
                    if (lead.email) ctxParts.push(`- Email: ${lead.email}`);
                    if (lead.company) ctxParts.push(`- Company: ${lead.company}`);
                    if (lead.status) ctxParts.push(`- Status: ${lead.status}`);
                    ctxParts.push(`\nCRITICAL: Address the customer by name "${lead.name || cl.lead_name || 'Sir/Madam'}".`);
                    if (lead.email) ctxParts.push(`If confirming email, use: "${lead.email}"`);
                    if (lead.company) ctxParts.push(`Reference their company "${lead.company}" naturally.`);
                    leadContext = ctxParts.join('\n');
                  } else {
                    leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
                  }
                } catch (_) {}

                const personalizedPrompt = [
                  agent.system_prompt || '',
                  campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
                  campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
                  campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
                  campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
                  leadContext ? `\n\n--- LEAD CONTEXT ---\n${leadContext}` : ''
                ].filter(Boolean).join('\n');

                // Use campaign script's "opening" as greeting if present (overrides agent default)
                let campaignGreeting = agent.greeting_message || '';
                if (campaign.call_script?.opening && campaign.call_script.opening.trim()) {
                  let leadCompany = '';
                  if (cl.lead_id) { try { leadCompany = (await svc.entities.Lead.get(cl.lead_id))?.company || ''; } catch (_) {} }
                  campaignGreeting = campaign.call_script.opening
                    .replace(/\{\{name\}\}/gi, cl.lead_name || 'Sir/Madam')
                    .replace(/\{\{company\}\}/gi, leadCompany)
                    .trim();
                  console.log(`[campaignPoller] Using campaign opening as greeting for ${cl.lead_name}`);
                }

                const callLog = await svc.entities.CallLog.create({
                  client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
                  call_sid: callSid, caller_id: selectedDID, callee_number: cleanPhone,
                  direction: 'outbound', status: 'initiated', call_start_time: new Date().toISOString(),
                  agent_config_cache: {
                    agent_name: agent.name, system_prompt: personalizedPrompt,
                    persona: agent.persona || {},
                    kb_file_uri: kbFileUri,
                    lead_context: leadContext,
                    greeting_message: campaignGreeting
                  }
                });

                await svc.entities.CampaignLead.update(cl.id, { call_log_id: callLog.id });

                // Use agent's own API token (falls back to global key for demo agents)
                let smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
                try {
                  const clientData = await svc.entities.Client.get(campaign.client_id);
                  const isDemoAgent = clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding');
                  if (isDemoAgent) smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
                } catch (_) {}

                let cleanCallerID = selectedDID.replace(/[^0-9]/g, '');
                if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;

                // Pass call_log_id via custom_identifier — Smartflo echoes it back to streamAudio for EXACT match
                const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    api_key: smartfloApiKey,
                    customer_number: cleanPhone,
                    caller_id: cleanCallerID,
                    custom_identifier: callLog.id,
                    async: 1
                  })
                });

                const smartfloData = await smartfloResp.json();
                if (smartfloResp.ok && smartfloData.success !== false) {
                  const newCallSid = smartfloData.call_id || smartfloData.ref_id || smartfloData.call_sid || callSid;
                  await svc.entities.CallLog.update(callLog.id, { call_sid: newCallSid, status: 'ringing' });
                  console.log(`[campaignPoller] Call initiated: ${cl.lead_name} → ${cleanPhone}`);
                } else {
                  await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
                  await svc.entities.CampaignLead.update(cl.id, {
                    status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
                    conversation_summary: `Smartflo error: ${smartfloData.message || 'Unknown'}`
                  });
                }

                if (i < pendingBatch.length - 1) await new Promise(r => setTimeout(r, 500));
              } catch (e) {
                console.error(`[campaignPoller] Call error for ${cl.lead_name}: ${e.message}`);
                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
                  conversation_summary: `Error: ${e.message}`
                });
              }
            }

            results.batches_triggered++;
            console.log(`[campaignPoller] Triggered ${pendingBatch.length} calls for "${campaign.name}"`);
          } catch (e) {
            console.error(`[campaignPoller] Failed to trigger batch for "${campaign.name}": ${e.message}`);
            results.errors.push({ campaign: campaign.name, error: e.message });
          }
        } else {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingCount} pending, ${callingCount} calling — waiting for slots`);
        }
      } catch (e) {
        console.error(`[campaignPoller] Error processing campaign "${campaign.name}": ${e.message}`);
        results.errors.push({ campaign: campaign.name, error: e.message });
      }
    }

    results.scheduled_started = autoStarted;
    return Response.json({ success: true, trai_window_open: true, current_ist: istString, ...results });
  } catch (error) {
    console.error('[campaignPoller] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});