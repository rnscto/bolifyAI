import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// dispatchOutboundWebhook — push a signed status_complete event to the client's CRM
// ═══════════════════════════════════════════════════════════════════════
// Fired ONCE per completed call by postCallOrchestrator (idempotent there).
// Looks up the client's active WebhookEndpoint, builds the canonical payload
// (collected.* + outcome_label + signed recording/transcript URLs), HMAC-SHA256
// signs it, and POSTs it. Retries up to 3× with backoff. Auto-pauses a dead
// endpoint after repeated failures.
//
// Signature: header `X-Vaani-Signature: sha256=<hex>` over the raw JSON body,
// using the endpoint's signing_secret. Also sends `X-Vaani-Event: status_complete`
// and `X-Vaani-Delivery: <uuid>`.
//
// Payload:
//   {
//     "event": "status_complete",
//     "delivery_id": "...",
//     "call": { call_id, call_sid, direction, status, duration, started_at, ended_at,
//               agent_id, caller_id, phone, outcome_label, summary,
//               recording_url, transcript_url },
//     "lead": { lead_id, crm_id, name, status, score },
//     "collected": { name, email, phone, alt_phone, alt_email, course_interest,
//                    lead_score, best_follow_up_at, remarks, next_action, consent }
//   }
// Invoked with: { call_log_id } (optionally { call_log } for PG-only dials).
// ═══════════════════════════════════════════════════════════════════════



function genUuid() {
  return crypto.randomUUID();
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

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
             lead_status_updated, call_start_time, call_end_time
      FROM call_logs WHERE id = ${callLogId} LIMIT 1`;
    return res.rows[0] || null;
  } catch (_) { return null; } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}

// Read the lead's finalized score/summary/sentiment straight from PG `leads`
// (the container's source of truth, written by pgUpdateLead). The Base44 Lead
// can lag the PG write, so for the webhook we trust PG — this is why the client's
// CRM was receiving score 0 / empty summary even though PG + our CRM had them.
async function pgGetLeadScore(leadId) {
  if (!leadId) return null;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT score, status, sentiment, last_summary
      FROM leads WHERE id = ${leadId} LIMIT 1`;
    return res.rows[0] || null;
  } catch (_) { return null; } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}

// Map a CallLog's status + lead status into the public outcome_label taxonomy.
function deriveOutcomeLabel(callLog, lead) {
  const cs = (callLog.status || '').toLowerCase();
  if (cs === 'no_answer') return 'not_answered';
  if (cs === 'failed') return 'failed';
  const ls = (callLog.lead_status_updated || lead?.status || '').toLowerCase();
  const map = {
    interested: 'interested',
    not_interested: 'not_interested',
    callback: 'callback',
    converted: 'converted',
    do_not_call: 'do_not_call',
    contacted: 'neutral',
    new: 'neutral'
  };
  return map[ls] || 'neutral';
}

// Sign an azblob:// recording URI into a time-limited https URL (24h TTL).
// Pass through any already-https provider URL (Smartflo CDR) unchanged.
async function resolveRecordingUrl(svc, recordingUrl) {
  if (!recordingUrl) return null;
  if (recordingUrl.startsWith('azblob://')) {
    try {
      const res = await svc.functions.invoke('azureBlobSignedUrl', { file_uri: recordingUrl, expires_in: 86400 });
      return res?.data?.signed_url || null;
    } catch (_) { return null; }
  }
  return recordingUrl; // provider URL (already accessible)
}

async function postWithRetry(url, headers, body) {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return { ok: true, status: res.status };
      lastErr = String(res.status);
      // Don't retry 4xx (client rejected the payload) — only 5xx / network.
      if (res.status >= 400 && res.status < 500) return { ok: false, status: res.status };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? 'timeout' : e.message;
    }
    await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
  }
  return { ok: false, status: lastErr };
}

