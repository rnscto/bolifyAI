import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { Client as PgClient } from "jsr:@db/postgres@0.19.4";



// ─── Direct Postgres DID-concurrency helpers ───
// Reading/writing live per-DID active counts via base44.functions.invoke('pgDidConcurrency')
// was intermittently returning 403/429 under load, stalling the 1-in-1-out call
// replacement. We hit the same did_concurrency table DIRECTLY here — no cross-function
// invoke, no auth gate, no rate-limit bucket.
const norm10Did = (d) => String(d || '').replace(/\D/g, '').slice(-10);
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
async function pgGetActiveCounts(didNumbers) {
  const dids = (didNumbers || []).map(norm10Did).filter(Boolean);
  const active = {};
  if (dids.length === 0) return active;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT did_number, active_count FROM did_concurrency
      WHERE did_number = ANY(${dids})`;
    for (const r of res.rows) active[r.did_number] = Number(r.active_count) || 0;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
  return active;
}
async function pgIncrement(didNumber, clientId, maxConcurrent) {
  const did = norm10Did(didNumber);
  if (!did) return;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      INSERT INTO did_concurrency (did_number, client_id, max_concurrent, active_count, last_increment_at, updated_at)
      VALUES (${did}, ${clientId || null}, ${maxConcurrent || 1}, 1, now(), now())
      ON CONFLICT (did_number) DO UPDATE
        SET active_count = did_concurrency.active_count + 1,
            last_increment_at = now(), updated_at = now(),
            max_concurrent = ${maxConcurrent || 1},
            client_id = COALESCE(did_concurrency.client_id, EXCLUDED.client_id)`;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════
// POSTGRES-PRIMARY DIAL PRIMITIVES (identical to campaignPoller's path).
// triggerNextCampaignCall now claims + dials through THESE so it shares ONE
// atomic lock with campaignPoller — no Base44 race, no double-dials, zero
// Base44 in the dial hot path. CallLog lives in PG only (streamGeminiOutgoing
// reads its config from PG; smartfloWebhook resolves completion via PG id).
// ═══════════════════════════════════════════════════════════════════
function genUuid() {
  try { return crypto.randomUUID(); }
  catch (_) { return 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12); }
}
// Atomic claim: pending → calling. Returns true only if THIS run won the row.
// false = already claimed; 'not_mirrored' = row absent from PG; null = PG down.
async function pgClaimLead(leadId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      UPDATE campaign_leads
        SET status = 'calling',
            attempt_count = COALESCE(attempt_count, 0) + 1,
            updated_at = now()
      WHERE id = ${leadId} AND status = 'pending'
      RETURNING id`;
    if (res.rows.length > 0) return true;
    const exists = await pg.queryObject`SELECT 1 FROM campaign_leads WHERE id = ${leadId} LIMIT 1`;
    return exists.rows.length > 0 ? false : 'not_mirrored';
  } catch (e) {
    console.warn(`[smartfloWebhook] pgClaimLead failed (${e.message})`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// Fetch the next ready pending lead directly from PG (canonical state).
async function pgGetPendingBatch(campaignId, limit) {
  const pg = makePgClient();
  const nowIso = new Date().toISOString();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT id, lead_id, lead_name, lead_phone, attempt_count, followup_call_date
      FROM campaign_leads
      WHERE campaign_id = ${campaignId}
        AND status = 'pending'
        AND (followup_call_date IS NULL OR followup_call_date <= ${nowIso}::timestamptz)
      ORDER BY created_date ASC
      LIMIT ${limit}`;
    return res.rows;
  } catch (e) {
    console.warn(`[smartfloWebhook] pgGetPendingBatch failed (${e.message})`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// PG counts for the free-slot decision (calling + processing + pending_ready).
async function pgGetCampaignSlotCounts(campaignId) {
  const pg = makePgClient();
  const nowIso = new Date().toISOString();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('calling','processing'))::int AS in_flight,
        COUNT(*) FILTER (
          WHERE status = 'pending'
            AND (followup_call_date IS NULL OR followup_call_date <= ${nowIso}::timestamptz)
        )::int AS pending_ready
      FROM campaign_leads
      WHERE campaign_id = ${campaignId}`;
    const r = res.rows[0] || {};
    return { in_flight: r.in_flight || 0, pending_ready: r.pending_ready || 0 };
  } catch (e) {
    console.warn(`[smartfloWebhook] pgGetCampaignSlotCounts failed (${e.message})`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// Insert the dial CallLog into Postgres (incl. agent_config_cache blob).
async function pgInsertCallLog(row) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const nowIso = new Date().toISOString();
    await pg.queryObject`
      INSERT INTO call_logs
        (id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
         callee_number, direction, status, agent_config_cache, call_start_time,
         created_date, updated_at)
      VALUES
        (${row.id}, ${row.client_id}, ${row.agent_id}, ${row.lead_id || null},
         ${row.campaign_id || null}, ${row.call_sid}, ${row.caller_id},
         ${row.callee_number}, 'outbound', ${row.status || 'initiated'},
         ${JSON.stringify(row.agent_config_cache || {})}::jsonb, ${nowIso}::timestamptz,
         ${nowIso}::timestamptz, ${nowIso}::timestamptz)
      ON CONFLICT (id) DO NOTHING`;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
async function pgUpdateCallLogStatus(id, callSid, status) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    if (callSid) {
      await pg.queryObject`UPDATE call_logs SET call_sid = ${callSid}, status = ${status}, updated_at = now() WHERE id = ${id}`;
    } else {
      await pg.queryObject`UPDATE call_logs SET status = ${status}, updated_at = now() WHERE id = ${id}`;
    }
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
async function pgAttachCallLog(leadId, callLogId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`UPDATE campaign_leads SET call_log_id = ${callLogId}, updated_at = now() WHERE id = ${leadId}`;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
async function pgResetLeadPending(leadId, decrementAttempt = false) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    if (decrementAttempt) {
      await pg.queryObject`
        UPDATE campaign_leads
          SET status = 'pending', call_log_id = NULL,
              attempt_count = GREATEST(0, COALESCE(attempt_count, 1) - 1), updated_at = now()
        WHERE id = ${leadId}`;
    } else {
      await pg.queryObject`UPDATE campaign_leads SET status = 'pending', call_log_id = NULL, updated_at = now() WHERE id = ${leadId}`;
    }
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
async function pgFailLead(leadId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      UPDATE campaign_leads SET status = 'completed', outcome = 'not_answered', updated_at = now()
      WHERE id = ${leadId}`;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// Resolve a PG CallLog by Smartflo's native call_sid OR by callee+caller phone —
// NO 60-row / 5-min scan window. This is the loss-reduction match: under burst
// dialing the target call gets buried past the Base44 head-page scan, so the
// terminal webhook returned "not found" (200) and the DID slot leaked. A direct
// indexed PG lookup finds it regardless of age or volume. Returns a row shaped
// like the Base44 entity (with _pg_only marker) so the handler works unchanged.
async function pgFindWebhookCallLogByCall(callSid, calleeLast10, callerLast10) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    // 1) Exact call_sid match (set on the first ringing webhook).
    if (callSid) {
      const bySid = await pg.queryObject`
        SELECT id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
               callee_number, direction, status, transcript, conversation_summary,
               duration, lead_status_updated, recording_url, transferred_to,
               agent_config_cache
        FROM call_logs WHERE call_sid = ${callSid} LIMIT 1`;
      if (bySid.rows[0]) return bySid.rows[0];
    }
    // 2) Phone fallback — only a non-terminal call from the last 30 min, and
    //    only if it's UNAMBIGUOUS (exactly one match) to avoid swapping records.
    if (calleeLast10) {
      const byPhone = await pg.queryObject`
        SELECT id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
               callee_number, direction, status, transcript, conversation_summary,
               duration, lead_status_updated, recording_url, transferred_to,
               agent_config_cache
        FROM call_logs
        WHERE status IN ('initiated','ringing','answered')
          AND created_date > now() - INTERVAL '30 minutes'
          AND right(regexp_replace(callee_number, '\\D', '', 'g'), 10) = ${calleeLast10}
          AND (${callerLast10}::text IS NULL
               OR right(regexp_replace(caller_id, '\\D', '', 'g'), 10) = ${callerLast10})
        LIMIT 2`;
      if (byPhone.rows.length === 1) return byPhone.rows[0];
    }
    return null;
  } catch (e) {
    console.warn(`[smartfloWebhook] pgFindWebhookCallLogByCall failed (${e.message})`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Read a PG-only campaign CallLog by id (for webhook resolution). Returns a row
// shaped like the Base44 entity so the downstream handler works unchanged.
async function pgGetWebhookCallLog(callLogId) {
  if (!callLogId) return null;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
             callee_number, direction, status, transcript, conversation_summary,
             duration, lead_status_updated, recording_url, transferred_to,
             agent_config_cache
      FROM call_logs WHERE id = ${callLogId} LIMIT 1`;
    return res.rows[0] || null;
  } catch (e) {
    console.warn(`[smartfloWebhook] pgGetWebhookCallLog failed (${e.message})`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// Finalize a PG-only campaign CallLog from the webhook (status/duration/recording/summary).
async function pgWebhookFinalizeCallLog(callLogId, fields) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      UPDATE call_logs SET
        status = ${fields.status},
        duration = COALESCE(${fields.duration ?? null}, duration),
        recording_url = COALESCE(${fields.recording_url ?? null}, recording_url),
        conversation_summary = COALESCE(${fields.conversation_summary ?? null}, conversation_summary),
        lead_status_updated = COALESCE(${fields.lead_status_updated ?? null}, lead_status_updated),
        call_end_time = ${fields.call_end_time || new Date().toISOString()}::timestamptz,
        updated_at = now()
      WHERE id = ${callLogId}`;
  } catch (e) {
    console.warn(`[smartfloWebhook] pgWebhookFinalizeCallLog failed (${e.message})`);
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// Resolve the CampaignLead that owns a PG CallLog id (for the no-answer/next-call path).
async function pgGetCampaignLeadByCallLog(callLogId) {
  if (!callLogId) return null;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT id, campaign_id, client_id, lead_id, status, outcome, call_log_id,
             attempt_count, lead_name, lead_phone, followup_email_sent
      FROM campaign_leads WHERE call_log_id = ${callLogId} LIMIT 1`;
    return res.rows[0] || null;
  } catch (e) {
    console.warn(`[smartfloWebhook] pgGetCampaignLeadByCallLog failed (${e.message})`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// Mark a PG CampaignLead completed with the resolved outcome (canonical write).
async function pgCompleteCampaignLead(leadId, fields) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      UPDATE campaign_leads SET
        status = 'completed',
        outcome = ${fields.outcome || 'neutral'},
        call_status = ${fields.call_status || 'answered'},
        conversation_summary = ${fields.conversation_summary || ''},
        transcript = ${fields.transcript || ''},
        call_duration = ${fields.call_duration || 0},
        updated_at = now()
      WHERE id = ${leadId} AND status IN ('calling', 'processing')`;
  } catch (e) {
    console.warn(`[smartfloWebhook] pgCompleteCampaignLead failed (${e.message})`);
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}
// Queue a no-answer retry for a PG CampaignLead.
async function pgQueueRetry(leadId, attemptCount, retryHours) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const retryIso = new Date(Date.now() + retryHours * 3600000).toISOString();
    await pg.queryObject`
      UPDATE campaign_leads SET
        status = 'pending', outcome = 'not_answered',
        attempt_count = ${attemptCount}, call_log_id = NULL,
        followup_call_date = ${retryIso}::timestamptz, updated_at = now()
      WHERE id = ${leadId}`;
  } catch (e) {
    console.warn(`[smartfloWebhook] pgQueueRetry failed (${e.message})`);
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// v3: Bypass Base44 automations — directly invoke post-call functions inline.
// This eliminates dependency on Base44 entity automations (which consume credits).
// Also replaced InvokeLLM with Azure OpenAI for inbound call analysis.

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

// ─── Send Telegram notification directly (no function invoke) ───
async function sendTelegramDirect(client, { caller_number, caller_name, category, urgency, summary, type, recording_url }) {
  if (!client || !client.telegram_connected || !client.telegram_chat_id || !TELEGRAM_BOT_TOKEN) return;
  if (client.owner_notification_channel !== 'telegram' || client.dnd_enabled) return;

  try {
    let emoji = '📞';
    if (category === 'spam') emoji = '🚫';
    else if (category === 'family') emoji = '👨‍👩‍👧';
    else if (category === 'business') emoji = '💼';
    else if (category === 'promotional') emoji = '📢';
    else if (urgency === 'urgent') emoji = '🚨';

    const notifType = type || 'call';
    let message = notifType === 'summary' 
      ? `📋 <b>Call Summary</b>\n\n` 
      : `${emoji} <b>Incoming Call</b>\n\n`;
    message += `📱 From: <b>${caller_name || caller_number || 'Unknown'}</b>\n`;
    if (caller_name && caller_number) message += `📞 Number: ${caller_number}\n`;
    if (category) message += `🏷️ Category: ${category}\n`;
    if (urgency && urgency !== 'medium') message += `⚡ Urgency: ${urgency.toUpperCase()}\n`;
    if (summary) message += `\n💬 ${summary}`;
    if (recording_url) message += `\n\n🎧 <a href="${recording_url}">Play Recording</a>`;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: client.telegram_chat_id,
        text: message,
        parse_mode: 'HTML'
      })
    });
    const result = await res.json();
    console.log(`[smartfloWebhook] Telegram sent to ${client.company_name}: ok=${result.ok}`);
  } catch (e) {
    console.error(`[smartfloWebhook] Telegram send failed: ${e.message}`);
  }
}

