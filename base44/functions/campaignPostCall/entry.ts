import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.31';

// ─── Retry-with-backoff wrapper for entity reads/writes ───
// Base44 throws on 429 (rate limit). Without retry, a transient 429 aborts processing
// and a real connected call can get wrongly marked failed. Waits & retries before giving up.
async function withRetry(fn, label = 'op') {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message || e);
      const is429 = msg.includes('429') || /rate.?limit/i.test(msg);
      lastErr = e;
      if (!is429 || attempt === 3) throw e;
      const wait = 250 * Math.pow(3, attempt); // 250, 750, 2250
      console.warn(`[campaignPostCall] 429 on ${label} — retry ${attempt + 1}/3 in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Counts each lead status for a campaign WITHOUT paginating the whole table.
// Status-filtered reads are far cheaper and avoid the 429 storms the full scan caused.
async function fetchStatusCounts(base44, campaignId) {
  const statuses = ['pending', 'calling', 'processing', 'completed', 'failed'];
  const results = await Promise.all(
    statuses.map(s => withRetry(
      () => base44.entities.CampaignLead.filter({ campaign_id: campaignId, status: s }, 'created_date', 1000),
      `count_${s}`
    ))
  );
  const map = {};
  statuses.forEach((s, i) => { map[s] = results[i]; });
  return map;
}

// ─── Resolve template variables from a lead, mapping each placeholder correctly ───
// Named tokens ({{name}}/{{company}}/{{phone}}/{{email}}) pass through for downstream
// interpolation. Numbered placeholders {{1}}…{{N}} map slot 1 → lead name, then resolve
// remaining slots from lead fields hinted by the template's approved body_examples,
// falling back to the example value (never blind name-dump, never empty).
function buildTemplateVariables(template, lead, slotMap) {
  const body = template.body_text || '';
  const leadName = (lead && lead.name) || 'Sir/Madam';
  const namedTokens = body.match(/\{\{(name|company|phone|email)\}\}/gi) || [];
  if (namedTokens.length > 0) return namedTokens.map(t => t);
  const numbers = (body.match(/\{\{\d+\}\}/g) || []).map(m => parseInt(m.replace(/[^\d]/g, ''), 10));
  if (numbers.length === 0) return [];
  const maxSlot = Math.max(...numbers);
  const examples = Array.isArray(template.body_examples) ? template.body_examples : [];
  // Explicit per-slot mapping configured in the campaign UI takes priority.
  const fromSlotMap = (idx) => {
    const m = Array.isArray(slotMap) ? slotMap[idx] : null;
    if (!m || !m.source) return undefined;
    if (m.source === 'static') return m.value || examples[idx] || leadName;
    if (m.source === 'lead_name') return (lead && lead.name) || leadName;
    if (m.source === 'lead_company') return (lead && lead.company) || examples[idx] || '';
    if (m.source === 'lead_phone') return (lead && lead.phone) || examples[idx] || '';
    if (m.source === 'lead_email') return (lead && lead.email) || examples[idx] || '';
    return undefined;
  };
  const resolveSlot = (idx) => {
    const mapped = fromSlotMap(idx);
    if (mapped !== undefined) return mapped;
    if (idx === 0) return leadName;
    const hint = String(examples[idx] || '').toLowerCase();
    if (lead) {
      if (/company|firm|business|organisation|organization/.test(hint) && lead.company) return lead.company;
      if (/email|mail/.test(hint) && lead.email) return lead.email;
      if (/phone|mobile|number|contact/.test(hint) && lead.phone) return lead.phone;
      if (/name/.test(hint) && lead.name) return lead.name;
    }
    return examples[idx] || leadName;
  };
  const variables = [];
  for (let i = 0; i < maxSlot; i++) variables.push(resolveSlot(i));
  return variables;
}

// ─── Send email using CLIENT's configured provider (via sendClientEmail function) ───
// Falls back to platform SMTP if client has no email config
async function sendLeadEmail({ to, fromName, subject, html, clientId }) {
  if (clientId) {
    try {
      const appId = Deno.env.get('BASE44_APP_ID');
      const svcBase44 = createClient({ appId, asServiceRole: true });
      const result = await svcBase44.functions.invoke('sendClientEmail', {
        client_id: clientId,
        to,
        subject,
        html,
        from_name: fromName
      });
      console.log(`[campaignPostCall] Email sent via ${result.data?.provider || 'unknown'} for client ${clientId}`);
      return result.data;
    } catch (e) {
      console.warn(`[campaignPostCall] sendClientEmail failed, falling back to platform SMTP: ${e.message}`);
    }
  }
  // Fallback: platform raw SMTP (via sendClientEmail with no client_id) — zero integration credits
  const appId = Deno.env.get('BASE44_APP_ID');
  const svcBase44 = createClient({ appId, asServiceRole: true });
  const result = await svcBase44.functions.invoke('sendClientEmail', {
    to, subject, html, from_name: fromName || 'Bolify AI'
  });
  return result.data || { provider: 'platform_smtp', status: 'sent' };
}

// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
async function azureLLM(prompt, systemPrompt, jsonSchema) {
  let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  // Normalize: strip /openai/... or /api/projects/... from AI Foundry endpoints
  const oIdx = baseUrl.indexOf('/openai/'); if (oIdx > 0) baseUrl = baseUrl.substring(0, oIdx);
  const pIdx = baseUrl.indexOf('/api/projects'); if (pIdx > 0) baseUrl = baseUrl.substring(0, pIdx);
  let cleanBase = baseUrl;
  const oIdx2 = cleanBase.indexOf('/openai'); if (oIdx2 > 0) cleanBase = cleanBase.substring(0, oIdx2);
  const pIdx2 = cleanBase.indexOf('/api/projects'); if (pIdx2 > 0) cleanBase = cleanBase.substring(0, pIdx2);
  const url = `${cleanBase}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
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

// NOTE: This function is an ENTITY AUTOMATION triggered by CallLog updates.
// There is NO user session — we MUST use service role directly.
Deno.serve(async (req) => {
  try {
    // Entity automation — use createClientFromRequest + asServiceRole
    const base44_client = createClientFromRequest(req);
    const base44 = base44_client.asServiceRole;
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
            'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral', 'do_not_call': 'do_not_call'
          };
          const outcome = statusToOutcome[callLog.lead_status_updated] || campaignLead.outcome || 'neutral';
          const summary = callLog.conversation_summary || campaignLead.conversation_summary || '';
          // Also update outcome on CampaignLead if it changed
          if (outcome !== campaignLead.outcome) {
            await base44.entities.CampaignLead.update(campaignLead.id, { outcome, conversation_summary: summary });
          }
          await doFollowUpActions(base44, callLog, campaignLead, campaignLead.campaign_id, outcome, summary);
        } else if (callLog.transcript || callLog.conversation_summary) {
          await doAIAnalysis(base44, callLog, campaignLead, campaignLead.campaign_id, campaignLead.outcome || 'neutral', campaignLead.conversation_summary || '');
        }
        await updateCampaignStats(base44, campaignLead.campaign_id);
      }
      
      return Response.json({ success: true, skipped: 'already_processed_by_webhook', ai_ran: true });
    }
    
    // Idempotency: if CampaignLead is still pending (retry queued), skip
    if (campaignLead.status === 'pending') {
      return Response.json({ success: true, skipped: 'already_pending_retry' });
    }

    // ATOMIC LOCK: Immediately set status to 'processing' to prevent race conditions
    // when multiple CallLog updates fire this automation simultaneously.
    // If another instance already set it to 'processing', the filter above will catch it.
    await base44.entities.CampaignLead.update(campaignLead.id, { status: 'processing' });
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

    // CONNECTED-CALL GUARD: a call with a transcript / recording / duration genuinely
    // connected — NEVER mark it not_answered even if CallLog.status is failed/no_answer
    // (Smartflo can report a terminal failed/busy after a real conversation, and a transient
    //  429 can corrupt the status). Treat as a completed/neutral call instead.
    const callConnected = (callLog.transcript && callLog.transcript.length > 20)
      || !!callLog.recording_url
      || (callLog.duration && callLog.duration > 0);

    if (!callConnected && callLog.status === 'no_answer') {
      outcome = 'not_answered';
      callStatus = 'not_answered';
      summary = summary || 'Call was not answered.';
    } else if (!callConnected && callLog.status === 'failed') {
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
    await base44.entities.CampaignLead.update(campaignLead.id, {
      status: 'completed',
      outcome: outcome,
      call_status: callStatus,
      conversation_summary: summary,
      transcript: callLog.transcript || '',
      call_duration: callLog.duration || 0
    });
    console.log(`[campaignPostCall] Lead ${campaignLead.lead_name} marked completed: outcome=${outcome}, call_status=${callStatus}`);

    // =====================================================
    // STEP 3: FAST — Handle no-answer retry (before next batch)
    // =====================================================
    let retryScheduled = false;
    let isFinalAttempt = true;
    let attemptNumber = (campaignLead.attempt_count || 0) + 1;
    if (outcome === 'not_answered') {
      const campaign = await base44.entities.Campaign.get(campaignId);
      const rules = campaign?.followup_rules || {};
      if (rules.no_answer_retry !== false) {
        const maxRetries = rules.no_answer_max_retries || 3;
        const currentAttempts = (campaignLead.attempt_count || 0) + 1;
        attemptNumber = currentAttempts;
        if (currentAttempts < maxRetries) {
          const retryHours = rules.no_answer_retry_hours || 4;
          await base44.entities.CampaignLead.update(campaignLead.id, {
            status: 'pending', outcome: 'not_answered',
            attempt_count: currentAttempts, call_log_id: null,
            followup_call_date: new Date(Date.now() + retryHours * 3600000).toISOString()
          });
          console.log(`[campaignPostCall] Not-answered retry ${currentAttempts}/${maxRetries} queued`);
          retryScheduled = true;
          isFinalAttempt = false;
        }
      }

      // === MISSED CALL WhatsApp send (silent, fire-and-forget) ===
      try {
        const wa = campaign?.whatsapp_auto_send || {};
        if (wa.missed_call_enabled && wa.missed_call_template_id && campaignLead.lead_id) {
          const when = wa.missed_call_when || 'after_final_retry';
          const shouldSend =
            when === 'every_miss' ||
            (when === 'first_miss' && attemptNumber === 1) ||
            (when === 'after_final_retry' && isFinalAttempt);
          if (shouldSend) {
            // Idempotency: don't re-send for same call_log_id
            const existing = await base44.entities.OutreachLog.filter({
              call_log_id: callLogId, channel: 'whatsapp', client_id: campaign.client_id
            }, '-created_date', 5);
            const alreadySent = existing.some(o => o.template_id === wa.missed_call_template_id && o.status === 'sent');
            if (!alreadySent) {
              const lead = await base44.entities.Lead.get(campaignLead.lead_id);
              if (lead?.phone) {
                const template = await base44.entities.WhatsAppTemplate.get(wa.missed_call_template_id);
                if (template && template.status === 'APPROVED') {
                  // Build variables matching the template's placeholders. Explicit per-slot
                  // mappings (configured in the campaign UI) take priority; otherwise named tokens
                  // pass through and numbered ones resolve from lead fields / approved examples.
                  const slotMap = (wa.template_variable_map || {})[template.id];
                  const variables = buildTemplateVariables(template, lead, slotMap);

                  // Delegate to the shared sender for correct RCS Digital host + interpolation + logging
                  const waResult = await base44.functions.invoke('whatsappSendTemplate', {
                    template_id: template.id,
                    recipient: lead.phone,
                    variables,
                    lead_id: campaignLead.lead_id,
                    call_log_id: callLogId,
                    outreach_type: 'lead_followup',
                    internal_service: true
                  });
                  const sent = !!waResult?.data?.success;
                  console.log(`[campaignPostCall] 📵 Missed-call WhatsApp ${sent ? 'sent' : 'failed'} to ${lead.phone} (when=${when}, attempt=${attemptNumber})${sent ? '' : ' err=' + (waResult?.data?.error || 'unknown')}`);
                }
              }
            }
          }
        }
      } catch (mcErr) {
        console.error(`[campaignPostCall] missed-call WhatsApp failed: ${mcErr.message}`);
      }
    }

    // =====================================================
    // STEP 4: FAST — Trigger next batch IMMEDIATELY
    // This is the critical fix — don't wait for AI analysis
    // =====================================================
    const nextBatchResult = await triggerNextBatch(base44, campaignId);
    console.log(`[campaignPostCall] Next batch: ${JSON.stringify(nextBatchResult)}`);

    // =====================================================
    // STEP 4.5: ANSWERED-CALL WhatsApp send (fixed template, NO AI — credit-free)
    // Fires for every answered call when enabled in the campaign. Uses the client's own
    // WhatsApp provider via whatsappSendTemplate, so it works even when AI credits are out.
    // =====================================================
    if (callStatus === 'answered' && outcome !== 'not_answered') {
      try {
        const campaign = await base44.entities.Campaign.get(campaignId);
        const wa = campaign?.whatsapp_auto_send || {};
        if (wa.answered_call_enabled && wa.answered_call_template_id && campaignLead.lead_id) {
          // Idempotency: don't re-send for same call_log_id
          const existing = await base44.entities.OutreachLog.filter({
            call_log_id: callLogId, channel: 'whatsapp', client_id: campaign.client_id
          }, '-created_date', 5);
          const alreadySent = existing.some(o => o.template_id === wa.answered_call_template_id && o.status === 'sent');
          if (!alreadySent) {
            const lead = await base44.entities.Lead.get(campaignLead.lead_id);
            if (lead?.phone) {
              const template = await base44.entities.WhatsAppTemplate.get(wa.answered_call_template_id);
              if (template && template.status === 'APPROVED') {
                const slotMap = (wa.template_variable_map || {})[template.id];
                const variables = buildTemplateVariables(template, lead, slotMap);
                const waResult = await base44.functions.invoke('whatsappSendTemplate', {
                  template_id: template.id,
                  recipient: lead.phone,
                  variables,
                  lead_id: campaignLead.lead_id,
                  call_log_id: callLogId,
                  outreach_type: 'lead_followup',
                  internal_service: true
                });
                const sent = !!waResult?.data?.success;
                console.log(`[campaignPostCall] ✅ Answered-call WhatsApp ${sent ? 'sent' : 'failed'} to ${lead.phone}${sent ? '' : ' err=' + (waResult?.data?.error || 'unknown')}`);
              }
            }
          }
        }
      } catch (acErr) {
        console.error(`[campaignPostCall] answered-call WhatsApp failed: ${acErr.message}`);
      }
    }

    // =====================================================
    // STEP 5: SLOW — AI analysis, scoring, emails, activities
    // This runs AFTER next batch is already triggered.
    // NOTE: streamAudio.saveCallRecord now does AI analysis + lead scoring.
    // If transcript & lead_status_updated already present, skip duplicate LLM calls.
    // =====================================================
    let aiResult = {};
    const alreadyAnalyzed = callLog.lead_status_updated && callLog.transcript;
    
    if (alreadyAnalyzed) {
      // streamAudio already did AI analysis + Lead scoring — just map outcome for CampaignLead
      const statusToOutcome = {
        'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback',
        'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral',
        'do_not_call': 'do_not_call'
      };
      outcome = statusToOutcome[callLog.lead_status_updated] || outcome;
      summary = callLog.conversation_summary || summary;
      // NOTE: Lead is already updated by streamAudio — only update CampaignLead here
      await base44.entities.CampaignLead.update(campaignLead.id, { outcome, conversation_summary: summary });
      
      // Run follow-up emails/activities (but skip Lead updates — streamAudio did them)
      aiResult = await doFollowUpActions(base44, callLog, campaignLead, campaignId, outcome, summary);
    } else if (outcome !== 'not_answered' && (callLog.transcript || callLog.conversation_summary)) {
      aiResult = await doAIAnalysis(base44, callLog, campaignLead, campaignId, outcome, summary);
    } else if (campaignLead.lead_id) {
      // For unanswered/no-transcript calls: only update engagement metadata, NOT status/score
      if (outcome === 'not_answered') {
        await base44.entities.Lead.update(campaignLead.lead_id, {
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString()
        });
        console.log(`[campaignPostCall] Lead ${campaignLead.lead_id} — not_answered, preserved existing status/score`);
      } else {
        const outcomeToLeadStatus = {
          interested: 'interested', not_interested: 'not_interested', callback: 'callback',
          neutral: 'contacted', converted: 'converted', do_not_call: 'do_not_call'
        };
        await base44.entities.Lead.update(campaignLead.lead_id, {
          status: outcomeToLeadStatus[outcome] || 'contacted',
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString()
        });
      }
    }

    // Update campaign stats
    await updateCampaignStats(base44, campaignId);

    // ============================================================
    // AUTO-WHATSAPP: Silently send template if AI detects intent in transcript
    // (fire-and-forget — don't block response)
    // ============================================================
    if (callLog.transcript && callLog.transcript.length > 30 && outcome !== 'not_answered') {
      try {
        // FIX: invoke via the SDK (service-role, properly authenticated) instead of a raw
        // fetch with X-Internal-Secret — autoWhatsAppFromTranscript uses createClientFromRequest
        // and was silently rejected at the auth layer, so WhatsApp never sent. Awaited so the
        // result is logged (we're already past the next-batch trigger, so this doesn't delay dialing).
        const waResp = await base44.functions.invoke('autoWhatsAppFromTranscript', {
          campaign_id: campaignId,
          call_log_id: callLogId,
          lead_id: campaignLead.lead_id,
          transcript: callLog.transcript,
          summary: aiResult.outcome ? (aiResult.summary || summary) : summary
        });
        console.log(`[campaignPostCall] auto-whatsapp result: ${JSON.stringify(waResp?.data || {}).substring(0, 300)}`);
      } catch (waErr) {
        console.error(`[campaignPostCall] auto-whatsapp dispatch failed: ${waErr.message}`);
      }
    }

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

    // === TRAI COMPLIANCE: 9 AM – 9 PM IST window enforcement ===
    const istMs = Date.now() + (5 * 60 + 30) * 60 * 1000;
    const istHour = new Date(istMs).getUTCHours();
    if (istHour < 9 || istHour >= 21) {
      const istLabel = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      await base44.entities.Campaign.update(campaignId, {
        status: 'paused',
        notes: `${campaign.notes || ''}\n[${new Date().toISOString()}] Auto-paused: outside TRAI 9AM-9PM IST window (attempted at ${istLabel}).`.trim()
      });
      console.log(`[campaignPostCall] TRAI window closed (${istLabel}) — campaign paused, will auto-resume at 9 AM IST`);
      return { skipped: 'trai_window_closed', current_ist: istLabel };
    }

    const now = new Date();
    // Bounded status-filtered reads instead of a full-table scan (was a major 429 driver).
    const counts = await fetchStatusCounts(base44, campaignId);
    const pendingLeads = counts.pending;
    const callingLeads = counts.calling;
    const processingLeads = counts.processing;
    const maxConcurrent = campaign.max_concurrent_calls || 5;

    // Separate ready-to-call vs retry-later pending leads
    const readyPending = pendingLeads.filter(l => !l.followup_call_date || new Date(l.followup_call_date) <= now);
    const retryLaterPending = pendingLeads.filter(l => l.followup_call_date && new Date(l.followup_call_date) > now);

    // Check completion — only complete if NO pending, calling, or processing leads
    if (readyPending.length === 0 && callingLeads.length === 0 && retryLaterPending.length === 0 && processingLeads.length === 0) {
      const outcomes = countOutcomes([...counts.completed, ...counts.failed]);
      await base44.entities.Campaign.update(campaignId, {
        status: 'completed', completed_at: new Date().toISOString(),
        calls_completed: counts.completed.length, calls_failed: counts.failed.length, outcomes_summary: outcomes
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

      const selectedDID = agentDIDs[0];
      await base44.entities.CampaignLead.update(cl.id, {
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

      // Use campaign script's "opening" as greeting if present (consistent with executeCampaign/campaignPoller)
      let campaignGreeting = agent.greeting_message || '';
      if (campaign.call_script?.opening && campaign.call_script.opening.trim()) {
        let leadCompany = '';
        if (cl.lead_id) { try { leadCompany = (await base44.entities.Lead.get(cl.lead_id))?.company || ''; } catch (_) {} }
        campaignGreeting = campaign.call_script.opening
          .replace(/\{\{name\}\}/gi, cl.lead_name || 'Sir/Madam')
          .replace(/\{\{company\}\}/gi, leadCompany)
          .trim();
      }

      const newCallLog = await base44.entities.CallLog.create({
        client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
        call_sid: callSid, caller_id: selectedDID, callee_number: cl.lead_phone,
        direction: 'outbound', status: 'initiated', call_start_time: new Date().toISOString(),
        conversation_summary: '',
        agent_config_cache: {
          agent_name: agent.name, system_prompt: personalizedPrompt,
          persona: agent.persona || {}, knowledge_base_content: kbContent, lead_context: leadContext,
          greeting_message: campaignGreeting,
          human_transfer_number: agent.human_transfer_number || '',
          enable_auto_transfer: agent.enable_auto_transfer !== false
        }
      });

      await base44.entities.CampaignLead.update(cl.id, { call_log_id: newCallLog.id });

      // Use agent's own API token (falls back to global key for demo agents)
      let smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
      try {
        const clientData = await base44.entities.Client.get(campaign.client_id);
        if (clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding')) {
          smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
        }
      } catch (_) {}

      // Pass call_log_id via custom_identifier — Smartflo echoes it back to streamAudio for EXACT match
      let cleanCallerID = selectedDID.replace(/[^0-9]/g, '');
      if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;
      const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: smartfloApiKey,
          customer_number: cleanPhone,
          caller_id: cleanCallerID,
          custom_identifier: newCallLog.id,
          async: 1
        })
      });

      const smartfloData = await smartfloResp.json();
      if (!(smartfloResp.ok && smartfloData.success !== false)) {
        await base44.entities.CallLog.update(newCallLog.id, { status: 'failed' });
        await base44.entities.CampaignLead.update(cl.id, {
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
      await base44.entities.CampaignLead.update(cl.id, {
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
  await base44.entities.CampaignLead.update(campaignLead.id, { outcome, conversation_summary: summary });

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

    // Update lead — protect existing higher scores from downgrade on neutral outcomes
    const existingLead = lead || {};
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
    let finalScore = aiScore;
    let finalStatus = newLeadStatus;
    if (wasPositive && isNowNeutral && existingScore > aiScore) {
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
        const emailContent = await azureLLM(
          `Write a personalized follow-up email for ${client?.company_name || 'our company'}.
Lead: ${lead.name || 'Valued Customer'}, Company: ${lead.company || 'N/A'}
Call Summary: ${summary}
Reference specific topics discussed. Include a CTA. Under 200 words. HTML format.`,
          'You are an email copywriter. Always respond in valid JSON.',
          { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" } } }
        );
        await sendLeadEmail({
          to: lead.email, fromName: client?.company_name || 'Bolify AI',
          subject: emailContent.subject, clientId: campaign.client_id,
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

  // CALLBACK → re-queue the lead at the customer-requested time
  // Customer said "call back in X minutes/hours" → parse from transcript & schedule retry
  if (outcome === 'callback') {
    callbackScheduled = true;
    let callbackAtMs = null;
    try {
      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const cbResult = await azureLLM(
        `Current IST: ${nowIST}\n\nThe customer asked to be called back. Extract the EXACT requested callback time from this transcript:\n\n${callLog.transcript || summary}\n\nReturn an ISO 8601 datetime in IST timezone (e.g. "2026-05-04T15:30:00+05:30"). If unclear, return minutes_from_now (number of minutes from now to call back, default 60 if completely unclear).`,
        'You are a callback time extractor. Always respond in valid JSON.',
        { type: "object", properties: { callback_iso: { type: "string" }, minutes_from_now: { type: "number" }, confidence: { type: "string" } } }
      );
      if (cbResult.callback_iso) {
        const parsed = new Date(cbResult.callback_iso);
        if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) callbackAtMs = parsed.getTime();
      }
      if (!callbackAtMs && cbResult.minutes_from_now && cbResult.minutes_from_now > 0) {
        callbackAtMs = Date.now() + cbResult.minutes_from_now * 60000;
      }
      console.log(`[campaignPostCall] Parsed callback: iso=${cbResult.callback_iso}, mins=${cbResult.minutes_from_now}, scheduled=${callbackAtMs ? new Date(callbackAtMs).toISOString() : 'none'}`);
    } catch (cbErr) {
      console.error(`[campaignPostCall] Callback time parse failed: ${cbErr.message}`);
    }
    // Default: 1 hour from now if AI parse failed
    if (!callbackAtMs) callbackAtMs = Date.now() + 60 * 60000;

    // Re-queue this CampaignLead so the poller will retry the call at the requested time
    await base44.entities.CampaignLead.update(campaignLead.id, {
      status: 'pending',
      call_log_id: null,
      followup_call_date: new Date(callbackAtMs).toISOString(),
      attempt_count: (campaignLead.attempt_count || 0)
    });
    console.log(`[campaignPostCall] ✅ Callback re-queued for ${new Date(callbackAtMs).toISOString()} (lead: ${campaignLead.lead_name})`);
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

  // Update follow-up flags (don't overwrite followup_call_date — callback handler already set it correctly)
  await base44.entities.CampaignLead.update(campaignLead.id, {
    followup_email_sent: emailSent,
    followup_scheduled: callbackScheduled
  });

  // ============================================================
  // Bolify AI CRM — WhatsApp/RCS via CRM automation
  // ============================================================
  if (lead && (lead.phone || lead.email) && outcome !== 'not_answered') {
    try {
      const bolifyCrmToken = Deno.env.get('GETWAY_CRM_API_TOKEN');
      if (bolifyCrmToken) {
        const crmParams = new URLSearchParams();
        crmParams.set('api_token', bolifyCrmToken);
        crmParams.set('contact_name', lead.name || campaignLead.lead_name || 'Unknown');
        if (lead.email) crmParams.set('contact_email', lead.email);
        if (lead.phone) crmParams.set('contact_phone', lead.phone);
        if (summary) crmParams.set('call_summary', summary.substring(0, 500));
        if (outcome) crmParams.set('call_outcome', outcome);
        if (callLog.duration) crmParams.set('call_duration', String(callLog.duration));
        if (client?.company_name) crmParams.set('client_company', client.company_name);
        if (campaign?.name) crmParams.set('campaign_name', campaign.name);
        if (campaignId) crmParams.set('campaign_id', campaignId);
        crmParams.set('source', 'campaign');
        if (lead.status) crmParams.set('lead_status', lead.status);
        if (aiScore) crmParams.set('lead_score', String(aiScore));
        if (qualificationTier) crmParams.set('qualification_tier', qualificationTier);

        const crmResp = await fetch(`https://login.getwaycrm.com/api/automations/69cb6ef8707f8/execute?${crmParams.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
        const crmResult = await crmResp.json();
        console.log(`[campaignPostCall] Bolify CRM sent for ${lead.phone || lead.email}: ${crmResult.status}`);
      }
    } catch (bolifyErr) {
      console.error(`[campaignPostCall] Bolify CRM failed: ${bolifyErr.message}`);
    }
  }

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
      const appId = Deno.env.get('BASE44_APP_ID');
      const cronKey = Deno.env.get('CRON_API_KEY');
      const enrollRes = await fetch(`https://app.base44.com/api/apps/${appId}/functions/autoEnrollSequence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': cronKey || '',
          'Base44-App-Id': appId || ''
        },
        body: JSON.stringify(enrollPayload)
      });
      const enrollResult = enrollRes.ok ? await enrollRes.json() : null;
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
    // Bounded status-filtered reads instead of a full-table scan (was a major 429 driver).
    const counts = await fetchStatusCounts(base44, campaignId);
    const outcomes = countOutcomes([...counts.completed, ...counts.failed]);
    const update = { outcomes_summary: outcomes, calls_completed: counts.completed.length, calls_failed: counts.failed.length };
    // Only mark completed if NO pending, NO calling, and NO processing leads
    if (counts.pending.length === 0 && counts.calling.length === 0 && counts.processing.length === 0) {
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
        await sendLeadEmail({
          to: lead.email, fromName: client?.company_name || 'Bolify AI',
          subject: emailContent.subject, clientId: campaign.client_id,
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

  // CALLBACK → re-queue the lead at the customer-requested time
  if (outcome === 'callback') {
    callbackScheduled = true;
    let callbackAtMs = null;
    try {
      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const cbResult = await azureLLM(
        `Current IST: ${nowIST}\n\nThe customer asked to be called back. Extract the EXACT requested callback time from this transcript:\n\n${callLog.transcript || summary}\n\nReturn an ISO 8601 datetime in IST timezone (e.g. "2026-05-04T15:30:00+05:30"). If unclear, return minutes_from_now (number of minutes from now to call back, default 60 if completely unclear).`,
        'You are a callback time extractor. Always respond in valid JSON.',
        { type: "object", properties: { callback_iso: { type: "string" }, minutes_from_now: { type: "number" }, confidence: { type: "string" } } }
      );
      if (cbResult.callback_iso) {
        const parsed = new Date(cbResult.callback_iso);
        if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) callbackAtMs = parsed.getTime();
      }
      if (!callbackAtMs && cbResult.minutes_from_now && cbResult.minutes_from_now > 0) {
        callbackAtMs = Date.now() + cbResult.minutes_from_now * 60000;
      }
      console.log(`[doFollowUpActions] Parsed callback: scheduled=${callbackAtMs ? new Date(callbackAtMs).toISOString() : 'none'}`);
    } catch (cbErr) {
      console.error(`[doFollowUpActions] Callback time parse failed: ${cbErr.message}`);
    }
    if (!callbackAtMs) callbackAtMs = Date.now() + 60 * 60000;

    await base44.entities.CampaignLead.update(campaignLead.id, {
      status: 'pending',
      call_log_id: null,
      followup_call_date: new Date(callbackAtMs).toISOString(),
      followup_email_sent: emailSent,
      followup_scheduled: true
    });
    console.log(`[doFollowUpActions] ✅ Callback re-queued for ${new Date(callbackAtMs).toISOString()}`);
  } else {
    // Non-callback outcomes: just update flags (don't override followup_call_date)
    await base44.entities.CampaignLead.update(campaignLead.id, {
      followup_email_sent: emailSent,
      followup_scheduled: callbackScheduled
    });
  }

  // ============================================================
  // Bolify AI CRM — WhatsApp/RCS via CRM automation (doFollowUpActions)
  // ============================================================
  if (lead && (lead.phone || lead.email) && outcome !== 'not_answered') {
    try {
      const bolifyCrmToken = Deno.env.get('GETWAY_CRM_API_TOKEN');
      if (bolifyCrmToken) {
        const crmParams = new URLSearchParams();
        crmParams.set('api_token', bolifyCrmToken);
        crmParams.set('contact_name', lead.name || campaignLead.lead_name || 'Unknown');
        if (lead.email) crmParams.set('contact_email', lead.email);
        if (lead.phone) crmParams.set('contact_phone', lead.phone);
        const summaryText = lead.notes || '';
        if (summaryText) crmParams.set('call_summary', summaryText.substring(0, 500));
        if (outcome) crmParams.set('call_outcome', outcome);
        if (client?.company_name) crmParams.set('client_company', client.company_name);
        if (campaign?.name) crmParams.set('campaign_name', campaign.name);
        crmParams.set('source', 'campaign');
        if (lead.score) crmParams.set('lead_score', String(lead.score));
        if (qualificationTier) crmParams.set('qualification_tier', qualificationTier);

        const crmResp = await fetch(`https://login.getwaycrm.com/api/automations/69cb6ef8707f8/execute?${crmParams.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
        const crmResult = await crmResp.json();
        console.log(`[campaignPostCall:doFollowUp] Bolify CRM sent: ${crmResult.status}`);
      }
    } catch (bolifyErr) {
      console.error(`[campaignPostCall:doFollowUp] Bolify CRM failed: ${bolifyErr.message}`);
    }
  }

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
      const appId = Deno.env.get('BASE44_APP_ID');
      const cronKey = Deno.env.get('CRON_API_KEY');
      const enrollRes = await fetch(`https://app.base44.com/api/apps/${appId}/functions/autoEnrollSequence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': cronKey || '',
          'Base44-App-Id': appId || ''
        },
        body: JSON.stringify(enrollPayload)
      });
      const enrollResult = enrollRes.ok ? await enrollRes.json() : null;
      if (enrollResult?.enrolled) {
        console.log(`[campaignPostCall] ✉️ Auto-enrolled in sequence: ${enrollResult.sequence_name}`);
      }
    } catch (seqErr) {
      console.error(`[campaignPostCall] Auto-enroll failed: ${seqErr.message}`);
    }
  }

  return { outcome, emailSent, callbackScheduled, aiScore, qualificationTier };
}