export default async function dispatchOutboundWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));
    const callLogId = body.call_log_id;
    // Authoritative scoring passed by postCallOrchestrator (the container's
    // computed score/summary). When present we PREFER it over re-reading the PG
    // `leads` table — re-reading raced the container's commit and produced the
    // stale score 0 / empty summary the client's CRM was receiving.
    const ls = (body.lead_scoring && typeof body.lead_scoring === 'object') ? body.lead_scoring : null;
    if (!callLogId) return c.json({ data: { error: 'call_log_id required' } }, 400);

    // Resolve CallLog. IMPORTANT: a caller-passed `call_log` may be an early
    // dial-time snapshot (status='ringing', no duration/summary/transcript). The
    // canonical, finalized row lives in Postgres, so we ALWAYS re-read PG by id
    // and only fall back to the passed snapshot / Base44 if PG has nothing. This
    // was the bug: clients received webhooks built from the ringing snapshot
    // (duration:0, summary='[LEAD SNAPSHOT]...', transcript:null).
    let callLog = await pgGetCallLog(callLogId);
    if (!callLog) callLog = await svc.entities.CallLog.get(callLogId).catch(() => null);
    if (!callLog) callLog = body.call_log || null;
    if (!callLog) return c.json({ data: { error: 'CallLog not found' } }, 404);

    // GUARD: never dispatch a status_complete event for a call that hasn't
    // finalized yet. If the row is still ringing/initiated/answered, the real
    // duration/summary/transcript aren't written — skip now; the webhook will be
    // re-fired by postCallOrchestrator once the call is finalized.
    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    if (!terminalStatuses.includes((callLog.status || '').toLowerCase())) {
      console.log(`[dispatchOutboundWebhook] SKIP — call ${callLogId} not finalized (status=${callLog.status})`);
      return c.json({ data: { skipped: true, reason: 'call_not_finalized', status: callLog.status } });
    }

    const clientId = callLog.client_id;
    if (!clientId || clientId === 'unknown') return c.json({ data: { skipped: true, reason: 'no_client' } });

    // Find an active webhook endpoint for this client.
    const endpoints = await svc.entities.WebhookEndpoint.filter({ client_id: clientId, status: 'active' });
    const endpoint = endpoints.find(e => (e.events || ['status_complete']).includes('status_complete'));
    if (!endpoint) return c.json({ data: { skipped: true, reason: 'no_webhook_registered' } });

    // Load the lead for collected.* + identifiers.
    const lead = callLog.lead_id ? await svc.entities.Lead.get(callLog.lead_id).catch(() => null) : null;
    const cf = (lead?.custom_fields && typeof lead.custom_fields === 'object') ? lead.custom_fields : {};

    // PG `leads` is the container's source of truth for score/summary and may be
    // ahead of the Base44 Lead. Pull from PG and prefer it for the webhook so the
    // client's CRM gets the real finalized score/summary, not a lagging 0/empty.
    const pgLead = await pgGetLeadScore(callLog.lead_id);

    // ── DEFER GUARD (the real fix) ──
    // Two independent paths trigger this dispatch: (1) Smartflo's terminal webhook,
    // which fires at hangup — BEFORE the container's gpt-5 AI analysis finishes
    // (~30-60s later), and (2) the container's own post-call callback, which fires
    // AFTER the analysis with the real score/summary. Path (1) used to win and send
    // an empty payload (score 0 / blank summary). We now DEFER on path (1): if the
    // call had a real conversation (transcript present OR meaningful duration) but
    // no score/summary is available yet from ANY source, skip sending now. The
    // later, data-rich callback re-fires and delivers the correct payload.
    const haveScore =
      (typeof ls?.score === 'number' && ls.score > 0) ||
      (typeof pgLead?.score === 'number' && pgLead.score > 0);
    const haveSummary = !!(
      (ls?.conversation_summary || '').trim() ||
      (callLog.conversation_summary || '').trim() ||
      (pgLead?.last_summary || '').trim()
    );
    const wasRealConversation =
      !!(callLog.transcript && callLog.transcript.trim().length > 30) ||
      (callLog.status === 'completed' && (callLog.duration || 0) >= 15);
    if (wasRealConversation && !haveScore && !haveSummary) {
      console.log(`[dispatchOutboundWebhook] DEFER — call ${callLogId} analysis not ready (no score/summary yet); will re-fire after AI analysis`);
      return c.json({ data: { skipped: true, reason: 'analysis_not_ready' } });
    }

    const recordingUrl = await resolveRecordingUrl(svc, callLog.recording_url);
    const phone = callLog.callee_number || lead?.phone || '';

    // The dial-time placeholder summary ("[LEAD SNAPSHOT] ...") written by
    // initiateCall is NOT a real call summary. If a finalized row still carries
    // it (no AI summary produced), send an empty summary rather than the snapshot.
    // Source priority: passed-in scoring (no race) → PG call_logs.conversation_summary
    // → PG leads.last_summary.
    const rawSummary = (ls?.conversation_summary || '').trim()
      || callLog.conversation_summary || pgLead?.last_summary || '';
    const cleanSummary = rawSummary.trim().startsWith('[LEAD SNAPSHOT]') ? '' : rawSummary;

    // Score/status: prefer the passed-in scoring (the container's authoritative
    // value, no PG-read race), then PG leads, then Base44 Lead. This is THE fix
    // for the client's CRM receiving score 0 — the PG re-read raced the commit.
    const leadScore = (typeof ls?.score === 'number' ? ls.score : null)
      ?? (typeof pgLead?.score === 'number' ? pgLead.score : null)
      ?? (typeof lead?.score === 'number' ? lead.score : 0);
    const leadStatus = ls?.status || pgLead?.status || lead?.status || null;

    // collected.* — primary CRM fields the agent captures. We surface the
    // canonical lead fields plus any matching custom_fields keys.
    const collected = {
      name: lead?.name || cf.name || '',
      email: lead?.email || cf.email || '',
      phone,
      alt_phone: cf.alt_phone || cf.alternate_phone || '',
      alt_email: cf.alt_email || cf.alternate_email || '',
      course_interest: cf.course_interest || cf.interest || '',
      lead_score: leadScore,
      best_follow_up_at: lead?.next_followup_date || cf.best_follow_up_at || null,
      remarks: cleanSummary,
      next_action: cf.next_action || leadStatus || '',
      consent: cf.consent ?? null
    };

    const payload = {
      event: 'status_complete',
      delivery_id: genUuid(),
      sent_at: new Date().toISOString(),
      // Top-level phone — some client CRMs (e.g. ebhaya.com) require the phone
      // at the payload root to match the record, and reject with HTTP 400
      // "Phone number missing in webhook payload" otherwise.
      phone,
      call: {
        call_id: callLog.id,
        call_sid: callLog.call_sid || null,
        direction: callLog.direction || 'outbound',
        status: callLog.status || 'completed',
        duration: callLog.duration || 0,
        started_at: callLog.call_start_time || null,
        ended_at: callLog.call_end_time || null,
        agent_id: callLog.agent_id || null,
        caller_id: callLog.caller_id || null,
        phone,
        outcome_label: deriveOutcomeLabel(callLog, { status: leadStatus }),
        summary: cleanSummary,
        recording_url: recordingUrl,
        transcript: callLog.transcript || null
      },
      lead: {
        lead_id: lead?.id || callLog.lead_id || null,
        crm_id: lead?.crm_id || null,
        name: lead?.name || '',
        status: leadStatus,
        score: leadScore
      },
      collected
    };

    const rawBody = JSON.stringify(payload);
    const signature = await hmacSha256Hex(endpoint.signing_secret, rawBody);
    const headers = {
      'Content-Type': 'application/json',
      'X-Vaani-Event': 'status_complete',
      'X-Vaani-Delivery': payload.delivery_id,
      'X-Vaani-Signature': `sha256=${signature}`
    };

    const result = await postWithRetry(endpoint.target_url, headers, rawBody);

    // Update endpoint health (best-effort).
    const failures = result.ok ? 0 : (endpoint.consecutive_failures || 0) + 1;
    const upd = {
      last_delivery_at: new Date().toISOString(),
      last_delivery_status: String(result.status),
      consecutive_failures: failures,
      delivery_count: (endpoint.delivery_count || 0) + (result.ok ? 1 : 0)
    };
    // Auto-pause an endpoint that fails 10× in a row to stop hammering a dead URL.
    if (failures >= 10) upd.status = 'paused';
    svc.entities.WebhookEndpoint.update(endpoint.id, upd).catch(() => {});

    return c.json({ data: { success: result.ok, delivered_to: endpoint.target_url, status: result.status } });
  } catch (error) {
    console.error('[dispatchOutboundWebhook] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};