// Map Smartflo call statuses to internal statuses
const STATUS_MAP = {
  'ringing': 'ringing',
  'answered': 'answered',
  'Answered': 'answered',
  'completed': 'completed',
  'Completed': 'completed',
  'missed': 'no_answer',
  'Missed': 'no_answer',
  'not_connected': 'no_answer',
  'Not Connected': 'no_answer',
  'failed': 'failed',
  'Failed': 'failed',
  'no_answer': 'no_answer',
  'No Answer': 'no_answer',
  'busy': 'failed',
  'Busy': 'failed',
  'cancelled': 'failed',
  'Cancelled': 'failed'
};

export default async function smartfloWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Use createClient with asServiceRole — same pattern as streamAudio which works
    const appId = Deno.env.get('BASE44_APP_ID');
    /* const base44 = ... */;

    // Webhook authentication: verify shared secret (always required)
    const url = new URL(req.url);
    const webhookSecret = url.searchParams.get('secret');
    const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
    if (!expectedSecret || webhookSecret !== expectedSecret) {
      console.error('[smartfloWebhook] Invalid or missing webhook secret');
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    // Handle non-POST or empty body requests (health checks, GET pings)
    if (req.method === 'GET') {
      return c.json({ data: { success: true, message: 'Smartflo webhook is active' } });
    }

    let payload;
    try {
      const bodyText = await req.text();
      if (!bodyText || bodyText.trim() === '') {
        return c.json({ data: { success: true, message: 'Empty body received, ignoring' } });
      }
      payload = JSON.parse(bodyText);
    } catch (e) {
      console.error('[smartfloWebhook] Invalid JSON body:', e.message);
      return c.json({ data: { error: 'Invalid JSON body' } }, 400);
    }

    // Smartflo webhook field mapping: Smartflo sends call_status, caller_id_number, call_to_number, etc.
    // Normalize to our internal names
    const call_id = payload.call_id || payload.uuid;
    const status = payload.call_status || payload.status;
    const duration = payload.duration || payload.billsec;
    const recording_url = payload.recording_url;
    const direction = payload.direction;
    const caller_number = payload.caller_id_number || payload.caller_number || payload.from;
    const called_number = payload.call_to_number || payload.called_number || payload.to;
    const customer_number = payload.customer_no_with_prefix || payload.customer_number || '';
    const hangup_cause = payload.hangup_cause_description || payload.reason_key || '';
    const customer_ring_time = payload.customer_ring_time || '';

    console.log(`[smartfloWebhook] Received: status=${status}, call_id=${call_id}, direction=${direction}, caller=${caller_number}, callee=${called_number}, customer=${customer_number}, duration=${duration}, hangup=${hangup_cause}, ring_time=${customer_ring_time}, recording=${recording_url || 'none'}`);
    console.log(`[smartfloWebhook] Full payload keys: ${Object.keys(payload).join(', ')}`);

    if (!call_id) {
      return c.json({ data: { success: false, error: 'Missing call_id' } }, 400);
    }

    // ===== INCOMING CALL IDENTIFICATION & AI ROUTING =====
    // Inbound routing (concurrency cap, DID→agent→client resolution, PATH A/B/C/D)
    // lives in the dedicated smartfloInboundRouter function to keep this file
    // maintainable. We invoke it and forward its response verbatim.
    if (direction === 'inbound' || payload.type === 'inbound') {
      const incomingNumber = caller_number || payload.from || payload.caller_id;
      const calledDID = called_number || payload.to || payload.called_number || '';
      console.log(`[smartfloWebhook] Incoming call from: ${incomingNumber}, to DID: ${calledDID} — delegating to smartfloInboundRouter`);

      if (incomingNumber) {
        try {
          const routed = await base44.functions.invoke('smartfloInboundRouter', {
            call_id, status, incomingNumber, calledDID
          });
          const rd = routed?.data || {};
          if (rd.early_return) {
            return c.json({ data: rd.body }, rd.http_status || 200);
          }
        } catch (routeErr) {
          console.error(`[smartfloWebhook] smartfloInboundRouter invoke failed: ${routeErr.message}`);
        }
      }
    }

    // ===== EXISTING OUTBOUND/STATUS UPDATE LOGIC =====
    const knownStatuses = ['ringing', 'answered', 'completed', 'failed', 'no_answer', 'busy', 'cancelled', 'missed', 'not_connected'];
    if (status && !knownStatuses.includes(status)) {
      console.warn('[smartfloWebhook] Unknown status:', status);
    }

    // PRIMARY MATCH: custom_identifier — our dialer sends `custom_identifier: callLog.id`
    // to Smartflo and Smartflo echoes it back in EVERY webhook. This is the most
    // reliable match: a direct record .get() with no scanning, and it sidesteps the
    // UUID-vs-native-SID mismatch (the root cause of calls stuck in "ringing").
    let callLogs = [];
    const customIdentifier = payload.custom_identifier || payload.custom_field || payload['$custom_identifier'] || '';
    if (customIdentifier) {
      try {
        const byCustomId = await base44.entities.CallLog.get(customIdentifier);
        if (byCustomId) {
          callLogs = [byCustomId];
          console.log(`[smartfloWebhook] ✅ Matched by custom_identifier: ${customIdentifier}`);
          // Persist Smartflo's native call_id so future webhooks for this call also match on call_sid.
          if (call_id && byCustomId.call_sid !== call_id) {
            try { await base44.entities.CallLog.update(byCustomId.id, { call_sid: call_id }); } catch (_) {}
          }
        }
      } catch (_) { /* not a valid Base44 CallLog id — see PG-first fallback below */ }

      // ─── POSTGRES-FIRST DIAL PATH (Option A — zero Base44 CallLog) ───
      // All campaign dials (poller + inline next-call) now write the CallLog to
      // Postgres ONLY; custom_identifier IS that PG CallLog id, so the Base44
      // .get above 404s. We resolve the call DIRECTLY from PG (no Base44 mirror
      // creation) and build a synthetic callLog object the rest of the handler
      // uses. Terminal completion for these calls is written back to PG via
      // pgWebhookFinalize below — the CampaignDetail UI reads from PG.
      if (callLogs.length === 0) {
        const pgLog = await pgGetWebhookCallLog(customIdentifier);
        if (pgLog) {
          pgLog._pg_only = true; // marker — downstream writes go to PG, not Base44
          if (call_id && pgLog.call_sid !== call_id) {
            pgUpdateCallLogStatus(customIdentifier, call_id, pgLog.status || 'ringing').catch(() => {});
          }
          callLogs = [pgLog];
          console.log(`[smartfloWebhook] ✅ PG-only call resolved: ${customIdentifier} (no Base44 CallLog)`);
        }
      }
    }

    // Find call log by call_sid — try multiple ID formats
    if (callLogs.length === 0) {
      callLogs = await base44.entities.CallLog.filter({ call_sid: call_id });
    }

    // Fallback 0: Try numeric core of call_id (e.g. "1774958890" from "h11.08-1774958890.307488")
    if (callLogs.length === 0 && call_id) {
      const numericCore = call_id.replace(/^[^-]*-/, '').replace(/\.[^.]*$/, '');
      if (numericCore && numericCore !== call_id) {
        const coreLogs = await base44.entities.CallLog.filter({ call_sid: numericCore });
        if (coreLogs.length > 0) { callLogs = coreLogs; console.log(`[smartfloWebhook] Matched by numeric core: ${numericCore}`); }
      }
    }

    // Fallback 1: Try matching by stream_sid if present in payload
    if (callLogs.length === 0 && payload.stream_sid) {
      const streamLogs = await base44.entities.CallLog.filter({ stream_sid: payload.stream_sid });
      if (streamLogs.length > 0) { callLogs = streamLogs; console.log(`[smartfloWebhook] Matched by stream_sid: ${payload.stream_sid}`); }
    }

    // Fallback 1.5 (PG DIRECT — loss reducer): before the expensive Base44 60-row /
    // 5-min phone scan, try a direct indexed PG lookup by call_sid, then by
    // callee+caller. This finds calls buried past the Base44 scan window (the #1
    // cause of "Call log not found" → leaked DID slot). PG-only campaign calls are
    // resolved here too (their CallLog never existed in Base44).
    if (callLogs.length === 0) {
      const pgCallee = (customer_number || payload.customer_number || called_number || '').replace(/\D/g, '').slice(-10) || null;
      const pgCaller = (caller_number || '').replace(/\D/g, '').slice(-10) || null;
      const pgMatch = await pgFindWebhookCallLogByCall(call_id, pgCallee, pgCaller);
      if (pgMatch) {
        pgMatch._pg_only = true;
        if (call_id && pgMatch.call_sid !== call_id) {
          pgUpdateCallLogStatus(pgMatch.id, call_id, pgMatch.status || 'ringing').catch(() => {});
        }
        callLogs = [pgMatch];
        console.log(`[smartfloWebhook] ✅ PG-direct match: CallLog ${pgMatch.id} (by ${call_id && pgMatch.call_sid === call_id ? 'call_sid' : 'phone'})`);
      }
    }

    // Fallback 2: if Smartflo sends a different ID format, try matching by phone number.
    // CRITICAL: Require BOTH callee and caller (DID) to match — OR a unique callee match —
    // otherwise concurrent calls on the same agent/DID can get their recordings swapped.
    if (callLogs.length === 0) {
      // Extract callee (customer) and caller (DID) from webhook payload separately
      const webhookCallee = (customer_number || payload.customer_number || called_number || '').replace(/\D/g, '').slice(-10);
      const webhookCaller = (caller_number || '').replace(/\D/g, '').slice(-10);
      if (webhookCallee || webhookCaller) {
        console.log(`[smartfloWebhook] No match for call_sid=${call_id}, trying strict phone fallback: callee=${webhookCallee}, caller=${webhookCaller}`);

        // Scan 60 rows/status (was 20): under burst dialing the target CallLog gets
        // buried past the first 20 recent rows, so the terminal webhook never matched
        // it → the log stayed stuck in 'ringing' forever. 60 rows covers realistic
        // concurrency. Same 3 reads as before — just deeper — so NO added 429 risk.
        const [ringingLogs, initiatedLogs, answeredLogs] = await Promise.all([
          base44.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 60),
          base44.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 60),
          base44.entities.CallLog.filter({ status: 'answered' }, '-created_date', 60)
        ]);
        const allRecent = [...ringingLogs, ...initiatedLogs, ...answeredLogs]
          .filter(l => Date.now() - new Date(l.created_date).getTime() < 5 * 60 * 1000);

        // Tier 1: Match on BOTH callee AND caller (DID) — safest for concurrent calls
        let candidates = allRecent.filter(l => {
          const logCallee = (l.callee_number || '').replace(/\D/g, '').slice(-10);
          const logCaller = (l.caller_id || '').replace(/\D/g, '').slice(-10);
          return webhookCallee && webhookCaller && logCallee === webhookCallee && logCaller === webhookCaller;
        });

        // Tier 2: If no dual match, match on callee only BUT only if there's exactly ONE candidate
        // (avoids swapping recordings between two concurrent calls to the same number)
        if (candidates.length === 0 && webhookCallee) {
          const calleeMatches = allRecent.filter(l => {
            const logCallee = (l.callee_number || '').replace(/\D/g, '').slice(-10);
            return logCallee === webhookCallee;
          });
          if (calleeMatches.length === 1) candidates = calleeMatches;
          else if (calleeMatches.length > 1) {
            console.warn(`[smartfloWebhook] ⚠️ Ambiguous phone fallback: ${calleeMatches.length} CallLogs match callee=${webhookCallee} — refusing to guess`);
          }
        }

        if (candidates.length === 1) {
          callLogs = [candidates[0]];
          await base44.entities.CallLog.update(candidates[0].id, { call_sid: call_id });
          console.log(`[smartfloWebhook] Matched by strict phone fallback: CallLog ${candidates[0].id} (callee=${candidates[0].callee_number}, DID=${candidates[0].caller_id}), updated call_sid to ${call_id}`);
        }
      }
    }

    if (callLogs.length === 0) {
      console.log('[smartfloWebhook] Call log not found:', call_id);
      return c.json({ data: { success: true, message: 'Call log not found, but webhook received' } });
    }

    const callLog = callLogs[0];
    const mappedStatus = STATUS_MAP[status] || status;

    // Idempotency guard: don't regress a terminal status
    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    if (terminalStatuses.includes(callLog.status)) {
      if (!terminalStatuses.includes(mappedStatus)) {
        console.log(`[smartfloWebhook] Ignoring status ${status} — CallLog already terminal (${callLog.status})`);
        return c.json({ data: { success: true, message: 'Ignoring — call already terminal' } });
      }
      // Also skip if already same terminal status
      if (callLog.status === mappedStatus) {
        console.log(`[smartfloWebhook] Ignoring duplicate terminal ${status}`);
        return c.json({ data: { success: true, message: 'Ignoring — duplicate terminal' } });
      }
    }

    // CRITICAL FIX 1: Smartflo sometimes sends "answered" with hangup_cause + duration
    // as the FINAL webhook (never sends a separate "completed" event).
    // Detect this: if status is "answered" but hangup_cause is present, the call is actually done.
    let effectiveStatus = mappedStatus;
    if (mappedStatus === 'answered' && hangup_cause && parseInt(duration) > 0) {
      console.log(`[smartfloWebhook] Detected "answered" with hangup_cause="${hangup_cause}" + duration=${duration} — treating as COMPLETED`);
      effectiveStatus = 'completed';
    }

    // CRITICAL FIX 2: If Smartflo sends "no_answer"/"failed" BUT we have proof the call
    // was actually answered (transcript captured by streamAudio OR duration > 5s OR
    // current status is already "answered"/"completed"), refuse to downgrade.
    // This prevents late/misclassified Smartflo webhooks from corrupting good records.
    if (effectiveStatus === 'no_answer' || effectiveStatus === 'failed') {
      const hasTranscript = callLog.transcript && callLog.transcript.length > 30;
      const hasRealDuration = parseInt(duration) > 5 || (callLog.duration && callLog.duration > 5);
      const alreadyAnswered = callLog.status === 'answered' || callLog.status === 'completed';
      if (hasTranscript || hasRealDuration || alreadyAnswered) {
        console.log(`[smartfloWebhook] ⚠️ Refusing to downgrade to ${effectiveStatus}: transcript=${hasTranscript}, duration=${hasRealDuration}, alreadyAnswered=${alreadyAnswered} — treating as completed`);
        effectiveStatus = 'completed';
      }
    }

    const updateData = { status: effectiveStatus };
    if (duration) updateData.duration = parseInt(duration);
    if (recording_url) {
      updateData.recording_url = recording_url;
      console.log(`[smartfloWebhook] 🎧 Recording URL found: ${recording_url.substring(0, 100)} → saving to CallLog ${callLog.id}`);
    }
    if (effectiveStatus === 'completed') updateData.call_end_time = new Date().toISOString();

    // PG-only campaign calls have no Base44 CallLog — write the status/recording
    // back to Postgres (canonical). Everything else updates the Base44 CallLog.
    if (callLog._pg_only) {
      await pgWebhookFinalizeCallLog(callLog.id, updateData);
    } else {
      await base44.entities.CallLog.update(callLog.id, updateData);
    }

    // If recording_url arrives, also update any VoicemailMessages linked to this call
    // and send a Telegram recording notification (recording often arrives after the call summary)
    if (recording_url && callLog.client_id && callLog.client_id !== 'unknown') {
      try {
        const recClient = await base44.entities.Client.get(callLog.client_id);
        if (recClient && recClient.account_type === 'personal') {
          // Resolve caller name and send recording notification to Telegram
          let recCallerName = '';
          try { const cleanRec = (callLog.caller_id || '').replace(/\D/g, '').slice(-10); if (cleanRec) { const tcRec = await base44.entities.TrustedContact.filter({ client_id: callLog.client_id }); const mRec = tcRec.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === cleanRec); if (mRec?.name) recCallerName = mRec.name; } } catch (_) {}
          sendTelegramDirect(recClient, {
            caller_number: callLog.caller_id || '',
            caller_name: recCallerName,
            type: 'summary',
            summary: '🎧 Call recording is now available.',
            recording_url: recording_url
          });
        }
      } catch (_) {}
    }

    // If this webhook delivers a recording_url for an already-completed transferred call,
    // trigger the full recording analysis now (the terminal-status block below may have already fired)
    if (recording_url && callLog.transferred_to && terminalStatuses.includes(callLog.status)) {
      console.log(`[smartfloWebhook] Recording URL arrived for already-completed transferred call ${callLog.id} — triggering analysis`);
      base44.functions.invoke('processTransferRecording', { call_log_id: callLog.id })
        .then(() => console.log(`[smartfloWebhook] processTransferRecording triggered (late recording)`))
        .catch(e => console.error(`[smartfloWebhook] processTransferRecording (late) failed: ${e.message}`));
    }

    // NOTE: Lead status updates are handled EXCLUSIVELY by campaignPostCall (for campaign calls)
    // or streamAudio.saveCallRecord (for answered calls with transcripts).
    // smartfloWebhook only updates CallLog to avoid race conditions.

    // ─── PG-ONLY CAMPAIGN CALL: terminal handling (zero Base44 CallLog) ───
    // The CallLog + CampaignLead live in Postgres. streamGeminiOutgoing already
    // finalized answered calls in PG (transcript/summary/score). Here we handle
    // the no-answer/failed outcome + no-answer retry + trigger the next call —
    // all against PG. Then return early (the Base44 path below is skipped).
    if (callLog._pg_only && (effectiveStatus === 'completed' || effectiveStatus === 'no_answer' || effectiveStatus === 'failed')) {
      try {
        const cLead = await pgGetCampaignLeadByCallLog(callLog.id);
        if (cLead && cLead.status === 'calling') {
          const isNoAnswer = effectiveStatus === 'no_answer' || effectiveStatus === 'failed';
          const hadConversation = (callLog.transcript && callLog.transcript.length > 30) ||
                                  (parseInt(duration) > 5) || (callLog.duration && callLog.duration > 5);

          if (isNoAnswer && !hadConversation) {
            // No-answer / failed with no real conversation → outcome + retry logic.
            const campaign = await base44.entities.Campaign.get(cLead.campaign_id).catch(() => null);
            const rules = campaign?.followup_rules || {};
            const maxRetries = rules.no_answer_max_retries || 3;
            const currentAttempts = (cLead.attempt_count || 0); // already incremented by claim
            if (rules.no_answer_retry !== false && currentAttempts < maxRetries) {
              await pgQueueRetry(cLead.id, currentAttempts, rules.no_answer_retry_hours || 4);
              console.log(`[smartfloWebhook] PG no-answer retry ${currentAttempts}/${maxRetries} queued for ${cLead.lead_name}`);
            } else {
              await pgCompleteCampaignLead(cLead.id, {
                outcome: 'not_answered', call_status: 'not_answered',
                conversation_summary: 'Call was not answered.', call_duration: 0
              });
            }
          } else if (!hadConversation) {
            // Completed but no conversation captured — mark neutral terminal.
            await pgCompleteCampaignLead(cLead.id, {
              outcome: 'neutral', call_status: 'answered',
              conversation_summary: callLog.conversation_summary || 'Call completed.',
              transcript: callLog.transcript || '',
              call_duration: parseInt(duration) || 0
            });
          }
          // else: answered with conversation → streamGeminiOutgoing.pgFinalizeCallLog
          // already completed the lead in PG. Nothing to do here.

          // Trigger the next call (PG-atomic — shares the poller's lock).
          await triggerNextCampaignCall(base44, cLead.campaign_id);
        }
      } catch (e) {
        console.error(`[smartfloWebhook] PG-only terminal handling failed: ${e.message}`);
      }
      // Post-call fan-out (recording fetch, DID decrement) still runs via the
      // orchestrator, which reads the CallLog from PG when absent in Base44.
      base44.functions.invoke('postCallOrchestrator', { call_log_id: callLog.id })
        .catch(e => console.error(`[smartfloWebhook] postCallOrchestrator (pg) failed: ${e.message}`));
      return c.json({ data: { success: true, message: 'PG-only campaign call processed' } });
    }

    // Handle terminal call statuses
    if (effectiveStatus === 'completed' || effectiveStatus === 'no_answer' || effectiveStatus === 'failed') {
      // Set end time
      if (!updateData.call_end_time) {
        updateData.call_end_time = new Date().toISOString();
        await base44.entities.CallLog.update(callLog.id, { call_end_time: new Date().toISOString() });
      }

      // WebSocket-only approach: transcripts are captured by streamAudio in real-time.
      // No recording_url processing needed. For calls that ended without WebSocket
      // (no_answer, failed, busy, cancelled), add a status summary so campaignPostCall
      // entity automation can process them.
      if (effectiveStatus === 'no_answer' || effectiveStatus === 'failed') {
        const statusLabel = status; // preserve original Smartflo status for clarity
        // Only update summary if streamAudio hasn't already saved one AND call genuinely had no conversation
        const freshLog = await base44.entities.CallLog.get(callLog.id);
        const hasTranscript = freshLog.transcript && freshLog.transcript.length > 30;
        const hasRealDuration = (freshLog.duration && freshLog.duration > 5) || parseInt(duration) > 5;
        if (!hasTranscript && !hasRealDuration) {
          // For no-answer: set lead_status_updated to 'no_answer' — processTranscript/campaignPostCall
          // will preserve the lead's existing score and status when they see this
          await base44.entities.CallLog.update(callLog.id, {
            conversation_summary: `Call ended: ${statusLabel}${hangup_cause ? ' (' + hangup_cause + ')' : ''}${customer_ring_time ? '. Customer rang for ' + customer_ring_time + 's' : ''}. No conversation captured.`,
            lead_status_updated: 'no_answer'
          });
          console.log(`[smartfloWebhook] Terminal ${statusLabel} (effective: ${effectiveStatus}) — updated for campaign processing`);
        } else {
          console.log(`[smartfloWebhook] Terminal ${statusLabel} — transcript/duration indicates real conversation, skipping no-answer override`);
        }

        // NOTE: CampaignLead updates are handled EXCLUSIVELY by campaignPostCall entity automation
        // which triggers when this CallLog update is saved. No direct CampaignLead writes here
        // to avoid race conditions with campaignPostCall doing the same update.
      }

      // NOTE: For answered+completed calls, streamAudio's saveCallRecord handles
      // transcript, summary, AI scoring, activities, and sequence enrollment.

      // ═══════════════════════════════════════════════════════════════════
      // DIRECT INVOCATION: Bypass entity automations (saves Base44 credits)
      // Previously, updating CallLog would trigger entity automations for
      // campaignPostCall and postCallFollowup. Now we call them directly.
      // ═══════════════════════════════════════════════════════════════════
      
      // Re-read fresh CallLog to pass complete data
      const freshCallLog = await base44.entities.CallLog.get(callLog.id);
      
      // 1. Campaign post-call processing — handles lead progression + triggers next call
      //    IMPORTANT: We do this INLINE instead of via functions.invoke() because:
      //    - functions.invoke() adds latency and can timeout
      //    - Service-role clients can't always invoke functions reliably
      //    - Inline execution ensures the next call triggers immediately
      try {
        console.log(`[smartfloWebhook] Processing campaign post-call for CallLog ${callLog.id}`);
        
        // Check if this is a campaign call
        const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: callLog.id });
        
        if (campaignLeads.length > 0) {
          const campaignLead = campaignLeads[0];
          
          // Skip if already processed
          if (!['calling'].includes(campaignLead.status)) {
            console.log(`[smartfloWebhook] CampaignLead ${campaignLead.id} already ${campaignLead.status} — skipping`);
          } else {
            // Lock it
            await base44.entities.CampaignLead.update(campaignLead.id, { status: 'processing' });
            // SAFETY NET: wrap the entire processing block so a thrown error never leaves the lead stuck in 'processing'.
            // Without this, a failure between the lock and the `completed` update leaves leads frozen and blocks DID slots.
            let processedOk = false;
            let recoveryReason = '';
            try {
            
            // Wait briefly for streamAudio to finish saving transcript
            // (streamAudio may still be writing when Smartflo fires the webhook)
            await new Promise(r => setTimeout(r, 2000));
            
            // Re-read CallLog to get latest data (streamAudio may have updated it)
            const latestCallLog = await base44.entities.CallLog.get(callLog.id);
            
            // Determine basic outcome (fast, no LLM)
            let outcome = 'neutral';
            let clCallStatus = 'answered';
            let clSummary = latestCallLog.conversation_summary || '';
            
            // Transcript/duration is the ground truth for "was this answered?"
            // If either exists, the call was genuinely answered regardless of Smartflo's status label.
            const wasReallyAnswered = (latestCallLog.transcript && latestCallLog.transcript.length > 30) ||
                                       (latestCallLog.duration && latestCallLog.duration > 5);
            
            if (!wasReallyAnswered && (latestCallLog.status === 'no_answer' || freshCallLog.status === 'no_answer')) {
              outcome = 'not_answered'; clCallStatus = 'not_answered';
              clSummary = clSummary || 'Call was not answered.';
            } else if (!wasReallyAnswered && (latestCallLog.status === 'failed' || freshCallLog.status === 'failed')) {
              outcome = 'not_answered'; clCallStatus = 'not_answered';
              clSummary = clSummary || 'Call failed to connect.';
            } else if (latestCallLog.lead_status_updated) {
              // streamAudio already analyzed — map its outcome
              const statusToOutcome = {
                'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback',
                'voicemail': 'voicemail', 'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral', 'do_not_call': 'do_not_call'
              };
              outcome = statusToOutcome[latestCallLog.lead_status_updated] || 'neutral';
              if (latestCallLog.lead_status_updated === 'voicemail') clCallStatus = 'voicemail';
              clSummary = latestCallLog.conversation_summary || clSummary;
            }
            
            // Mark completed — include transcript/recording from latest CallLog.
            // PG is canonical (the CampaignDetail UI reads from PG), so write PG
            // FIRST (authoritative), then mirror to Base44 best-effort.
            {
              const completionFields = {
                status: 'completed', outcome, call_status: clCallStatus,
                conversation_summary: clSummary,
                transcript: latestCallLog.transcript || '',
                call_duration: latestCallLog.duration || parseInt(duration) || 0
              };
              await base44.functions.invoke('pgCampaignLeadSync', {
                campaign_lead: { id: campaignLead.id, campaign_id: campaignLead.campaign_id, ...completionFields }
              }).catch((e) => console.warn(`[smartfloWebhook] PG completion mirror skipped: ${e.message}`));
              await base44.entities.CampaignLead.update(campaignLead.id, completionFields);
            }
            console.log(`[smartfloWebhook] CampaignLead ${campaignLead.lead_name} → ${outcome}`);

            // Incremental counter bump (+1) — single-record update, no lead re-scan.
            // Skipped when a no-answer retry will re-queue the lead to 'pending' below
            // (only count terminal completions). Poller full recount reconciles drift.
            const willRetryNoAnswer = (() => {
              if (outcome !== 'not_answered') return false;
              const r = campaignLead.attempt_count || 0;
              return r + 1 < 3; // mirrors default max_retries; exact value reconciled by poller
            })();
            if (!willRetryNoAnswer) {
              await bumpCampaignCounter(base44, campaignLead.campaign_id, {
                completed: clCallStatus !== 'not_answered',
                failed: false,
                outcome
              });
            }

            // Handle no-answer retry — do NOT change lead status/score for unanswered calls
            if (outcome === 'not_answered') {
              // Only update engagement metadata on the lead, preserve status/score
              if (campaignLead.lead_id) {
                try {
                  await base44.entities.Lead.update(campaignLead.lead_id, {
                    last_call_date: new Date().toISOString(),
                    last_engagement_date: new Date().toISOString()
                  });
                  console.log(`[smartfloWebhook] Lead ${campaignLead.lead_id} — not_answered, preserved existing status/score`);
                } catch (_) {}
              }
              
              const campaign = await base44.entities.Campaign.get(campaignLead.campaign_id);
              const rules = campaign?.followup_rules || {};
              const maxRetries = rules.no_answer_max_retries || 3;
              const currentAttempts = (campaignLead.attempt_count || 0) + 1;
              let retryQueued = false;
              if (rules.no_answer_retry !== false && currentAttempts < maxRetries) {
                const retryHours = rules.no_answer_retry_hours || 4;
                await base44.entities.CampaignLead.update(campaignLead.id, {
                  status: 'pending', outcome: 'not_answered',
                  attempt_count: currentAttempts, call_log_id: null,
                  followup_call_date: new Date(Date.now() + retryHours * 3600000).toISOString()
                });
                console.log(`[smartfloWebhook] No-answer retry ${currentAttempts}/${maxRetries} queued`);
                retryQueued = true;
              }

              // ─── No-answer outreach (Email / WhatsApp) ───
              // Send if campaign rules say so AND either:
              //   (a) retries are disabled or exhausted, OR
              //   (b) the campaign opted to send on every no-answer (after_retries=false)
              const allRetriesExhausted = !retryQueued; // either retry disabled or max attempts hit
              const sendNow = (rules.no_answer_whatsapp_after_retries === false) || allRetriesExhausted;
              const wantWA = !!rules.no_answer_send_whatsapp && !!rules.no_answer_whatsapp_template_id;
              const wantEmail = !!rules.no_answer_send_email;
              if (sendNow && (wantWA || wantEmail) && !campaignLead.followup_email_sent) {
                try {
                  await sendNoAnswerOutreachInline(base44, campaign, campaignLead, latestCallLog);
                } catch (oErr) {
                  console.error(`[smartfloWebhook] No-answer outreach failed: ${oErr.message}`);
                }
              }
            }
            
            // TRIGGER NEXT CALL IMMEDIATELY (inline — no function invoke)
            await triggerNextCampaignCall(base44, campaignLead.campaign_id);

            // NOTE: Campaign stats (outcomes_summary, calls_completed, calls_failed) are
            // recomputed by campaignPoller every 5 min. We deliberately DO NOT recompute
            // them here — paginating through every campaign lead on each call completion
            // was the main cause of "Rate limit exceeded" (429) errors under high volume.
            processedOk = true;
            } catch (innerErr) {
              // Safety net: if anything between the 'processing' lock and the 'completed' update threw,
              // force the lead to 'completed' so the DID slot is freed and the poller doesn't have to rescue it.
              recoveryReason = innerErr?.message || 'unknown error';
              console.error(`[smartfloWebhook] Processing block threw for CampaignLead ${campaignLead.id}: ${recoveryReason}`);
            } finally {
              if (!processedOk) {
                try {
                  // Re-read the latest CallLog — streamAudio may have already saved a real
                  // transcript/summary/outcome even though the processing block threw later.
                  // If so, PRESERVE that real data instead of overwriting it with "neutral".
                  let recoverySummary = campaignLead.conversation_summary || '';
                  let recoveryOutcome = campaignLead.outcome || 'neutral';
                  let recoveryCallStatus = campaignLead.call_status || 'answered';
                  let recoveryTranscript = '';
                  let recoveryDuration = parseInt(duration) || 0;
                  try {
                    const recLog = await base44.entities.CallLog.get(callLog.id);
                    if (recLog) {
                      if (recLog.conversation_summary) recoverySummary = recLog.conversation_summary;
                      if (recLog.transcript) recoveryTranscript = recLog.transcript;
                      if (recLog.duration) recoveryDuration = recLog.duration;
                      // Map streamAudio's lead_status_updated to a campaign outcome if present
                      const statusToOutcome = {
                        interested: 'interested', not_interested: 'not_interested', callback: 'callback',
                        voicemail: 'voicemail', no_answer: 'not_answered', converted: 'converted', contacted: 'neutral', do_not_call: 'do_not_call'
                      };
                      if (recLog.lead_status_updated && statusToOutcome[recLog.lead_status_updated]) {
                        recoveryOutcome = statusToOutcome[recLog.lead_status_updated];
                      }
                    }
                  } catch (_) {}

                  // Append a diagnostic note with the REAL error reason so future occurrences are debuggable.
                  const diagNote = `\n[smartfloWebhook] Auto-recovered after processing error: ${recoveryReason || 'unknown'}.`;

                  await base44.entities.CampaignLead.update(campaignLead.id, {
                    status: 'completed',
                    outcome: recoveryOutcome,
                    call_status: recoveryCallStatus,
                    conversation_summary: (recoverySummary || '') + diagNote,
                    ...(recoveryTranscript ? { transcript: recoveryTranscript } : {}),
                    ...(recoveryDuration ? { call_duration: recoveryDuration } : {})
                  });
                  console.log(`[smartfloWebhook] 🛟 Recovered CampaignLead ${campaignLead.id} → completed (outcome=${recoveryOutcome}, reason=${recoveryReason || 'unknown'})`);
                } catch (recErr) {
                  console.error(`[smartfloWebhook] Recovery update failed: ${recErr.message}`);
                }
              }
            }
          }
        } else {
          console.log(`[smartfloWebhook] Not a campaign call — skipping campaign processing`);
        }
        
        // Invoke campaignPostCall for SLOW AI analysis (emails, scoring, sequences)
        // This runs async — next call is already triggered above
        try {
          base44.functions.invoke('campaignPostCall', {
            event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
            data: freshCallLog,
            old_data: { ...freshCallLog, status: callLog.status }
          }).catch(e => console.error(`[smartfloWebhook] campaignPostCall async failed: ${e.message}`));
        } catch (_) {}
        
      } catch (pcErr) {
        console.error(`[smartfloWebhook] Campaign processing failed: ${pcErr.message}`);
      }

      // 1.5 Save VoicemailMessage for personal accounts (from webhook data)
      if (freshCallLog.direction === 'inbound' && freshCallLog.client_id && freshCallLog.client_id !== 'unknown') {
        try {
          const callClient = await base44.entities.Client.get(freshCallLog.client_id);
          if (callClient && callClient.account_type === 'personal' && freshCallLog.conversation_summary) {
            const summaryLower = (freshCallLog.conversation_summary || '').toLowerCase();
            let category = 'unknown';
            if (summaryLower.includes('spam') || summaryLower.includes('telemarketing')) category = 'spam';
            else if (summaryLower.includes('promotional') || summaryLower.includes('offer')) category = 'promotional';
            else if (summaryLower.includes('family') || summaryLower.includes('friend')) category = 'family';
            else if (summaryLower.includes('business') || summaryLower.includes('meeting') || summaryLower.includes('work')) category = 'business';
            
            let urgency = 'medium';
            if (summaryLower.includes('urgent') || summaryLower.includes('emergency')) urgency = 'urgent';
            else if (category === 'spam' || category === 'promotional') urgency = 'low';

            // Check if voicemail already exists for this call
            const existingVMs = await base44.entities.VoicemailMessage.filter({ call_log_id: freshCallLog.id });
            if (existingVMs.length === 0) {
              // Resolve caller name for voicemail
              let vmCallerName = '';
              try { const cleanVm = (freshCallLog.caller_id || '').replace(/\D/g, '').slice(-10); if (cleanVm) { const tcVm = await base44.entities.TrustedContact.filter({ client_id: freshCallLog.client_id }); const mVm = tcVm.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === cleanVm); if (mVm?.name) vmCallerName = mVm.name; else { const ldVm = await base44.entities.Lead.filter({ client_id: freshCallLog.client_id }); const mlVm = ldVm.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === cleanVm); if (mlVm?.name) vmCallerName = mlVm.name; } } } catch (_) {}
              await base44.entities.VoicemailMessage.create({
                client_id: freshCallLog.client_id,
                call_log_id: freshCallLog.id,
                caller_number: freshCallLog.caller_id || '',
                caller_name: vmCallerName,
                message: freshCallLog.conversation_summary || 'No message captured',
                urgency,
                category,
                is_read: false
              });
              console.log(`[smartfloWebhook] 📨 VoicemailMessage saved for personal account: ${category}/${urgency}`);

              // Send post-call Telegram summary (non-blocking, direct)
              sendTelegramDirect(callClient, {
                caller_number: freshCallLog.caller_id || '',
                caller_name: vmCallerName,
                category,
                urgency,
                type: 'summary',
                summary: freshCallLog.conversation_summary || 'Call ended — no summary available.',
                recording_url: freshCallLog.recording_url || ''
              });
            }
          }
        } catch (vmErr) {
          console.log(`[smartfloWebhook] VoicemailMessage save skipped: ${vmErr.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // POST-CALL FAN-OUT (Phase 1): collapsed into ONE idempotent invoke.
      // postCallOrchestrator atomically claims the call via post_processed and
      // runs followup + action-extraction + CRM automation + inbound-lead
      // auto-create + recording fetch in a single controlled pipeline. This
      // replaces the previous 5 separate invokes (re-fired on every duplicate
      // Smartflo terminal webhook) — the single biggest 429 reducer on the hot
      // path. The orchestrator no-ops if already processed.
      // ═══════════════════════════════════════════════════════════════════
      base44.functions.invoke('postCallOrchestrator', { call_log_id: callLog.id })
        .then(r => console.log(`[smartfloWebhook] postCallOrchestrator:`, JSON.stringify(r?.data || {}).substring(0, 200)))
        .catch(e => console.error(`[smartfloWebhook] postCallOrchestrator failed: ${e.message}`));

      // 6. For screening calls: handle completion or failure
      if (freshCallLog.agent_config_cache?.is_screening_call) {
        const scId = freshCallLog.agent_config_cache.screening_call_id;
        const providerId = freshCallLog.agent_config_cache.provider_id;
        
        if (effectiveStatus === 'completed') {
          console.log(`[smartfloWebhook] 🔬 Screening call completed (ScreeningCall=${scId}) — triggering processScreeningResult`);
          // Wait 3s for streamAudio to finish saving transcript
          setTimeout(async () => {
            try {
              // Re-read to check if transcript arrived
              const latestLog = await base44.entities.CallLog.get(callLog.id);
              if (latestLog.transcript && latestLog.transcript.length >= 50) {
                const result = await base44.functions.invoke('processScreeningResult', {
                  screening_call_id: scId,
                  call_log_id: callLog.id
                });
                console.log(`[smartfloWebhook] ✅ processScreeningResult result:`, JSON.stringify(result?.data || {}).substring(0, 200));
              } else {
                // Completed but no transcript — mark as failed
                console.log(`[smartfloWebhook] ⚠️ Screening call completed but no transcript — marking as failed`);
                if (scId) await base44.entities.ScreeningCall.update(scId, { status: 'failed', ai_summary: 'Call connected but no conversation captured', result: 'inconclusive', call_duration: latestLog.duration || 0 });
                if (providerId) await base44.entities.ServiceProvider.update(providerId, { screening_status: 'not_screened', screening_summary: 'Call connected but no conversation captured' });
              }
            } catch (scrErr) {
              console.error(`[smartfloWebhook] ❌ processScreeningResult failed: ${scrErr.message}`);
            }
          }, 3000);
        } else if (effectiveStatus === 'no_answer' || effectiveStatus === 'failed') {
          // Screening call was not answered or failed — reset statuses
          const failReason = effectiveStatus === 'no_answer' ? 'Candidate did not answer the call' : 'Call failed to connect';
          console.log(`[smartfloWebhook] 📵 Screening call ${effectiveStatus} (ScreeningCall=${scId}) — marking as ${effectiveStatus}`);
          if (scId) {
            try {
              await base44.entities.ScreeningCall.update(scId, { status: effectiveStatus === 'no_answer' ? 'no_answer' : 'failed', ai_summary: failReason, result: 'inconclusive', call_duration: 0 });
            } catch (_) {}
          }
          if (providerId) {
            try {
              await base44.entities.ServiceProvider.update(providerId, { screening_status: 'not_screened', screening_summary: failReason });
            } catch (_) {}
          }
        }
      }

      // 7. For TRANSFERRED calls: fetch full Smartflo recording and re-analyze
      // Smartflo records the entire call (AI + human portions).
      // The WebSocket only captured the pre-transfer AI transcript.
      // This re-analyzes with the full recording to get the real outcome.
      if (freshCallLog.transferred_to && freshCallLog.recording_url) {
        console.log(`[smartfloWebhook] Transferred call detected with recording — triggering full recording analysis`);
        setTimeout(async () => {
          try {
            await base44.functions.invoke('processTransferRecording', {
              call_log_id: callLog.id
            });
            console.log(`[smartfloWebhook] processTransferRecording triggered for ${callLog.id}`);
          } catch (trErr) {
            console.error(`[smartfloWebhook] processTransferRecording failed: ${trErr.message}`);
          }
        }, 10000);
      } else if (freshCallLog.transferred_to && !freshCallLog.recording_url) {
        console.log(`[smartfloWebhook] Transferred call but no recording_url yet — recording may arrive in a later webhook`);
      }
    }

    return c.json({ data: { success: true, message: 'Webhook processed' } });

  } catch (error) {
    console.error('[smartfloWebhook] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};


// ═══════════════════════════════════════════════════════════════════
// INCREMENTAL COUNTER — bump Campaign display counters by +1 without
// re-scanning all leads (rate-limit-friendly: single read + single update).
//
// SAFETY:
//  - Best-effort only — failures swallowed, never breaks call flow.
//  - NEVER sets status='completed' (the poller's full recount owns completion).
//  - campaignPoller's 5-min full recount stays as the authoritative reconciler,
//    so any drift from a missed/duplicate bump self-heals within one cycle.
// ═══════════════════════════════════════════════════════════════════
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
    console.warn(`[smartfloWebhook] bumpCampaignCounter skipped: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// INLINE: Trigger next campaign call immediately after current completes.
// This avoids the delay of waiting for campaignPoller cron.
// ═══════════════════════════════════════════════════════════════════
async function triggerNextCampaignCall(base44, campaignId) {
  let cl = null; // hoisted so the catch block can access it for lead recovery
  try {
    const campaign = await base44.entities.Campaign.get(campaignId);
    if (!campaign || campaign.status !== 'running') {
      console.log(`[smartfloWebhook] Campaign ${campaignId} not running (${campaign?.status})`);
      return;
    }

    const now = new Date();
    const maxConcurrent = campaign.max_concurrent_calls || 5;

    // ─── PG-CANONICAL slot/lead state (replaces the Base44 per-status scans) ───
    // The dial state lives in Postgres now (shared with campaignPoller), so we read
    // free-slot counts + the next ready lead directly from PG. Zero Base44 in the
    // dial decision path → no 429, no race with the poller.
    const slotCounts = await pgGetCampaignSlotCounts(campaignId);
    if (slotCounts === null) {
      console.warn(`[smartfloWebhook] PG slot counts unavailable — deferring next-call to poller`);
      return;
    }
    const callingCount = slotCounts.in_flight;
    const readyCount = slotCounts.pending_ready;

    if (readyCount === 0 && callingCount === 0) {
      console.log(`[smartfloWebhook] Campaign "${campaign.name}" has no active leads — poller will finalize completion`);
      return;
    }

    const slotsAvailable = Math.max(0, maxConcurrent - callingCount);
    if (slotsAvailable === 0 || readyCount === 0) {
      console.log(`[smartfloWebhook] No slots (${callingCount}/${maxConcurrent}) or no ready leads (${readyCount})`);
      return;
    }

    // Get agent + DIDs
    const agent = await base44.entities.Agent.get(campaign.agent_id);
    const agentDIDs = (agent?.assigned_dids?.length > 0)
      ? agent.assigned_dids : (agent?.assigned_did ? [agent.assigned_did] : []);
    if (!agent || agentDIDs.length === 0) {
      console.log(`[smartfloWebhook] No agent/DIDs for campaign`);
      return;
    }

    // Knowledge base
    let kbContent = '';
    if (agent.knowledge_base_ids?.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.entities.KnowledgeBase.get(kbId);
          if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
        } catch (_) {}
      }
    }

    // ─── Pull the next ready lead from PG (canonical), then atomically claim ───
    const pgBatch = await pgGetPendingBatch(campaignId, 1);
    if (pgBatch === null) {
      console.warn(`[smartfloWebhook] PG pending batch unavailable — deferring to poller`);
      return;
    }
    if (pgBatch.length === 0) {
      console.log(`[smartfloWebhook] No ready pending leads in PG — poller will continue`);
      return;
    }
    cl = pgBatch[0];

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
    // Twilio path stays Base44-CallLog (twilioInitiateCall owns its CallLog), but
    // the CLAIM is still atomic in PG so we never race the poller.
    if (providerForLead === 'twilio') {
      const claimed = await pgClaimLead(cl.id);
      if (claimed === false) { console.log(`[smartfloWebhook] Lead ${cl.lead_name} already claimed — race avoided`); return; }
      if (claimed === null) { console.warn(`[smartfloWebhook] PG claim unavailable — deferring to poller`); return; }
      if (claimed === 'not_mirrored') {
        const fresh = await base44.entities.CampaignLead.get(cl.id).catch(() => null);
        if (!fresh || fresh.status !== 'pending') return;
      }
      try {
        const twRes = await base44.functions.invoke('twilioInitiateCall', {
          lead_id: cl.lead_id, agent_id: campaign.agent_id,
          phone_number: cl.lead_phone, service_call: true
        });
        const twData = twRes?.data || {};
        if (twData.success && twData.call_log_id) {
          pgAttachCallLog(cl.id, twData.call_log_id).catch(() => {});
          base44.entities.CampaignLead.update(cl.id, { call_log_id: twData.call_log_id }).catch(() => {});
          console.log(`[smartfloWebhook] ✅ Twilio next-call fired for ${cl.lead_name} (callLog=${twData.call_log_id})`);
        } else {
          pgFailLead(cl.id).catch(() => {});
        }
      } catch (twErr) {
        pgResetLeadPending(cl.id, true).catch(() => {});
        console.error(`[smartfloWebhook] Twilio invoke error: ${twErr.message}`);
      }
      return; // do not fall through to Smartflo
    }
    // ─── End Twilio branch — fall through to Smartflo for IN ───

    // Per-DID capacity-aware selection (counts from the atomic PG counter)
    const didRecords = await base44.entities.DID.filter({ client_id: campaign.client_id });
    const didCapMap = {};
    for (const n of agentDIDs) {
      const rec = didRecords.find((d) => d.number === n);
      didCapMap[n] = rec?.max_concurrent_calls || 1;
    }
    const norm10 = norm10Did;
    const activeMap = {};
    for (const n of agentDIDs) activeMap[norm10(n)] = 0;
    try {
      const pgActive = await pgGetActiveCounts(agentDIDs);
      for (const k of Object.keys(pgActive)) activeMap[k] = pgActive[k];
    } catch (e) {
      console.warn(`[smartfloWebhook] pgGetActiveCounts failed (${e.message}) — assuming 0 active`);
    }
    let selectedDID = null;
    let bestFree = 0;
    for (const n of agentDIDs) {
      const free = (didCapMap[n] || 1) - (activeMap[norm10(n)] || 0);
      if (free > bestFree) { selectedDID = n; bestFree = free; }
    }
    if (!selectedDID) {
      console.log(`[smartfloWebhook] All DIDs saturated — skipping next call trigger`);
      return;
    }

    // ─── ATOMIC PG CLAIM (shares one lock with campaignPoller — no race) ───
    const claimed = await pgClaimLead(cl.id);
    if (claimed === false) { console.log(`[smartfloWebhook] Lead ${cl.lead_name} already claimed — race avoided`); return; }
    if (claimed === null) { console.warn(`[smartfloWebhook] PG claim unavailable — deferring to poller`); return; }
    if (claimed === 'not_mirrored') {
      const fresh = await base44.entities.CampaignLead.get(cl.id).catch(() => null);
      if (!fresh || fresh.status !== 'pending') { console.log(`[smartfloWebhook] Lead ${cl.lead_name} not pending — skipping`); return; }
    }

    // ─── Normalize callee to valid Indian 10-digit subscriber number ───
    const digitsOnly = (cl.lead_phone || '').replace(/\D/g, '');
    const last10 = digitsOnly.slice(-10);
    if (last10.length !== 10 || !/^[6-9]\d{9}$/.test(last10)) {
      console.warn(`[smartfloWebhook] ✋ Invalid number for ${cl.lead_name} ("${cl.lead_phone}") — marking failed, no retry`);
      pgFailLead(cl.id).catch(() => {});
      return;
    }
    const cleanPhone = last10;
    const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const callLogId = genUuid();

    // Lead context from CampaignLead fields (no per-dial Base44 Lead.get — the
    // stream fetches full lead detail at connect via custom_identifier).
    const leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;

    const personalizedPrompt = [
      agent.system_prompt || '',
      campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
      campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
      campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
      campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
      `\n\n--- LEAD CONTEXT ---\n${leadContext}`
    ].filter(Boolean).join('\n');

    const configBlob = {
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
    };

    // ─── POSTGRES-PRIMARY: insert CallLog (config blob lives in PG, read by stream) ───
    await pgInsertCallLog({
      id: callLogId, client_id: campaign.client_id, agent_id: campaign.agent_id,
      lead_id: cl.lead_id, campaign_id: campaignId, call_sid: callSid,
      caller_id: selectedDID, callee_number: cleanPhone, status: 'initiated',
      agent_config_cache: configBlob
    });
    pgAttachCallLog(cl.id, callLogId).catch(() => {});

    // Smartflo API call
    let smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    if (campaignClient && (campaignClient.account_status === 'trial' || campaignClient.account_status === 'onboarding')) {
      smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
    }

    let cleanCallerID = selectedDID.replace(/[^0-9]/g, '');
    if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;

    const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: smartfloApiKey,
        customer_number: cleanPhone,
        caller_id: cleanCallerID,
        async: 1,
        custom_identifier: callLogId
      })
    });

    const smartfloData = await smartfloResp.json();
    if (smartfloResp.ok && smartfloData.success !== false) {
      const newCallSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id || callSid;
      pgUpdateCallLogStatus(callLogId, newCallSid, 'ringing').catch(() => {});
      pgIncrement(selectedDID, campaign.client_id, didCapMap[selectedDID] || 1)
        .catch((e) => console.error(`[smartfloWebhook] DID increment failed: ${e.message}`));
      console.log(`[smartfloWebhook] ✅ Next call initiated: ${cl.lead_name} → ${cleanPhone} (PG callLog=${callLogId})`);
    } else {
      pgUpdateCallLogStatus(callLogId, callSid, 'failed').catch(() => {});
      pgFailLead(cl.id).catch(() => {});
      console.error(`[smartfloWebhook] Next call failed: ${smartfloData.message}`);
    }
  } catch (err) {
    const msg = err?.message || '';
    // Reset the lead to pending in PG (canonical) on transient infra errors so the
    // poller retries it. 401 excluded — it's an auth/config error, not transient.
    const isTransient = /429|502|503|504|timeout|ETIMEDOUT|ECONNRESET|Just a moment/i.test(msg);
    if (isTransient && cl?.id) {
      console.warn(`[smartfloWebhook] Transient error in triggerNextCampaignCall (${msg.substring(0, 100)}) — resetting lead to pending`);
      pgResetLeadPending(cl.id, true).catch(() => {});
    } else {
      console.error(`[smartfloWebhook] triggerNextCampaignCall error: ${msg}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// INLINE: Send no-answer outreach (Email + WhatsApp) per campaign rules.
// Called when a campaign call ends as no_answer and rules require outreach.
// Mirrors the logic in campaignPostCall.sendNoAnswerOutreach.
// ═══════════════════════════════════════════════════════════════════
async function sendNoAnswerOutreachInline(base44, campaign, campaignLead, callLog) {
  const rules = campaign?.followup_rules || {};
  const sendEmail = !!rules.no_answer_send_email;
  const sendWA = !!rules.no_answer_send_whatsapp;
  if (!sendEmail && !sendWA) return false;

  const lead = campaignLead.lead_id
    ? await base44.entities.Lead.get(campaignLead.lead_id).catch(() => null)
    : null;
  if (!lead) {
    console.log(`[smartfloWebhook] No-answer outreach skipped — lead not found for CampaignLead ${campaignLead.id}`);
    return false;
  }

  let anySent = false;

  // ─── WhatsApp template ───
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
        console.log(`[smartfloWebhook] ✅ No-answer WhatsApp sent to ${lead.phone}`);
      } else {
        console.error(`[smartfloWebhook] No-answer WhatsApp failed: ${tData?.error || 'invoke failed'}`);
      }
    } catch (e) {
      console.error(`[smartfloWebhook] No-answer WhatsApp error: ${e.message}`);
    }
  }

  // ─── Email (delegated to campaignPostCall via flag) ───
  // For email, we let campaignPostCall handle it since it has the email + AI logic.
  // We just mark this so it won't double-send.
  if (anySent) {
    try {
      await base44.entities.CampaignLead.update(campaignLead.id, {
        followup_email_sent: true
      });
    } catch (_) {}
  }
  return anySent;
}