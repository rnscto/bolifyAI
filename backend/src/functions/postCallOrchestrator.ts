import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// postCallOrchestrator — single idempotent post-call pipeline (Phase 1)
// ═══════════════════════════════════════════════════════════════════════
// Collapses the ~9 separate post-call invokes that smartfloWebbook / stream
// functions used to fire (postCallFollowup, postCallActionExtractor,
// crmAutomation, autoCreateLeadFromInbound, dispatchPostCall*, recording fetch)
// into ONE controlled, idempotent pipeline. This is the single biggest 429
// reducer: instead of N callers each firing 5-9 invokes per completed call
// (and Smartflo re-delivering the terminal webhook 2-3×), every caller now
// invokes THIS once, and we atomically claim the call via post_processed.
//
// Idempotency: we set CallLog.post_processed=true BEFORE running. If it's
// already true, we no-op. Callers may pass force=true to re-run (admin/debug).
//
// Invoked by: smartfloWebhook, stream* saveCallRecord, twilioWebbook,
//             signalWireWebhook — all with { call_log_id }.
// ═══════════════════════════════════════════════════════════════════════



// ─── PG fallback for Option-A campaign CallLogs (which live in Postgres only) ───
function makePgClient() {
  return new PgClient({
    hostname: Deno.env.get('AZURE_PG_HOST'),
    port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
    database: Deno.env.get('AZURE_PG_DATABASE'),
    user: Deno.env.get('AZURE_PG_USER'),
    password: Deno.env.get('AZURE_PG_PASSWORD'),
    tls: { enabled: true, enforce: true },
    connection: { attempts: 1 },
  });
}
async function pgGetCallLog(callLogId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT id, client_id, agent_id, lead_id, call_sid, caller_id, callee_number,
             direction, status, duration, transcript, conversation_summary, recording_url,
             lead_status_updated, post_processed, agent_config_cache
      FROM call_logs WHERE id = ${callLogId} LIMIT 1`;
    return res.rows[0] || null;
  } catch (_) {
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
async function pgMarkPostProcessed(callLogId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`UPDATE call_logs SET post_processed = true, updated_at = now() WHERE id = ${callLogId}`;
  } catch (_) {} finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

export default async function postCallOrchestrator(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // ── External-caller guard ──
    // Internal callers (smartfloWebhook, stream* via svc.functions.invoke) never
    // send the x-callback-secret header and are allowed through unchanged.
    // External callers — e.g. the Azure container's post-call callback — identify
    // themselves WITH the header, which must match the CONTAINER_CALLBACK_SECRET
    // app secret. This protects the public function URL from anonymous abuse
    // without affecting any existing internal invoke path.
    const callbackSecretHeader = req.headers.get('x-callback-secret');
    if (callbackSecretHeader !== null) {
      const expected = Deno.env.get('CONTAINER_CALLBACK_SECRET') || '';
      if (!expected || callbackSecretHeader !== expected) {
        return c.json({ data: { error: 'Unauthorized' } }, 401);
      }
    }

    const body = await c.req.json().catch(() => ({}));
    const callLogId = body.call_log_id;
    const force = body.force === true;
    if (!callLogId) {
      return c.json({ data: { error: 'call_log_id required' } }, 400);
    }

    let ls = body.lead_scoring;

    // Resolve the CallLog from Base44, falling back to Postgres for Option-A
    // campaign dials (CallLog written to PG only, never mirrored to Base44).
    let callLog = await svc.entities.CallLog.get(callLogId).catch(() => null);
    let isPgOnly = false;
    if (!callLog) {
      callLog = await pgGetCallLog(callLogId);
      isPgOnly = !!callLog;
    }
    if (!callLog) {
      return c.json({ data: { error: 'CallLog not found' } }, 404);
    }

    // ── Idempotency claim ──
    // CRITICAL: this MUST come before the lead-scoring write-back. Smartflo
    // re-delivers the terminal webhook 2-3× and some duplicate callbacks arrive
    // WITHOUT scoring (status=contacted/score=0/tier=cold) — running the write
    // before the claim let those duplicates CLOBBER the good values. Now any
    // duplicate bounces off post_processed here and can never overwrite.
    if (callLog.post_processed && !force) {
      // RE-FIRE WEBHOOK ON LATE SCORING: the earlier trigger (often Smartflo's
      // terminal webhook at hangup) claims post_processed BEFORE the container's
      // gpt-5 AI analysis finishes, so dispatchOutboundWebhook deferred (no score/
      // summary yet). When the container's data-rich callback arrives later WITH
      // real lead_scoring, we must still deliver it to the client's CRM — so we
      // run JUST the webhook dispatch here (the rest of the pipeline already ran).
      const incomingScore = typeof ls?.score === 'number' ? ls.score : null;
      const lateSignal = ls && ls.lead_id && (
        (incomingScore !== null && incomingScore > 0) ||
        !!(ls.conversation_summary || '').trim()
      );
      if (lateSignal && callLog.client_id && callLog.client_id !== 'unknown') {
        try {
          await svc.functions.invoke('dispatchOutboundWebhook', {
            call_log_id: callLogId,
            lead_scoring: ls,
          });
          console.log(`[postCallOrchestrator] Re-fired webhook with late scoring for ${callLogId} (score=${incomingScore})`);
        } catch (e) {
          console.error(`[postCallOrchestrator] Late webhook re-fire failed for ${callLogId}: ${e.message}`);
        }
      }
      return c.json({ data: { skipped: true, reason: 'already_post_processed', refired_webhook: !!lateSignal } });
    }
    // Claim immediately so concurrent duplicate webhooks bounce off.
    if (isPgOnly) {
      await pgMarkPostProcessed(callLogId);
    } else {
      await svc.entities.CallLog.update(callLogId, { post_processed: true }).catch(() => {});
    }

    // ── SCREENING BRANCH (AI Screening end-to-end on PG) ──
    // Screening calls have NO lead — they finalize in PG and carry screening
    // metadata in agent_config_cache. Route them to processScreeningResult with
    // the resolved PG transcript, then stop (skip the lead/CRM/follow-up pipeline
    // which doesn't apply to a candidate screening). This is the single reliable
    // path: container finalizes PG → orchestrator → screening analysis from PG.
    const cache = callLog.agent_config_cache || {};
    if (cache.is_screening_call && cache.screening_call_id) {
      try {
        const r = await svc.functions.invoke('processScreeningResult', {
          screening_call_id: cache.screening_call_id,
          call_log_id: callLogId,
          call_log: callLog,
          transcript: callLog.transcript || '',
        });
        console.log(`[postCallOrchestrator] Screening processed for ${cache.screening_call_id}:`, JSON.stringify(r?.data || {}).substring(0, 200));
      } catch (e) {
        console.error(`[postCallOrchestrator] Screening processing failed for ${cache.screening_call_id}: ${e.message}`);
      }
      // Release the DID slot, then we're done — no lead pipeline for screening.
      if (callLog.caller_id) {
        await svc.functions.invoke('pgDidConcurrency', {
          service_call: true, action: 'decrement', did_number: callLog.caller_id,
        }).catch(() => {});
      }
      return c.json({ data: { success: true, call_log_id: callLogId, screening: true } });
    }

    // ── SELF-HEAL: derive scoring from the CallLog when none was passed ──
    // Campaign calls finalize in Postgres and the container *should* POST its
    // lead_scoring here, but if that callback ever fires WITHOUT scoring (or the
    // PG-only CallLog already carries a summary + disposition), the Base44 Lead
    // would otherwise stay at score 0 / status "new". When body.lead_scoring is
    // absent but the CallLog has a transcript-derived disposition + summary, we
    // reconstruct a minimal scoring patch straight from the CallLog so the Lead
    // still gets its status + summary. This makes the write-back reliable
    // regardless of whether the container included scoring.
    if ((!ls || !ls.lead_id) && callLog.lead_id) {
      const summary = callLog.conversation_summary || '';
      // Pull a "Score: NN" if the container embedded it in the summary text.
      let derivedScore = null;
      const m = /Score:\s*(\d{1,3})\s*\/\s*100/i.exec(summary);
      if (m) derivedScore = Math.min(100, Math.max(0, parseInt(m[1], 10)));
      // Disposition: prefer the CallLog's resolved lead_status_updated; if the
      // stream's saveCallRecord never wrote one (e.g. AI analysis failed, short
      // call, or the WS isolate died before the Lead update), fall back to a
      // neutral 'contacted' so the manual call STILL reflects on the lead instead
      // of leaving it silently unchanged. This is the reliability fix for "call
      // placed but nothing updated".
      const st = callLog.lead_status_updated || 'contacted';
      // Tier from disposition + score (mirrors the container's tiering).
      let tier = null;
      if (st === 'converted') tier = 'hot';
      else if (derivedScore !== null) {
        tier = derivedScore >= 75 ? 'hot' : derivedScore >= 50 ? 'warm' : derivedScore >= 25 ? 'nurture' : 'cold';
      }
      ls = {
        lead_id: callLog.lead_id,
        status: st,
        score: derivedScore !== null ? derivedScore : undefined,
        qualification_tier: tier || undefined,
        conversation_summary: summary,
      };
      console.log(`[postCallOrchestrator] Self-healed lead_scoring from CallLog ${callLogId}: status=${st} (resolved=${callLog.lead_status_updated || 'none→contacted'}), score=${derivedScore}`);
    }

    // ── Lead scoring write-back (from the Azure container) ──
    // The container computes AI lead score/sentiment/tier in saveCallRecord but
    // its SDK is unauthenticated, so it can only write to the Postgres `leads`
    // mirror — NOT the Base44 Lead that LeadDetail reads. We (service-role) write
    // it here. Runs AFTER the idempotency claim so it executes exactly once and a
    // later no-scoring duplicate can never downgrade the lead.
    if (ls && ls.lead_id) {
      try {
        // Read the current lead so we can DOWNGRADE-PROTECT. Smartflo re-delivers
        // the terminal webhook and the container can fire >1 callback; a later
        // degenerate one (score=0 / status=contacted / tier=cold, empty summary)
        // must NEVER clobber a good score that already landed. We only apply a
        // field when the incoming value is genuinely better/non-empty.
        const cur = await svc.entities.Lead.get(ls.lead_id).catch(() => ({}));
        const patch = {};

        const incomingScore = typeof ls.score === 'number' ? ls.score : null;
        const curScore = typeof cur.score === 'number' ? cur.score : 0;
        // This callback carries a real signal only if it scored > 0 OR named a
        // non-default disposition. A degenerate callback (score 0 + contacted)
        // is ignored entirely so it can't downgrade an already-scored lead.
        const hasSignal =
          (incomingScore !== null && incomingScore > 0) ||
          (ls.status && !['contacted', 'new'].includes(ls.status));

        if (hasSignal) {
          if (ls.status) patch.status = ls.status;
          if (incomingScore !== null && incomingScore >= curScore) patch.score = incomingScore;
          if (ls.sentiment) patch.sentiment = ls.sentiment;
          if (ls.qualification_tier) patch.qualification_tier = ls.qualification_tier;
          if (ls.qualification_reason) patch.qualification_reason = ls.qualification_reason;
          if (Array.isArray(ls.intent_signals)) patch.intent_signals = ls.intent_signals;
          if (ls.score_breakdown && typeof ls.score_breakdown === 'object') patch.score_breakdown = ls.score_breakdown;
        } else if (curScore === 0 && ls.status) {
          // Lead never scored AND this is a genuine no-signal outcome
          // (no_answer / voicemail / not_interested) → record the disposition only.
          patch.status = ls.status;
          if (ls.sentiment) patch.sentiment = ls.sentiment;
        }

        // Call Summary — append the AI conversation_summary to the lead notes so
        // it shows on LeadDetail. Only when non-empty and not already present.
        const summary = (ls.conversation_summary || '').trim();
        if (summary) {
          const existingNotes = cur.notes || '';
          if (!existingNotes.includes(summary.slice(0, 40))) {
            const dateTag = `[${new Date().toISOString().slice(0, 10)}]`;
            patch.notes = existingNotes
              ? `${existingNotes}\n\n${dateTag} ${summary}`
              : `${dateTag} ${summary}`;
          }
        }

        // ALWAYS stamp engagement metadata so a completed call ALWAYS reflects on
        // the lead, even when the disposition carried no score/summary signal.
        // Without this, a call could complete and leave the lead totally unchanged
        // (the "call placed but nothing updated" bug). Downgrade-protection above
        // still guards status/score; this only touches engagement timestamps.
        patch.last_call_date = new Date().toISOString();
        patch.last_engagement_date = new Date().toISOString();
        patch.engagement_count = (cur.engagement_count || 0) + 1;

        await svc.entities.Lead.update(ls.lead_id, patch);
        console.log(`[postCallOrchestrator] Lead ${ls.lead_id} written: status=${patch.status ?? cur.status}, score=${patch.score ?? cur.score}, tier=${patch.qualification_tier ?? cur.qualification_tier}, summary=${summary ? 'yes' : 'no'}, signal=${hasSignal}`);

        // ── CALLBACK SAFETY-NET ──
        // When the call disposition is "callback", GUARANTEE a callback Activity
        // + next_followup_date exist — independent of the AI action-extractor
        // (which can be skipped on short/PG-only transcripts or simply not emit a
        // callback action). Without this, callback leads showed up with NO
        // scheduled callback activity. Idempotent: only creates if none exists.
        const resultingStatus = patch.status || cur.status;
        if (resultingStatus === 'callback') {
          try {
            const existing = await svc.entities.Activity.filter({
              lead_id: ls.lead_id, status: 'scheduled',
            }).catch(() => []);
            const hasCallback = (existing || []).some(a => ['call', 'followup'].includes(a.type));
            if (!hasCallback) {
              // Use an AI-extracted follow-up time if present, else default to
              // 2 hours from now (the "call me back later" convention).
              let when = cur.next_followup_date;
              if (!when || isNaN(new Date(when).getTime())) {
                when = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
              }
              let ownerEmail = '';
              if (callLog.client_id) {
                const c = await svc.entities.Client.get(callLog.client_id).catch(() => null);
                ownerEmail = c?.email || '';
              }
              await svc.entities.Activity.create({
                client_id: callLog.client_id,
                lead_id: ls.lead_id,
                call_log_id: callLogId,
                type: 'call',
                title: `Callback requested by ${cur.name || 'lead'}`,
                description: 'Auto-created from a call where the customer requested a callback.',
                scheduled_date: when,
                status: 'scheduled',
                priority: 'high',
                auto_created: true,
                assigned_to: ownerEmail,
              });
              await svc.entities.Lead.update(ls.lead_id, { next_followup_date: when }).catch(() => {});
              console.log(`[postCallOrchestrator] Callback safety-net: created callback activity for lead ${ls.lead_id} at ${when}`);
            }
          } catch (e) {
            console.error(`[postCallOrchestrator] Callback safety-net failed for ${ls.lead_id}: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`[postCallOrchestrator] Lead scoring write-back failed for ${ls.lead_id}: ${e.message}`);
      }
    }

    const hasTranscript = !!(callLog.transcript && callLog.transcript.length > 50);
    const isInbound = callLog.direction === 'inbound';
    const knownClient = callLog.client_id && callLog.client_id !== 'unknown';
    const ran = [];

    // Helper: invoke a downstream fn, swallow errors, record what ran.
    const step = async (fnName, payload, condition = true) => {
      if (!condition) return;
      try {
        await svc.functions.invoke(fnName, payload);
        ran.push(fnName);
      } catch (e) {
        console.error(`[postCallOrchestrator] ${fnName} failed for ${callLogId}: ${e.message}`);
      }
    };

    // The standard entity-automation payload shape the downstream fns expect.
    const automationPayload = {
      event: { type: 'update', entity_name: 'CallLog', entity_id: callLogId },
      data: callLog,
      old_data: { ...callLog, status: 'answered' }
    };

    // Whether this CallLog belongs to a campaign — campaign follow-ups are owned
    // by the campaign pipeline (campaignPostCall), so we skip the generic
    // follow-up/CRM steps for them (they'd be duplicates) regardless of store.
    const isCampaignCall = !!(callLog.campaign_id) || !!(callLog.agent_config_cache?.campaign_id);

    if (!isCampaignCall) {
      // ── 1. Outreach / follow-up (email/RCS for non-campaign calls) ──
      //    For PG-only calls we pass the resolved row as `data` so the downstream
      //    fn uses it directly instead of doing a Base44 .get (which would 404).
      await step('postCallFollowup', automationPayload);

      // ── 3. CRM automation (follow-up tasks) ──
      await step('crmAutomation', automationPayload);
    }

    // ── 2. Action extraction (lead notes, activities, blueprint fields/stage) ──
    //    Creates the demo/meeting Activity → Google Calendar event (Meet link) →
    //    WhatsApp/email meeting-link dispatch. For PG-only dials we PASS the
    //    resolved CallLog so the extractor doesn't 404 on a Base44 .get — this is
    //    what restores Meet links + WhatsApp meeting links after the PG migration.
    await step(
      'postCallActionExtractor',
      isPgOnly ? { call_log_id: callLogId, call_log: callLog } : { call_log_id: callLogId },
      hasTranscript
    );

    // ── 4. Auto-create lead for unknown inbound callers with a transcript ──
    await step(
      'autoCreateLeadFromInbound',
      { call_log_id: callLogId },
      isInbound && !callLog.lead_id && knownClient && hasTranscript && !isPgOnly
    );

    // ── 5. Recording fetch (Smartflo CDR) — only if not already present.
    //    Replaces the unreliable setTimeout-in-isolate pattern: this runs in a
    //    fresh function invocation that is NOT torn down with the call's WS isolate.
    await step('fetchCallRecording', { call_log_id: callLogId }, !callLog.recording_url);

    // ── 5b. Outbound signed webhook (status_complete) to the client's CRM.
    //    Fires ONCE per call (idempotency-guarded above). No-ops if the client
    //    has no active WebhookEndpoint registered. We re-fetch the CallLog inside
    //    dispatchOutboundWebhook so it picks up the recording_url just fetched.
    //    CRITICAL: pass the in-hand `ls` scoring (the container's authoritative
    //    score/summary, already used for the Base44 Lead write-back above) so the
    //    webhook does NOT have to re-read the PG `leads` table — that re-read was
    //    racing the container's pgUpdateLead commit and sending stale score 0 /
    //    empty summary to the client's CRM.
    await step(
      'dispatchOutboundWebhook',
      {
        call_log_id: callLogId,
        ...(isPgOnly ? { call_log: callLog } : {}),
        ...(ls && ls.lead_id ? { lead_scoring: ls } : {}),
      },
      knownClient
    );

    // ── 6. DID concurrency decrement (atomic) ──
    //    initiateCall incremented active_count on dial-start. This runs exactly
    //    once per call (idempotency-guarded above), so it's the safe place to
    //    release the slot. Now backed by Azure Postgres (pgDidConcurrency)
    //    instead of the rate-limited Base44 DIDConcurrency entity. Best-effort.
    if (callLog.caller_id) {
      try {
        await svc.functions.invoke('pgDidConcurrency', {
          service_call: true,
          action: 'decrement',
          did_number: callLog.caller_id,
        });
      } catch (e) {
        console.error(`[postCallOrchestrator] DID decrement failed for ${callLog.caller_id}: ${e.message}`);
      }
    }

    console.log(`[postCallOrchestrator] Done ${callLogId}: ran=[${ran.join(', ')}]`);
    return c.json({ data: { success: true, call_log_id: callLogId, ran } });
  } catch (error) {
    console.error('[postCallOrchestrator] Fatal:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};