import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";


// ─── Send lead email via the CLIENT's configured provider (Zoho/SMTP/Resend/etc.) ───
// Routes through sendViaClientProvider so leads see the client's own sender
// (e.g. noreply@analyticslearners.com) instead of DoNotReply@vaaniai.io.
// Falls back to Vaani ACS only when the client has no provider configured.
async function sendLeadEmail(base44, { to, fromName, subject, html, clientId }) {
  const res = await base44.functions.invoke('sendViaClientProvider', {
    client_id: clientId || null,
    to,
    subject,
    html,
    from_name: fromName || 'VaaniAI'
  });
  if (!res?.data?.success) throw new Error(res?.data?.error || 'Email dispatch failed');
  return res.data;
}

// ─── Mirror CampaignLead update into Postgres (inline dual-write) ───
// Updates Base44 AND mirrors operational fields to the Postgres `campaign_leads`
// table in one step (fire-and-forget). Removes the credit-gated entity-automation
// dependency so the mirror stays live at zero integration-credit cost.
async function updateCL(base44, id, campaignId, fields) {
  await base44.entities.CampaignLead.update(id, fields);
  base44.functions.invoke('pgCampaignLeadSync', {
    campaign_lead: { id, campaign_id: campaignId, ...fields }
  }).catch((e) => console.warn(`[campaignPostCall] pg mirror skipped: ${e.message}`));
}

// ─── Mirror a Lead update into Postgres (inline dual-write) ───
// Updates Base44 Lead AND mirrors the small set of fields pgLeadSync tracks
// (status/qualification_tier/source/has_call) at zero integration-credit cost,
// so the PG leads mirror stays live without the credit-gated entity automation.
async function updateLead(base44, leadId, clientId, fields) {
  await base44.entities.Lead.update(leadId, fields);
  base44.functions.invoke('pgLeadSync', {
    lead: { id: leadId, client_id: clientId, ...fields }
  }).catch((e) => console.warn(`[campaignPostCall] pg lead mirror skipped: ${e.message}`));
}

// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
async function azureLLM(prompt, systemPrompt, jsonSchema) {
          const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
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

// ─── Run the demo/meeting action extractor for a campaign call ───
// Campaign calls go through THIS pipeline, which only sends generic "interested"
// emails + creates followup/task activities. It never extracted demo/meeting
// bookings, never created the Google Calendar event, and never dispatched the
// Meet link on WhatsApp/email — so when a customer agreed to a demo on a CAMPAIGN
// call, they received nothing. We now invoke postCallActionExtractor here (exactly
// like postCallOrchestrator does for manual calls), passing the resolved CallLog
// so it works even when the CallLog lives only in Postgres (campaign dials) and a
// Base44 .get would 404. The extractor already dedupes activities and skips generic
// campaign followups, so this adds the demo flow without creating duplicates.
async function runActionExtractor(base44, callLog) {
  if (!callLog || !callLog.transcript || callLog.transcript.length <= 50) return;
  try {
    const r = await base44.functions.invoke('postCallActionExtractor', {
      call_log_id: callLog.id,
      call_log: callLog,
    });
    console.log(`[campaignPostCall] action extractor:`, JSON.stringify(r?.data || {}).substring(0, 200));
  } catch (e) {
    console.error(`[campaignPostCall] action extractor failed: ${e.message}`);
  }
}

// NOTE: This function is an ENTITY AUTOMATION triggered by CallLog updates.
// There is NO user session — we MUST use service role directly.
export default async function campaignPostCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Entity automation — no user session, use service role from request
    const client = base44;;
    const base44 = client.asServiceRole;
    const payload = await c.req.json();
    const { event, data, old_data } = payload;

    if (!event || event.entity_name !== 'CallLog') {
      return c.json({ data: { success: true, skipped: 'not_call_log' } });
    }

    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    if (!terminalStatuses.includes(data.status)) {
      return c.json({ data: { success: true, skipped: 'not_terminal' } });
    }

    const callLogId = event.entity_id;
    const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: callLogId });
    if (campaignLeads.length === 0) {
      return c.json({ data: { success: true, skipped: 'not_campaign_call' } });
    }

    const campaignLead = campaignLeads[0];
    
    // Idempotency: if CampaignLead is already completed/failed/processing, skip
    // (smartfloWebhook already triggered the next call inline)
    if (['completed', 'failed', 'processing'].includes(campaignLead.status)) {
      console.log(`[campaignPostCall] CampaignLead ${campaignLead.id} already ${campaignLead.status} — running AI analysis only`);
      
      // Re-read the CallLog to get the latest transcript (streamAudio may have updated it after webhook)
      const callLog = await base44.entities.CallLog.get(callLogId);
      
      // ALWAYS sync transcript/summary back to CampaignLead if it was missing
      if (callLog.transcript && !campaignLead.transcript) {
        await base44.entities.CampaignLead.update(campaignLead.id, {
          transcript: callLog.transcript,
          conversation_summary: callLog.conversation_summary || campaignLead.conversation_summary || '',
          call_duration: callLog.duration || campaignLead.call_duration || 0
        });
        console.log(`[campaignPostCall] Synced transcript to CampaignLead ${campaignLead.id}`);
      }
      
      // Run AI analysis/emails if we have a transcript
      if (callLog.transcript && callLog.transcript.length > 50 && campaignLead.status === 'completed') {
        const alreadyAnalyzed = callLog.lead_status_updated && callLog.transcript;
        if (alreadyAnalyzed) {
          const statusToOutcome = {
            'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback',
            'voicemail': 'voicemail', 'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral', 'do_not_call': 'do_not_call'
          };
          const outcome = statusToOutcome[callLog.lead_status_updated] || campaignLead.outcome || 'neutral';
          const summary = callLog.conversation_summary || campaignLead.conversation_summary || '';
          // Also update outcome on CampaignLead if it changed
          if (outcome !== campaignLead.outcome) {
            await updateCL(base44, campaignLead.id, campaignLead.campaign_id, { outcome, conversation_summary: summary });
          }
          await doFollowUpActions(base44, callLog, campaignLead, campaignLead.campaign_id, outcome, summary);
          await runActionExtractor(base44, callLog);
        } else if (callLog.transcript || callLog.conversation_summary) {
          await doAIAnalysis(base44, callLog, campaignLead, campaignLead.campaign_id, campaignLead.outcome || 'neutral', campaignLead.conversation_summary || '');
          await runActionExtractor(base44, callLog);
        }
        await updateCampaignStats(base44, campaignLead.campaign_id);
      }
      
      return c.json({ data: { success: true, skipped: 'already_processed_by_webhook', ai_ran: true } });
    }
    
    // Idempotency: if CampaignLead is still pending (retry queued), skip
    if (campaignLead.status === 'pending') {
      return c.json({ data: { success: true, skipped: 'already_pending_retry' } });
    }

    // ATOMIC LOCK: Immediately set status to 'processing' to prevent race conditions
    // when multiple CallLog updates fire this automation simultaneously.
    // If another instance already set it to 'processing', the filter above will catch it.
    await updateCL(base44, campaignLead.id, campaignLead.campaign_id, { status: 'processing' });
    console.log(`[campaignPostCall] Locked CampaignLead ${campaignLead.id} → processing`);

    const callLog = data;
    const campaignId = campaignLead.campaign_id;
    console.log(`[campaignPostCall] Processing call ${callLogId} for campaign ${campaignId}`);

    // =====================================================
    // STEP 1: FAST — Determine basic outcome (no LLM)
    // =====================================================
    let outcome = 'neutral';
    let callStatus = 'answered';
    let summary = callLog.conversation_summary || '';

    if (callLog.status === 'no_answer') {
      outcome = 'not_answered';
      callStatus = 'not_answered';
      summary = summary || 'Call was not answered.';
    } else if (callLog.status === 'failed') {
      outcome = 'not_answered';
      callStatus = 'not_answered';
      summary = summary || 'Call failed to connect.';
    } else if (!callLog.transcript && !callLog.conversation_summary) {
      outcome = 'neutral';
      callStatus = 'answered';
      summary = 'Call connected but no transcript captured.';
    }
    // If there IS a transcript, we'll analyze with LLM later but use 'neutral' for now

    // =====================================================
    // STEP 2: FAST — Mark campaign lead as completed immediately
    // =====================================================
    await updateCL(base44, campaignLead.id, campaignId, {
      status: 'completed',
      outcome: outcome,
      call_status: callStatus,
      conversation_summary: summary,
      transcript: callLog.transcript || '',
      call_duration: callLog.duration || 0
    });
    console.log(`[campaignPostCall] Lead ${campaignLead.lead_name} marked completed: outcome=${outcome}, call_status=${callStatus}`);

    // Incremental counter bump (+1) — single-record update, no lead re-scan.
    // 'failed' status maps to calls_failed; everything else counts as completed.
    // The poller's full recount reconciles any drift; this never drives completion.
    await bumpCampaignCounter(base44, campaignId, {
      completed: callLog.status !== 'failed',
      failed: callLog.status === 'failed',
      outcome
    });

    // =====================================================
    // STEP 3: FAST — Handle no-answer retry (before next batch)
    // =====================================================
    let retryScheduled = false;
    let noAnswerOutreachSent = false;
    if (outcome === 'not_answered') {
      const campaign = await base44.entities.Campaign.get(campaignId);
      const rules = campaign?.followup_rules || {};
      const maxRetries = rules.no_answer_max_retries || 3;
      const currentAttempts = (campaignLead.attempt_count || 0) + 1;
      const allRetriesExhausted = currentAttempts >= maxRetries || rules.no_answer_retry === false;

      if (rules.no_answer_retry !== false && currentAttempts < maxRetries) {
        const retryHours = rules.no_answer_retry_hours || 4;
        await updateCL(base44, campaignLead.id, campaignId, {
          status: 'pending', outcome: 'not_answered',
          attempt_count: currentAttempts, call_log_id: null,
          followup_call_date: new Date(Date.now() + retryHours * 3600000).toISOString()
        });
        console.log(`[campaignPostCall] Not-answered retry ${currentAttempts}/${maxRetries} queued`);
        retryScheduled = true;
      }

      // Send no-answer outreach (email / WhatsApp) per campaign rules
      const shouldSendNow = (rules.no_answer_whatsapp_after_retries === false) || allRetriesExhausted;
      if (shouldSendNow && !campaignLead.followup_email_sent) {
        noAnswerOutreachSent = await sendNoAnswerOutreach(base44, campaign, campaignLead, callLog);
      }
    }

    // =====================================================
    // STEP 4: FAST — Trigger next batch IMMEDIATELY
    // This is the critical fix — don't wait for AI analysis
    // =====================================================
    const nextBatchResult = await triggerNextBatch(base44, campaignId);
    console.log(`[campaignPostCall] Next batch: ${JSON.stringify(nextBatchResult)}`);

    // De-dupe guard: triggerNextBatch already paginated all statuses and, when the
    // campaign is fully done, updated Campaign (status + counts + outcomes). In that
    // case the updateCampaignStats() call below would re-scan every lead a second
    // time within the same invocation for no benefit. Skip the redundant recount.
    // The 5-min campaignPoller still runs a full reconcile as the safety net, so
    // counters stay correct even if anything drifts. Call/voice paths untouched.
    const campaignAlreadyFinalized = nextBatchResult?.completed === true;

    // =====================================================
    // STEP 5: SLOW — AI analysis, scoring, emails, activities
    // This runs AFTER next batch is already triggered.
    // NOTE: streamAudio.saveCallRecord now does AI analysis + lead scoring.
    // If transcript & lead_status_updated already present, skip duplicate LLM calls.
    // =====================================================
    let aiResult = {};
    // SINGLE SOURCE OF TRUTH: the container (streamGeminiOutgoing) already scores
    // every call and writes the COMPLETE score/status/sentiment/tier/summary +
    // call_history to Postgres `leads`. To stop competing writers from clobbering
    // that, campaignPostCall must NOT re-run its own LLM scoring whenever a real
    // transcript exists — it only maps the outcome for the CampaignLead and runs
    // follow-up emails/activities (which READ scoring from the lead, never rewrite
    // it). We treat ANY answered call with a transcript as already-analyzed so the
    // container's scoring is authoritative. Only genuinely transcript-less calls
    // fall through to the minimal metadata update below.
    const alreadyAnalyzed = (callLog.transcript && callLog.transcript.length > 30) || callLog.lead_status_updated;

    if (alreadyAnalyzed) {
      // streamAudio already did AI analysis + Lead scoring — just map outcome for CampaignLead
      const statusToOutcome = {
        'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback',
        'voicemail': 'voicemail', 'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral',
        'do_not_call': 'do_not_call'
      };
      outcome = statusToOutcome[callLog.lead_status_updated] || outcome;
      summary = callLog.conversation_summary || summary;
      // NOTE: Lead is already updated by streamAudio — only update CampaignLead here
      await updateCL(base44, campaignLead.id, campaignId, { outcome, conversation_summary: summary });
      
      // Run follow-up emails/activities (but skip Lead updates — streamAudio did them)
      aiResult = await doFollowUpActions(base44, callLog, campaignLead, campaignId, outcome, summary);
      await runActionExtractor(base44, callLog);
    } else if (outcome !== 'not_answered' && (callLog.transcript || callLog.conversation_summary)) {
      aiResult = await doAIAnalysis(base44, callLog, campaignLead, campaignId, outcome, summary);
      await runActionExtractor(base44, callLog);
    } else if (campaignLead.lead_id) {
      // For unanswered/no-transcript calls: only update engagement metadata, NOT status/score
      const leadClientId = (await base44.entities.Campaign.get(campaignId).catch(() => null))?.client_id;
      if (outcome === 'not_answered') {
        await updateLead(base44, campaignLead.lead_id, leadClientId, {
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString()
        });
        console.log(`[campaignPostCall] Lead ${campaignLead.lead_id} — not_answered, preserved existing status/score`);
      } else {
        const outcomeToLeadStatus = {
          interested: 'interested', not_interested: 'not_interested', callback: 'callback',
          voicemail: 'voicemail', neutral: 'contacted', converted: 'converted', do_not_call: 'do_not_call'
        };
        await updateLead(base44, campaignLead.lead_id, leadClientId, {
          status: outcomeToLeadStatus[outcome] || 'contacted',
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString()
        });
      }
    }

    // Update campaign stats — skip when triggerNextBatch already finalized the
    // campaign (it recomputed and persisted counts in the same invocation).
    if (!campaignAlreadyFinalized) {
      await updateCampaignStats(base44, campaignId);
    } else {
      console.log('[campaignPostCall] Skipped redundant updateCampaignStats — campaign already finalized by triggerNextBatch.');
    }

    return c.json({ data: {
      success: true, outcome: aiResult.outcome || outcome,
      email_sent: aiResult.emailSent || false,
      callback_scheduled: aiResult.callbackScheduled || false,
      no_answer_outreach_sent: noAnswerOutreachSent,
      next_batch: nextBatchResult, retry: retryScheduled
    } });

  } catch (error) {
    console.error('[campaignPostCall] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};


// =====================================================
// TRIGGER NEXT BATCH — Lightweight, fast, inline
// =====================================================
async function triggerNextBatch(base44, campaignId) {
  try {
    const campaign = await base44.entities.Campaign.get(campaignId);
    if (!campaign || !['running'].includes(campaign.status)) {
      return { skipped: `campaign_${campaign?.status || 'missing'}` };
    }

    const now = new Date();
    // CRITICAL: paginate per-status to avoid SDK's ~1000-record cap that falsely
    // marked large campaigns "completed" after 1000 calls (single filter() with
    // limit=1000 silently truncated all leads beyond #1000 → pending=0 → completed).
    const fetchAllByStatus = async (statusValue) => {
      const out = [];
      const PAGE_SIZE = 200;
      let pageIdx = 0;
      while (true) {
        const page = await base44.entities.CampaignLead.filter(
          { campaign_id: campaignId, status: statusValue }, 'created_date', PAGE_SIZE, pageIdx * PAGE_SIZE
        );
        if (!page || page.length === 0) break;
        out.push(...page);
        pageIdx++;
        if (pageIdx > 250) break;
      }
      return out;
    };
    const [pendingLeads, callingLeads, processingLeads, completedLeadsAll, failedLeadsAll] = await Promise.all([
      fetchAllByStatus('pending'),
      fetchAllByStatus('calling'),
      fetchAllByStatus('processing'),
      fetchAllByStatus('completed'),
      fetchAllByStatus('failed'),
    ]);
    const allLeads = [...pendingLeads, ...callingLeads, ...processingLeads, ...completedLeadsAll, ...failedLeadsAll];
    const maxConcurrent = campaign.max_concurrent_calls || 5;

    // Separate ready-to-call vs retry-later pending leads
    const readyPending = pendingLeads.filter(l => !l.followup_call_date || new Date(l.followup_call_date) <= now);
    const retryLaterPending = pendingLeads.filter(l => l.followup_call_date && new Date(l.followup_call_date) > now);

    // Check completion — only complete if NO pending, calling, or processing leads
    if (readyPending.length === 0 && callingLeads.length === 0 && retryLaterPending.length === 0 && processingLeads.length === 0) {
      const completedCount = allLeads.filter(l => l.status === 'completed').length;
      const failedCount = allLeads.filter(l => l.status === 'failed').length;
      const outcomes = countOutcomes(allLeads);
      await base44.entities.Campaign.update(campaignId, {
        status: 'completed', completed_at: new Date().toISOString(),
        calls_completed: completedCount, calls_failed: failedCount, outcomes_summary: outcomes
      });
      return { completed: true };
    }

    // If only retry-later leads remain and no active calls/processing, skip (campaign continues via poller)
    if (readyPending.length === 0 && callingLeads.length === 0 && processingLeads.length === 0 && retryLaterPending.length > 0) {
      return { waiting: true, pending: pendingLeads.length, retry_later: retryLaterPending.length };
    }

    const slotsAvailable = Math.max(0, maxConcurrent - callingLeads.length);
    if (slotsAvailable === 0 || readyPending.length === 0) {
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

    // Load per-DID concurrency caps + current active outbound count per DID
    const didRecords = await base44.entities.DID.filter({ client_id: campaign.client_id });
    const didCapMap = {};
    for (const n of agentDIDs) {
      const rec = didRecords.find((d) => d.number === n);
      didCapMap[n] = rec?.max_concurrent_calls || 1;
    }
    const activeMap = {};
    for (const n of agentDIDs) activeMap[n] = 0;
    const recentCalls = await base44.entities.CallLog.filter({ agent_id: agent.id }, '-created_date', 200);
    const activeStatuses = new Set(['initiated', 'ringing', 'answered']);
    for (const c of recentCalls) {
      if (activeStatuses.has(c.status) && c.caller_id && activeMap[c.caller_id] !== undefined) {
        activeMap[c.caller_id]++;
      }
    }
    let selectedDID = null;
    let bestFree = 0;
    for (const n of agentDIDs) {
      const free = (didCapMap[n] || 1) - (activeMap[n] || 0);
      if (free > bestFree) { selectedDID = n; bestFree = free; }
    }
    if (!selectedDID) {
      return { waiting: true, reason: 'all_dids_saturated' };
    }

    // Initiate ONE call only (fire-and-forget style — no polling/waiting)
    // The call lifecycle is: initiated → ringing → streamAudio connects → call completes → 
    // CallLog update triggers this automation again → next call initiated
    const cl = readyPending[0];
    try {
      // RE-READ to prevent race with campaignPoller picking the same lead
      const freshCL = await base44.entities.CampaignLead.get(cl.id);
      if (freshCL.status !== 'pending') {
        console.log(`[campaignPostCall] Lead ${cl.lead_name} already ${freshCL.status} — skipping (race avoided)`);
        return { skipped: true, reason: `lead_already_${freshCL.status}` };
      }

      // ═══════════════════════════════════════════════════════════════════
      // CAMPAIGN PROVIDER ROUTING (inline — kept in sync across 4 sites)
      // ═══════════════════════════════════════════════════════════════════
      const detectCountryFromPhone = (phone) => {
        const c = String(phone || '').replace(/[^0-9+]/g, '');
        if (c.startsWith('+1') || /^1\d{10}$/.test(c)) return 'US';
        if (c.startsWith('+44') || /^44\d{9,10}$/.test(c)) return 'GB';
        if (c.startsWith('+91') || /^91\d{10}$/.test(c)) return 'IN';
        if (/^0\d{10}$/.test(c) || /^\d{10}$/.test(c)) return 'IN';
        return 'UNKNOWN';
      };
      const resolveCampaignProvider = (a, phone, cc) => {
        const pref = String(a?.calling_provider || 'auto').toLowerCase();
        if (pref === 'smartflo' || pref === 'twilio') return pref;
        const region = String(cc?.region || '').toUpperCase();
        if (region === 'US' || region === 'UK') return 'twilio';
        return detectCountryFromPhone(phone) === 'IN' ? 'smartflo' : 'twilio';
      };
      const campaignClient = await base44.entities.Client.get(campaign.client_id).catch(() => null);
      const providerForLead = resolveCampaignProvider(agent, cl.lead_phone, campaignClient);

      // ─── TWILIO BRANCH (international) ───
      if (providerForLead === 'twilio') {
        await updateCL(base44, cl.id, campaignId, {
          status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
        });
        try {
          const twRes = await base44.functions.invoke('twilioInitiateCall', {
            lead_id: cl.lead_id, agent_id: campaign.agent_id,
            phone_number: cl.lead_phone, service_call: true
          });
          const twData = twRes?.data || {};
          if (twData.success && twData.call_log_id) {
            await updateCL(base44, cl.id, campaignId, { call_log_id: twData.call_log_id });
            console.log(`[campaignPostCall] ✅ Twilio call fired for ${cl.lead_name} (callLog=${twData.call_log_id})`);
            return { initiated: 1, call_log_id: twData.call_log_id, provider: 'twilio', pending_remaining: pendingLeads.length - 1 };
          }
          await updateCL(base44, cl.id, campaignId, {
            status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
            conversation_summary: `Twilio error: ${twData.error || 'unknown'}`
          });
          return { initiated: 0, error: twData.error || 'twilio_failed', pending_remaining: pendingLeads.length - 1 };
        } catch (twErr) {
          await updateCL(base44, cl.id, campaignId, {
            status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
            conversation_summary: `Twilio invoke error: ${twErr.message}`
          });
          return { initiated: 0, error: twErr.message, pending_remaining: pendingLeads.length - 1 };
        }
      }
      // ─── End Twilio branch — fall through to Smartflo for IN ───

      await updateCL(base44, cl.id, campaignId, {
        status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
      });

      const cleanPhone = (cl.lead_phone || '').replace(/[^0-9]/g, '');
      const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      // Build lead context INLINE (avoid cross-function auth issues)
      let leadContext = '';
      try {
        let lead = null;
        if (cl.lead_id) {
          try { lead = await base44.entities.Lead.get(cl.lead_id); } catch (_) {}
        }
        if (lead) {
          const ctxParts = [];
          ctxParts.push(`CUSTOMER PROFILE:`);
          ctxParts.push(`- Name: ${lead.name || cl.lead_name || 'Unknown'}`);
          if (lead.phone) ctxParts.push(`- Phone: ${lead.phone}`);
          if (lead.email) ctxParts.push(`- Email: ${lead.email}`);
          if (lead.company) ctxParts.push(`- Company: ${lead.company}`);
          if (lead.status) ctxParts.push(`- Status: ${lead.status}`);
          ctxParts.push(`\nCRITICAL PERSONALIZATION RULES:`);
          ctxParts.push(`- You MUST address the customer by name "${lead.name || cl.lead_name || 'Sir/Madam'}".`);
          ctxParts.push(`- Example: "Kya main ${lead.name || cl.lead_name || 'Sir/Madam'} se baat kar rahi hu?"`);
          if (lead.email) ctxParts.push(`- If confirming email, use: "${lead.email}"`);
          if (lead.company) ctxParts.push(`- Reference their company "${lead.company}" naturally.`);
          leadContext = ctxParts.join('\n');
        } else {
          leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
        }
      } catch (_) {
        leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
      }

      const personalizedPrompt = [
        agent.system_prompt || '',
        campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
        campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
        campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
        campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
        `\n\n--- LEAD CONTEXT (YOU MUST USE THIS DATA IN THE CONVERSATION) ---\n${leadContext}`
      ].filter(Boolean).join('\n');

      const newCallLog = await base44.entities.CallLog.create({
        client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
        call_sid: callSid, caller_id: selectedDID, callee_number: cl.lead_phone,
        direction: 'outbound', status: 'initiated', call_start_time: new Date().toISOString(),
        agent_config_cache: {
          agent_name: agent.name,
          agent_id: agent.id,
          client_id: campaign.client_id,
          lead_id: cl.lead_id || null,
          core_prompt: personalizedPrompt,
          persona: agent.persona || {},
          greeting_message: agent.greeting_message || '',
          tool_flags: {
            has_kb: !!(agent.kb_file_uri || (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0)),
            has_shopify: false,
            has_unicommerce: false,
            has_call_history: !!cl.lead_id,
            has_transfer: !!agent.human_transfer_number,
            has_end_call: true
          },
          kb_file_uri: agent.kb_file_uri || '',
          human_transfer_number: agent.human_transfer_number || '',
          enable_auto_transfer: agent.enable_auto_transfer !== false
        }
      });

      await updateCL(base44, cl.id, campaignId, { call_log_id: newCallLog.id });

      // Use agent's own API token (falls back to global key for demo agents)
      let smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
      try {
        const clientData = await base44.entities.Client.get(campaign.client_id);
        if (clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding')) {
          smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
        }
      } catch (_) {}

      const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: smartfloApiKey,
          customer_number: cleanPhone,
          caller_id: selectedDID.replace(/^\+/, ''),
          async: 1
        })
      });

      const smartfloData = await smartfloResp.json();
      if (!(smartfloResp.ok && smartfloData.success !== false)) {
        await base44.entities.CallLog.update(newCallLog.id, { status: 'failed' });
        await updateCL(base44, cl.id, campaignId, {
          status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
          conversation_summary: `Smartflo error: ${smartfloData.message || 'Unknown'}`
        });
        return { initiated: 0, error: 'smartflo_failed', pending_remaining: pendingLeads.length - 1 };
      }

      const smartfloCallId = smartfloData.call_id || null;
      const smartfloRefId = smartfloData.ref_id || null;
      const newCallSid = smartfloCallId || smartfloData.call_sid || smartfloRefId || callSid;
      console.log(`[campaignPostCall] Smartflo call_id=${smartfloCallId}, ref_id=${smartfloRefId}, using=${newCallSid}`);
      const sidUpdate = { status: 'ringing' };
      sidUpdate.call_sid = smartfloRefId && !smartfloCallId ? smartfloRefId : newCallSid;
      await base44.entities.CallLog.update(newCallLog.id, sidUpdate);
      console.log(`[campaignPostCall] ✅ Call initiated: ${cl.lead_name} → ${cleanPhone}`);

      return { initiated: 1, call_log_id: newCallLog.id, pending_remaining: pendingLeads.length - 1 };
    } catch (callErr) {
      console.error(`[campaignPostCall] Call error for ${cl.lead_name}: ${callErr.message}`);
      await updateCL(base44, cl.id, campaignId, {
        status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
        conversation_summary: `Error: ${callErr.message}`
      });
      return { initiated: 0, error: callErr.message, pending_remaining: pendingLeads.length - 1 };
    }
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
    const analysis = await azureLLM(
      `Analyze this sales call and determine the outcome.

TRANSCRIPT:
${callLog.transcript || 'No transcript available'}

SUMMARY:
${callLog.conversation_summary || 'No summary available'}

Determine:
1. outcome: one of "neutral", "interested", "not_interested", "not_answered", "callback", "converted", "do_not_call"
2. summary: A brief 2-3 sentence summary.

Rules:
- "interested" = expressed clear interest, asked about pricing/details, agreed to meeting/demo
- "callback" = asked to be called back later
- "not_interested" = explicitly declined
- "not_answered" = no real conversation happened, call not picked up
- "neutral" = conversation happened but no clear interest or rejection
- "converted" = agreed to sign up, purchase, or confirmed a deal
- "do_not_call" = explicitly asked to never be called again, remove from list`,
      'You are a sales call analyst. Always respond in valid JSON.',
      { type: "object", properties: { outcome: { type: "string" }, summary: { type: "string" } } }
    );
    outcome = analysis.outcome || outcome;
    summary = analysis.summary || summary;
  } catch (e) {
    console.error(`[campaignPostCall] LLM outcome analysis failed: ${e.message}`);
  }

  // Update campaign lead with refined outcome
  await updateCL(base44, campaignLead.id, campaignId, { outcome, conversation_summary: summary });

  // 2. AI Lead Scoring
  let aiScore = 0, aiSentiment = 'neutral', aiIntentSignals = [], aiScoreBreakdown = {};
  let qualificationTier = 'cold', qualificationReason = '';

  if (campaignLead.lead_id) {
    try {
      const scoringResult = await azureLLM(
        `Analyze this sales call and score the lead (0-100).

TRANSCRIPT: ${callLog.transcript || 'N/A'}
SUMMARY: ${summary}
OUTCOME: ${outcome}

SCORING (total 100):
- Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
- Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10
- Engagement (0-25): short_answers=5, asked_questions=15, highly_engaged=25
- Keywords (0-20): positive="interested","sign up","sounds good"=+5 each; negative="not interested","too expensive"=-5 each`,
        'You are a lead scoring analyst. Always respond in valid JSON.',
        { type: "object", properties: {
          lead_score: { type: "number" }, sentiment: { type: "string" },
          intent_signals: { type: "array", items: { type: "string" } },
          score_breakdown: { type: "object" },
          conversion_probability: { type: "number" },
          objections: { type: "array", items: { type: "string" } },
          recommended_next_action: { type: "string" },
          key_topics: { type: "array", items: { type: "string" } }
        }}
      );

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
      if (outcome === 'not_interested' && aiScore < 25) { qualificationTier = 'disqualified'; }

      console.log(`[campaignPostCall] AI Score: ${aiScore}, Tier: ${qualificationTier}`);
    } catch (e) {
      console.error(`[campaignPostCall] AI scoring failed: ${e.message}`);
    }

    // Update lead — protect existing higher scores from downgrade on neutral outcomes.
    // FIX: `lead` was referenced before its declaration (line ~759) → ReferenceError.
    // Read the current lead here so downgrade-protection actually works.
    const existingLead = campaignLead.lead_id
      ? (await base44.entities.Lead.get(campaignLead.lead_id).catch(() => ({}))) || {}
      : {};
    const existingScore = existingLead.score || 0;
    const existingStatus = existingLead.status || 'new';
    const positiveStatuses = ['interested', 'converted', 'callback'];
    const negativeStatuses = ['not_interested', 'do_not_call'];
    const wasPositive = positiveStatuses.includes(existingStatus);
    const isNowNeutral = ['contacted', 'neutral'].includes(outcome);
    const isNowNegative = negativeStatuses.includes(outcome);
    const newLeadStatus = { interested: 'interested', not_interested: 'not_interested', callback: 'callback',
      not_answered: existingStatus, neutral: 'contacted', converted: 'converted', do_not_call: 'do_not_call' }[outcome] || 'contacted';

    // Don't downgrade a positive lead to neutral unless explicitly negative
    // Never lower the score the container already wrote — only ever raise it.
    let finalScore = Math.max(existingScore, aiScore);
    let finalStatus = newLeadStatus;
    if (wasPositive && isNowNeutral && existingScore >= aiScore) {
      finalScore = existingScore;
      finalStatus = existingStatus;
      console.log(`[campaignPostCall] Lead ${campaignLead.lead_id} — preserving higher score ${existingScore}/${existingStatus} over ${aiScore}/${outcome}`);
    }

    const leadUpdate = {
      status: finalStatus,
      last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString()
    };
    if (aiScore > 0) {
      Object.assign(leadUpdate, {
        score: finalScore, sentiment: aiSentiment, intent_signals: aiIntentSignals,
        score_breakdown: aiScoreBreakdown, qualification_tier: wasPositive && isNowNeutral ? (existingLead.qualification_tier || qualificationTier) : qualificationTier,
        qualification_reason: wasPositive && isNowNeutral ? (existingLead.qualification_reason || qualificationReason) : qualificationReason,
        notes: `[Score: ${finalScore}/100 | ${aiSentiment} | ${qualificationTier}] ${summary.substring(0, 300)}`
      });
    }
    const scoreClientId = (await base44.entities.Campaign.get(campaignId).catch(() => null))?.client_id;
    await updateLead(base44, campaignLead.lead_id, scoreClientId, leadUpdate);
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
        const emailContent = await azureLLM(
          `Write a personalized follow-up email for ${client?.company_name || 'our company'}.
Lead: ${lead.name || 'Valued Customer'}, Company: ${lead.company || 'N/A'}
Call Summary: ${summary}
Reference specific topics discussed. Include a CTA. Under 200 words. HTML format.`,
          'You are an email copywriter. Always respond in valid JSON.',
          { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" } } }
        );
        await sendLeadEmail(base44, {
          to: lead.email, fromName: client?.company_name || 'VaaniAI',
          clientId: campaign.client_id,
          subject: emailContent.subject,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${emailContent.body_html}</div>`
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
    const cbDate = new Date(); cbDate.setDate(cbDate.getDate() + cbDays);
    cbDate.setUTCHours(4, 30, 0, 0); // 10:00 AM IST = 04:30 UTC
    await base44.entities.Activity.create({
      client_id: campaign.client_id, lead_id: campaignLead.lead_id, type: 'followup',
      title: `Follow-up: ${lead?.name || campaignLead.lead_phone} (Interested)`,
      description: `Campaign "${campaign.name}"\nSummary: ${summary}`,
      scheduled_date: cbDate.toISOString(), status: 'scheduled', priority: 'high', auto_created: true
    });
    callbackScheduled = true;
  }

  if (outcome === 'callback') {
    callbackScheduled = true;
    console.log(`[campaignPostCall] Callback outcome — skipping Activity creation (campaign retry handles this)`);
  }

  if (campaignLead.lead_id && qualificationTier && outcome !== 'not_answered') {
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
    // Warm/nurture: only update lead metadata, don't create followup Activities
    // (these were creating call/followup activities that duplicated campaign calls)

    // Update next followup on lead record only
    const nextF = qualificationTier === 'hot' ? new Date(Date.now() + 4 * 3600000) :
      qualificationTier === 'warm' ? new Date(Date.now() + 24 * 3600000) :
      new Date(Date.now() + 5 * 86400000);
    await base44.entities.Lead.update(campaignLead.lead_id, {
      next_followup_date: nextF.toISOString(),
      engagement_count: (lead?.engagement_count || 0) + 1
    });
  }

  // Update campaign lead follow-up flags
  await updateCL(base44, campaignLead.id, campaignId, {
    followup_email_sent: emailSent, followup_scheduled: callbackScheduled,
    ...(callbackScheduled ? { followup_call_date: new Date(Date.now() + 2 * 86400000).toISOString() } : {})
  });

  // ============================================================
  // AUTO-ENROLL INTO AI EMAIL SEQUENCE based on tier
  // (Direct fetch — bypasses Base44 functions.invoke to avoid integration credits)
  // ============================================================
  if (campaignLead.lead_id && qualificationTier && !['disqualified'].includes(qualificationTier) && outcome !== 'not_answered') {
    try {
      const enrollPayload = {
        lead_id: campaignLead.lead_id,
        client_id: campaign.client_id,
        qualification_tier: qualificationTier,
        call_outcome: outcome,
        call_summary: summary.substring(0, 500),
        call_topics: aiScoreBreakdown.key_topics || [],
        objections: aiScoreBreakdown.objections || [],
        intent_signals: aiIntentSignals,
        ai_score: aiScore
      };
      const enrollRes = await base44.functions.invoke('autoEnrollSequence', enrollPayload);
      const enrollResult = enrollRes?.data || null;
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
    // CRITICAL: paginate per-status (single .filter() silently truncates at ~1000 rows,
    // which falsely marked >1000-lead campaigns as completed)
    const fetchAllByStatus = async (statusValue) => {
      const out = [];
      const PAGE_SIZE = 200;
      let pageIdx = 0;
      while (true) {
        const page = await base44.entities.CampaignLead.filter(
          { campaign_id: campaignId, status: statusValue }, 'created_date', PAGE_SIZE, pageIdx * PAGE_SIZE
        );
        if (!page || page.length === 0) break;
        out.push(...page);
        pageIdx++;
        if (pageIdx > 250) break;
      }
      return out;
    };
    const [pendingAll, callingAll, processingAll, completedAll, failedAll] = await Promise.all([
      fetchAllByStatus('pending'),
      fetchAllByStatus('calling'),
      fetchAllByStatus('processing'),
      fetchAllByStatus('completed'),
      fetchAllByStatus('failed'),
    ]);
    const allLeads = [...pendingAll, ...callingAll, ...processingAll, ...completedAll, ...failedAll];
    const outcomes = countOutcomes(allLeads);
    const completedCount = completedAll.length;
    const failedCount = failedAll.length;
    const pendingCount = pendingAll.length;
    const callingCount = callingAll.length;
    const processingCount = processingAll.length;
    const update = { outcomes_summary: outcomes, calls_completed: completedCount, calls_failed: failedCount };
    // Only mark completed if NO pending, NO calling, and NO processing leads
    if (pendingCount === 0 && callingCount === 0 && processingCount === 0) {
      update.status = 'completed';
      update.completed_at = new Date().toISOString();
    }
    await base44.entities.Campaign.update(campaignId, update);
  } catch (e) {
    console.error(`[campaignPostCall] Stats update error: ${e.message}`);
  }
}

function countOutcomes(allLeads) {
  const outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
  allLeads.forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
  return outcomes;
}

// =====================================================
// INCREMENTAL COUNTER — bump Campaign display counters by +1 without
// re-scanning all leads. This is the rate-limit-friendly path: a single
// Campaign read + single update instead of paginating every lead.
//
// SAFETY:
//  - Best-effort only — any failure is swallowed (never breaks call flow).
//  - NEVER sets status='completed' (the poller's full recount owns completion).
//  - The 5-min campaignPoller full recount remains the authoritative reconciler,
//    so any drift from a missed/duplicate bump self-heals within one cycle.
// =====================================================
async function bumpCampaignCounter(base44, campaignId, { completed = false, failed = false, outcome = null } = {}) {
  try {
    if (!campaignId) return;
    const campaign = await base44.entities.Campaign.get(campaignId).catch(() => null);
    if (!campaign) return;
    const update = {};
    if (completed) update.calls_completed = (campaign.calls_completed || 0) + 1;
    if (failed) update.calls_failed = (campaign.calls_failed || 0) + 1;
    if (outcome) {
      const summary = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0, ...(campaign.outcomes_summary || {}) };
      if (summary[outcome] !== undefined) {
        summary[outcome] = (summary[outcome] || 0) + 1;
        update.outcomes_summary = summary;
      }
    }
    if (Object.keys(update).length === 0) return;
    await base44.entities.Campaign.update(campaignId, update);
  } catch (e) {
    console.warn(`[campaignPostCall] bumpCampaignCounter skipped: ${e.message}`);
  }
}

// Interpolate {{name}}, {{company}}, {{phone}}, {{email}} from a lead
function interpolate(template, lead) {
  if (!template) return '';
  return String(template)
    .replace(/\{\{name\}\}/g, lead?.name || '')
    .replace(/\{\{company\}\}/g, lead?.company || '')
    .replace(/\{\{phone\}\}/g, lead?.phone || '')
    .replace(/\{\{email\}\}/g, lead?.email || '');
}

// =====================================================
// NO-ANSWER OUTREACH — Send email and/or WhatsApp when campaign rules say so
// =====================================================
async function sendNoAnswerOutreach(base44, campaign, campaignLead, callLog) {
  const rules = campaign?.followup_rules || {};
  const sendEmail = !!rules.no_answer_send_email;
  const sendWA = !!rules.no_answer_send_whatsapp;
  if (!sendEmail && !sendWA) return false;

  const lead = campaignLead.lead_id ? await base44.entities.Lead.get(campaignLead.lead_id).catch(() => null) : null;
  if (!lead) return false;
  const client = await base44.entities.Client.get(campaign.client_id).catch(() => null);

  let anySent = false;

  // ─── Email ───
  if (sendEmail && lead.email) {
    try {
      let subject, html;
      if (rules.no_answer_email_ai !== false) {
        // AI-generate
        const aiEmail = await azureLLM(
          `Write a short (100-150 words) friendly follow-up HTML email for a lead we tried to call but couldn't reach.

LEAD: ${lead.name || 'Valued Customer'} ${lead.company ? `(${lead.company})` : ''}
SENDER: ${client?.company_name || 'our company'}
CAMPAIGN: ${campaign.name}
CALL SCRIPT CONTEXT: ${campaign.call_script?.pitch || campaign.call_script?.opening || 'General outreach'}

Write warmly. Acknowledge we tried to call. Offer a clear next-step CTA (reply, book a time, or call back). Address by name.`,
          'You are an expert email copywriter. Always respond in valid JSON.',
          { type: 'object', properties: { subject: { type: 'string' }, body_html: { type: 'string' } } }
        );
        subject = aiEmail.subject || `Sorry we missed you, ${lead.name || ''}`;
        html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${aiEmail.body_html || ''}</div>`;
      } else {
        subject = interpolate(rules.no_answer_email_subject || 'Sorry we missed you', lead);
        const body = interpolate(rules.no_answer_email_body || '', lead);
        html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${body.replace(/\n/g, '<br/>')}</div>`;
      }
      await sendLeadEmail(base44, {
        to: lead.email,
        fromName: client?.company_name || 'VaaniAI',
        clientId: campaign.client_id,
        subject, html
      });
      await base44.entities.OutreachLog.create({
        client_id: campaign.client_id, lead_id: lead.id, call_log_id: callLog?.id || null,
        channel: 'email', recipient_email: lead.email, subject, body: html,
        outreach_type: 'lead_followup', call_outcome: 'not_answered', status: 'sent'
      }).catch(() => {});
      anySent = true;
      console.log(`[campaignPostCall] No-answer email sent to ${lead.email}`);
    } catch (e) {
      console.error(`[campaignPostCall] No-answer email failed: ${e.message}`);
    }
  }

  // ─── WhatsApp (template) ───
  if (sendWA && rules.no_answer_whatsapp_template_id && lead.phone) {
    try {
      const tRes = await base44.functions.invoke('sendWhatsAppTemplate', {
        client_id: campaign.client_id,
        template_id: rules.no_answer_whatsapp_template_id,
        to: lead.phone,
        variables: rules.no_answer_whatsapp_variables || [],
        lead_id: lead.id,
        call_log_id: callLog?.id || null,
        outreach_type: 'lead_followup'
      });
      const tData = tRes?.data || {};
      if (tData?.success) {
        anySent = true;
        console.log(`[campaignPostCall] No-answer WhatsApp template sent to ${lead.phone}`);
      } else {
        console.error(`[campaignPostCall] No-answer WhatsApp failed: ${tData?.error || 'invoke failed'}`);
      }
    } catch (e) {
      console.error(`[campaignPostCall] No-answer WhatsApp error: ${e.message}`);
    }
  }

  if (anySent) {
    await base44.entities.CampaignLead.update(campaignLead.id, {
      followup_email_sent: true
    }).catch(() => {});
  }
  return anySent;
}


// =====================================================
// FOLLOW-UP ACTIONS ONLY — When AI scoring was already done by streamAudio
// Handles emails, callbacks, activities, and sequence enrollment
// =====================================================
async function doFollowUpActions(base44, callLog, campaignLead, campaignId, outcome, summary) {
  let emailSent = false;
  let callbackScheduled = false;

  const campaign = await base44.entities.Campaign.get(campaignId);
  const rules = campaign?.followup_rules || {};
  const lead = campaignLead.lead_id ? await base44.entities.Lead.get(campaignLead.lead_id) : null;
  const client = await base44.entities.Client.get(campaign.client_id);

  // Read lead's current scoring from what streamAudio already set
  const aiScore = lead?.score || 0;
  const qualificationTier = lead?.qualification_tier || 'cold';
  const aiIntentSignals = lead?.intent_signals || [];
  const qualificationReason = lead?.qualification_reason || '';

  // INTERESTED → email + callback
  if (outcome === 'interested') {
    if (rules.interested_email !== false && lead?.email) {
      try {
        const emailContent = await azureLLM(
          `Write a personalized follow-up email for ${client?.company_name || 'our company'}.
Lead: ${lead.name || 'Valued Customer'}, Company: ${lead.company || 'N/A'}
Call Summary: ${summary}
Reference specific topics discussed. Include a CTA. Under 200 words. HTML format.`,
          'You are an email copywriter. Always respond in valid JSON.',
          { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" } } }
        );
        await sendLeadEmail(base44, {
          to: lead.email, fromName: client?.company_name || 'VaaniAI',
          clientId: campaign.client_id,
          subject: emailContent.subject,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${emailContent.body_html}</div>`
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
    const cbDate = new Date(); cbDate.setDate(cbDate.getDate() + cbDays);
    cbDate.setUTCHours(4, 30, 0, 0); // 10:00 AM IST = 04:30 UTC
    await base44.entities.Activity.create({
      client_id: campaign.client_id, lead_id: campaignLead.lead_id, type: 'followup',
      title: `Follow-up: ${lead?.name || campaignLead.lead_phone} (Interested)`,
      description: `Campaign "${campaign.name}"\nSummary: ${summary}`,
      scheduled_date: cbDate.toISOString(), status: 'scheduled', priority: 'high', auto_created: true
    });
    callbackScheduled = true;
  }

  if (outcome === 'callback') {
    callbackScheduled = true;
    console.log(`[campaignPostCall] doFollowUpActions: callback outcome — skipping Activity (no duplicate calls)`);
  }

  // Update campaign lead follow-up flags
  await updateCL(base44, campaignLead.id, campaignId, {
    followup_email_sent: emailSent, followup_scheduled: callbackScheduled,
    ...(callbackScheduled ? { followup_call_date: new Date(Date.now() + 2 * 86400000).toISOString() } : {})
  });

  // Auto-enroll into email sequence if not already done by streamAudio
  // (Direct fetch — bypasses Base44 functions.invoke to avoid integration credits)
  if (campaignLead.lead_id && qualificationTier && !['disqualified'].includes(qualificationTier) && outcome !== 'not_answered') {
    try {
      const enrollPayload = {
        lead_id: campaignLead.lead_id, client_id: campaign.client_id,
        qualification_tier: qualificationTier, call_outcome: outcome,
        call_summary: summary.substring(0, 500),
        call_topics: lead?.score_breakdown?.key_topics || [],
        objections: lead?.score_breakdown?.objections || [],
        intent_signals: aiIntentSignals, ai_score: aiScore
      };
      const enrollRes = await base44.functions.invoke('autoEnrollSequence', enrollPayload);
      const enrollResult = enrollRes?.data || null;
      if (enrollResult?.enrolled) {
        console.log(`[campaignPostCall] ✉️ Auto-enrolled in sequence: ${enrollResult.sequence_name}`);
      }
    } catch (seqErr) {
      console.error(`[campaignPostCall] Auto-enroll failed: ${seqErr.message}`);
    }
  }

  return { outcome, emailSent, callbackScheduled, aiScore, qualificationTier };
}

export async function campaignPostCallCore(callLogId: string, campaignId?: string) {
  const callLog = await base44.entities.CallLog.get(callLogId);
  if (!callLog) return;
  const payload = {
    event: { entity_name: 'CallLog', type: 'update', entity_id: callLogId },
    data: callLog
  };
  const c = { req: { json: async () => payload, raw: {} }, json: (data: any) => data };
  return await campaignPostCall(c);
}