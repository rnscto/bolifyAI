import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";



// ─── Direct Postgres DID-concurrency helpers ───
// Reading the live per-DID active counts via svc.functions.invoke('pgDidConcurrency')
// was intermittently returning 403/429 under load, forcing the poller to "assume 0
// active" and dial blindly. We read/write the same did_concurrency table DIRECTLY
// here — sub-ms, no cross-function invoke, no auth gate, no rate-limit bucket.
const norm10 = (d) => String(d || '').replace(/\D/g, '').slice(-10);
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
// Batched active-count read for a list of DIDs → { <last10>: active_count }.
// ROBUSTNESS: a slot is only counted as "occupied" if the counter was
// incremented within the last STALE_SLOT_MIN minutes. A real call never lasts
// that long, so a counter that's been >0 with no fresh increment is leaked
// capacity (a lost post-call webhook never decremented it). Aging it out HERE
// — at the point pickDID() decides free slots — means a leaked slot is never
// even seen as occupied, so dialing resumes on the very next cycle instead of
// waiting for the sweeper. This is what guarantees no future "stuck" stall.
const STALE_SLOT_MIN = 3;
async function pgGetActiveCounts(didNumbers) {
  const dids = (didNumbers || []).map(norm10).filter(Boolean);
  const active = {};
  if (dids.length === 0) return active;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT
        did_number,
        -- Treat slots not incremented within the staleness window as freed.
        CASE
          WHEN last_increment_at < now() - (${STALE_SLOT_MIN} * INTERVAL '1 minute')
          THEN 0 ELSE active_count
        END AS active_count
      FROM did_concurrency
      WHERE did_number = ANY(${dids})`;
    for (const r of res.rows) active[r.did_number] = Number(r.active_count) || 0;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
  return active;
}
// Atomic +1 on dial-start (UPSERT).
async function pgIncrement(didNumber, clientId, maxConcurrent) {
  const did = norm10(didNumber);
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
            -- Keep the capacity in sync with the DID's current configured cap.
            -- Without this the row keeps a stale max_concurrent from when it was
            -- first created (e.g. 1), throttling DIDs later raised to 5.
            max_concurrent = ${maxConcurrent || 1},
            client_id = COALESCE(did_concurrency.client_id, EXCLUDED.client_id)`;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// ─── Direct Postgres campaign-lead counts (replaces svc.functions.invoke('pgCampaignLeadCounts')) ───
// The cross-function invoke was getting 403/429-throttled by the platform under
// load, forcing the poller onto the slow Base44 pagination path → rate-limit storm.
// Reading the campaign_leads mirror DIRECTLY here is sub-ms, no invoke, no auth
// gate, no rate-limit bucket — same proven pattern as pgGetActiveCounts above.
async function pgGetCampaignCounts(campaignId) {
  const pg = makePgClient();
  const nowIso = new Date().toISOString();
  try {
    ; /* pg.connect() not needed */
    const countRes = await pg.queryObject`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'calling')::int AS calling,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
        COUNT(*) FILTER (
          WHERE status = 'pending'
            AND (followup_call_date IS NULL OR followup_call_date <= ${nowIso}::timestamptz)
        )::int AS pending_ready,
        COUNT(*) FILTER (
          WHERE status = 'pending' AND followup_call_date > ${nowIso}::timestamptz
        )::int AS pending_retry_later
      FROM campaign_leads
      WHERE campaign_id = ${campaignId}`;
    const c = countRes.rows[0] || {};
    const outcomeRes = await pg.queryObject`
      SELECT outcome, COUNT(*)::int AS n
      FROM campaign_leads
      WHERE campaign_id = ${campaignId}
        AND status IN ('completed', 'failed') AND outcome IS NOT NULL
      GROUP BY outcome`;
    const outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
    for (const row of outcomeRes.rows) {
      if (outcomes[row.outcome] !== undefined) outcomes[row.outcome] = row.n;
    }
    return {
      counts: {
        pending: c.pending || 0, calling: c.calling || 0, processing: c.processing || 0,
        completed: c.completed || 0, failed: c.failed || 0, skipped: c.skipped || 0,
      },
      pending_ready: c.pending_ready || 0,
      pending_retry_later: c.pending_retry_later || 0,
      outcomes,
    };
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// ─── Option A: POSTGRES-FIRST DIAL WRITES (zero Base44 in the hot path) ───
// The Base44 entity-write rate limit cannot sustain high-volume dialing
// (12 campaigns × hundreds of dials/cycle → 429 storm → calls choke).
// So the dial loop now claims the lead + creates the CallLog DIRECTLY in
// Postgres (sub-ms, no rate limit). The Base44 mirror is fired async/
// best-effort purely for the dashboard UI. streamGeminiOutgoing reads the
// config blob from PG if the Base44 mirror lags. CallLog id is a UUID we
// generate locally so it's stable across PG + the async Base44 mirror.

// Atomic claim: pending → calling. Returns true only if THIS call won the row
// (race-safe — no CampaignLead.get re-read needed). Also bumps attempt_count.
// Returns: true = claimed, false = already claimed by someone else,
// 'not_mirrored' = row absent from PG (caller should use Base44 claim),
// null = PG unreachable.
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
    // 0 rows → either already claimed, or the row isn't mirrored. Disambiguate.
    const exists = await pg.queryObject`SELECT 1 FROM campaign_leads WHERE id = ${leadId} LIMIT 1`;
    return exists.rows.length > 0 ? false : 'not_mirrored';
  } catch (e) {
    console.warn(`[campaignPoller] pgClaimLead failed (${e.message})`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Insert the dial CallLog into Postgres (incl. the agent_config_cache blob that
// streamGeminiOutgoing reads at call-connect). callee stored as cleanPhone.
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

// Set call_sid + status on the PG CallLog after Smartflo responds.
// When callSid is falsy, only the status is updated (call_sid left intact).
async function pgUpdateCallLogStatus(id, callSid, status) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    if (callSid) {
      await pg.queryObject`
        UPDATE call_logs SET call_sid = ${callSid}, status = ${status}, updated_at = now()
        WHERE id = ${id}`;
    } else {
      await pg.queryObject`
        UPDATE call_logs SET status = ${status}, updated_at = now()
        WHERE id = ${id}`;
    }
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Reset a PG lead back to pending (used on dial failure / transient error).
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
      await pg.queryObject`
        UPDATE campaign_leads SET status = 'pending', call_log_id = NULL, updated_at = now()
        WHERE id = ${leadId}`;
    }
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Mark a PG lead failed/completed inline (dial-time hard failure).
async function pgFailLead(leadId, summary) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      UPDATE campaign_leads
        SET status = 'completed', outcome = 'not_answered', updated_at = now()
      WHERE id = ${leadId}`;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Fetch the next dial batch DIRECTLY from Postgres (canonical lead state).
// Reading the batch from Base44 was stale (PG already flipped leads to calling),
// causing wasted "already claimed" iterations + a redundant Base44 scan per cycle.
// Returns ready pending leads ordered oldest-first.
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
    console.warn(`[campaignPoller] pgGetPendingBatch failed (${e.message})`);
    return null; // null = PG unreachable → caller falls back to Base44 probe
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// ─── PG-side stuck-"calling" reconciler (Option A canonical state lives in PG) ───
// In the zero-Base44 dial path, leads are flipped pending→calling in Postgres.
// If a call never reports completion (webhook lost / stream crashed), the lead
// stays "calling" in PG forever → callingCount stays >= maxConcurrent → the
// campaign permanently "waiting for slots" and stops dialing. The Base44-based
// STEP-1 recovery can't fix it (Base44 mirror lags / says pending). This sweep
// resets PG leads stuck in "calling" past the timeout back to "pending" so the
// next cycle re-dials them. Returns the number reset.
async function pgSweepStuckCalling(campaignId, timeoutMs) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const cutoffIso = new Date(Date.now() - timeoutMs).toISOString();
    const res = await pg.queryObject`
      UPDATE campaign_leads
        SET status = 'pending', call_log_id = NULL, updated_at = now()
      WHERE campaign_id = ${campaignId}
        AND status = 'calling'
        AND updated_at < ${cutoffIso}::timestamptz
      RETURNING id`;
    return res.rows.length;
  } catch (e) {
    console.warn(`[campaignPoller] pgSweepStuckCalling failed (${e.message})`);
    return 0;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Sweep stale DID concurrency counters DIRECTLY in Postgres.
// did_concurrency.active_count is +1'd on dial-start and only -1'd by the
// post-call webhook. When a webhook is lost, active_count stays high forever →
// pickDID() sees free<=0 for every DID → "All DIDs saturated" → ZERO calls
// placed, permanently. A real call almost never exceeds ~10 min, so any counter
// that's been >0 with no increment for > staleMin is leaked capacity. Resetting
// it to 0 frees the DID so dialing resumes. Returns the list of swept DIDs.
async function pgSweepStaleDids(staleMin) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const cutoffIso = new Date(Date.now() - staleMin * 60 * 1000).toISOString();
    const res = await pg.queryObject`
      UPDATE did_concurrency
        SET active_count = 0, updated_at = now()
      WHERE active_count > 0
        AND last_increment_at < ${cutoffIso}::timestamptz
      RETURNING did_number`;
    return res.rows.map(r => r.did_number);
  } catch (e) {
    console.warn(`[campaignPoller] pgSweepStaleDids failed (${e.message})`);
    return [];
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Read a CallLog row from Postgres (stuck-lead recovery — call_log_id is now a PG id).
async function pgGetCallLog(callLogId) {
  if (!callLogId) return null;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT id, status, transcript, conversation_summary, duration, lead_id
      FROM call_logs WHERE id = ${callLogId} LIMIT 1`;
    return res.rows[0] || null;
  } catch (_) {
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Attach call_log_id to the PG lead (after CallLog insert).
async function pgAttachCallLog(leadId, callLogId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      UPDATE campaign_leads SET call_log_id = ${callLogId}, updated_at = now()
      WHERE id = ${leadId}`;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// UUID for locally-generated CallLog ids (stable across PG + Base44 mirror).
function genUuid() {
  try { return crypto.randomUUID(); }
  catch (_) { return 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12); }
}

// This function runs every 5 minutes to:
// 1. Fix stuck "calling" leads (calls that never got a webhook callback)
// 2. Automatically trigger next batch of calls for running campaigns
// 3. Auto-complete campaigns when all leads are processed
//
// Can be invoked by:
// - Base44 scheduled automation (internal)
// - External cron service (e.g. cron-job.org) via GET with ?cron_secret=<SMARTFLO_WEBHOOK_SECRET>
//   This eliminates dependency on Base44 integration credits for scheduling.

// Core poller work — runs the sweepers + dial loop. Returns the results object.
// opts.shardIndex / opts.shardCount enable horizontal sharding: the GET cron
// fans out into N parallel background invocations, each handling a disjoint
// subset of running campaigns (campaign index % shardCount === shardIndex).
// Only shard 0 runs the global housekeeping (sweeper + scheduled→running
// promotion) so it isn't duplicated across shards.
async function runPoller(client, opts = {}) {
    const svc = client.asServiceRole;
    const shardIndex = Number.isInteger(opts.shardIndex) ? opts.shardIndex : 0;
    const shardCount = Number.isInteger(opts.shardCount) && opts.shardCount > 0 ? opts.shardCount : 1;
    const isHousekeepingShard = shardIndex === 0;
    const results = { shard: `${shardIndex}/${shardCount}`, campaigns_processed: 0, stuck_fixed: 0, stale_calllogs_swept: 0, batches_triggered: 0, completed: 0, errors: [], trai_blocked: false };

    // ═══════════════════════════════════════════════════════════════════
    // TRAI COMPLIANCE — TIME WINDOW CHECK
    // Restricts outbound voice calls to 9:00 AM – 9:00 PM IST.
    // We allow stuck-lead recovery and stale-CallLog sweeping outside this window
    // (housekeeping that doesn't dial anyone), but block all new call initiations.
    // ═══════════════════════════════════════════════════════════════════
    const TRAI_START_HOUR = 9;  // 9:00 AM IST
    const TRAI_END_HOUR = 21;   // 9:00 PM IST (calls must START before 21:00)
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istHour = istNow.getHours();
    const isWithinTRAIWindow = istHour >= TRAI_START_HOUR && istHour < TRAI_END_HOUR;
    if (!isWithinTRAIWindow) {
      console.log(`[campaignPoller] ⏰ TRAI window check: BLOCKED (current IST hour=${istHour}, allowed=${TRAI_START_HOUR}-${TRAI_END_HOUR}). Will run sweepers but skip new call initiations.`);
      results.trai_blocked = true;
    } else {
      console.log(`[campaignPoller] ⏰ TRAI window check: OK (IST hour=${istHour})`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // STALE CALLLOG SWEEPER — prevents DID saturation permanently.
    //
    // Any CallLog stuck in an active status (initiated/ringing/answered)
    // for > STALE_THRESHOLD_MIN is force-closed. Otherwise they count
    // toward the agent's DID concurrency cap and block new calls.
    //
    // Causes of staleness:
    //   - Smartflo webhook never arrives (network failure)
    //   - streamAudio WebSocket crashes mid-call
    //   - Terminal webhook delivered but status update failed silently
    // ═══════════════════════════════════════════════════════════════════
    const STALE_INITIATED_MIN = 3;     // initiated but never rang = dead (lowered 5→3 to free DID slots faster)
    const STALE_RINGING_MIN = 3;       // ringing > 3min = Smartflo missed the terminal event / stream never connected
    const STALE_ANSWERED_MIN = 15;     // answered > 15min = WebSocket died
    const STALE_MAX_AGE_HOURS = 48;    // don't touch logs older than 2 days (historical, won't block new calls — only recent ones count toward DID cap)
    const SWEEP_CAP_PER_RUN = 60;      // cap writes per run (raised 25→60); 150ms delay keeps it rate-limit-safe
    const SWEEP_DELAY_MS = 150;        // serial with small delay
    const now = Date.now();

    if (isHousekeepingShard) try {
      // Serial (not parallel) reads to avoid a 3-way burst at poll start that
      // collides with live-call DB writes and trips the rate limit.
      const sweepRead = async (status) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            return await svc.entities.CallLog.filter({ status }, '-created_date', 100);
          } catch (e) {
            if (/429|rate limit/i.test(e.message || '') && attempt < 3) {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
              continue;
            }
            throw e;
          }
        }
        return [];
      };
      const initiatedLogs = await sweepRead('initiated');
      const ringingLogs = await sweepRead('ringing');
      const answeredLogs = await sweepRead('answered');

      const isStale = (log, thresholdMin) => {
        const ageMs = now - new Date(log.created_date).getTime();
        return ageMs > thresholdMin * 60 * 1000 && ageMs < STALE_MAX_AGE_HOURS * 3600 * 1000;
      };

      const sweepTargets = [
        ...initiatedLogs.filter(l => isStale(l, STALE_INITIATED_MIN)),
        ...ringingLogs.filter(l => isStale(l, STALE_RINGING_MIN)),
        ...answeredLogs.filter(l => isStale(l, STALE_ANSWERED_MIN)),
      ].slice(0, SWEEP_CAP_PER_RUN);

      for (const log of sweepTargets) {
        const ageMin = Math.round((now - new Date(log.created_date).getTime()) / 60000);
        try {
          await svc.entities.CallLog.update(log.id, {
            status: 'failed',
            call_end_time: new Date().toISOString(),
            conversation_summary: (log.conversation_summary || '') +
              `\n[Auto-sweep] CallLog was stuck in "${log.status}" for ${ageMin}min — force-closed to free DID slot.`
          });
          results.stale_calllogs_swept++;
          console.log(`[campaignPoller] 🧹 Swept stale CallLog ${log.id} (was ${log.status} for ${ageMin}min, agent=${log.agent_id}, DID=${log.caller_id})`);
        } catch (e) {
          console.error(`[campaignPoller] Failed to sweep CallLog ${log.id}: ${e.message}`);
          // On rate limit, stop sweeping to preserve capacity for campaign calls
          if (/429|rate limit/i.test(e.message)) {
            console.warn(`[campaignPoller] Hit rate limit — stopping sweep, resuming on next poll`);
            break;
          }
        }
        await new Promise(r => setTimeout(r, SWEEP_DELAY_MS));
      }
      if (results.stale_calllogs_swept > 0) {
        console.log(`[campaignPoller] 🧹 Total stale CallLogs swept this run: ${results.stale_calllogs_swept}`);
      }
    } catch (sweepErr) {
      console.error(`[campaignPoller] Stale sweeper error: ${sweepErr.message}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // STALE DID-CONCURRENCY SWEEPER (the actual "campaigns won't dial" fix)
    // did_concurrency.active_count is +1'd on dial-start and only -1'd by the
    // post-call webhook. Lost webhooks leak capacity → every DID shows
    // active>=max → pickDID() returns null → "All DIDs saturated" → 0 calls.
    // Reset any counter that's been >0 with no new increment for >10 min
    // (a real call never lasts that long) so dialing resumes. Runs every cycle
    // on the housekeeping shard — no reliance on a separate scheduled sweep.
    // ═══════════════════════════════════════════════════════════════════
    if (isHousekeepingShard) try {
      const sweptDids = await pgSweepStaleDids(3);
      if (sweptDids.length > 0) {
        console.log(`[campaignPoller] 🧹 Reset ${sweptDids.length} stale DID counter(s) → freed capacity: ${sweptDids.join(', ')}`);
      }
    } catch (didSweepErr) {
      console.error(`[campaignPoller] DID-concurrency sweep error: ${didSweepErr.message}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // SCHEDULED → RUNNING promotion
    // Any campaign in 'scheduled' state whose scheduled_date <= now is auto-promoted
    // to 'running' so the rest of the poller picks it up in the same cycle.
    // ═══════════════════════════════════════════════════════════════════
    if (isHousekeepingShard) try {
      const scheduledCampaigns = await svc.entities.Campaign.filter({ status: 'scheduled' });
      const nowMs = Date.now();
      let promoted = 0;
      for (const c of scheduledCampaigns) {
        if (!c.scheduled_date) continue; // safety — should not happen
        if (new Date(c.scheduled_date).getTime() <= nowMs) {
          await svc.entities.Campaign.update(c.id, {
            status: 'running',
            started_at: c.started_at || new Date().toISOString()
          });
          promoted++;
          console.log(`[campaignPoller] ⏰ Promoted scheduled campaign "${c.name}" → running (scheduled_date=${c.scheduled_date})`);
        }
      }
      if (promoted > 0) console.log(`[campaignPoller] Promoted ${promoted} scheduled campaigns this cycle`);
    } catch (schedErr) {
      console.error(`[campaignPoller] Schedule-promotion error: ${schedErr.message}`);
    }

    // Find all running campaigns, then keep only this shard's slice.
    // Stable ordering by id ensures every shard sees the same partition.
    const allRunning = await svc.entities.Campaign.filter({ status: 'running' });
    allRunning.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const runningCampaigns = shardCount > 1
      ? allRunning.filter((_, idx) => idx % shardCount === shardIndex)
      : allRunning;
    console.log(`[campaignPoller] Shard ${shardIndex}/${shardCount}: ${runningCampaigns.length} of ${allRunning.length} running campaigns`);

    // ═══════════════════════════════════════════════════════════════════
    // BATCHED STUCK-LEAD READS (support's "batch reads upfront")
    // Instead of 2 filter reads PER campaign for stuck calling/processing
    // leads (≈22 reads with 11 campaigns), do 2 global reads ONCE and group
    // in memory by campaign_id. Recovery logic per lead is unchanged — only
    // the SOURCE of the lead list changes. Scales flat regardless of campaign
    // count. Guarded by the same retry-on-429 backoff used everywhere here.
    // ═══════════════════════════════════════════════════════════════════
    const runningIds = new Set(runningCampaigns.map(c => c.id));
    const globalRead = async (status) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await svc.entities.CampaignLead.filter({ status }, 'created_date', 500);
        } catch (e) {
          if (/429|rate limit/i.test(e.message || '') && attempt < 3) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      return [];
    };
    const stuckCallingByCampaign = {};
    const stuckProcessingByCampaign = {};
    try {
      const allCalling = await globalRead('calling');
      await new Promise(r => setTimeout(r, 250)); // pace between startup reads to avoid a burst that trips 429
      const allProcessing = await globalRead('processing');
      for (const l of allCalling) {
        if (!runningIds.has(l.campaign_id)) continue;
        (stuckCallingByCampaign[l.campaign_id] ||= []).push(l);
      }
      for (const l of allProcessing) {
        if (!runningIds.has(l.campaign_id)) continue;
        (stuckProcessingByCampaign[l.campaign_id] ||= []).push(l);
      }
    } catch (e) {
      console.error(`[campaignPoller] Batched stuck-lead read failed (${e.message}) — per-campaign reads will be used as fallback`);
    }

    // Global 429 circuit-breaker: if we start getting rate-limited, stop the
    // loop instead of burning the budget failing every remaining campaign.
    // The next poll cycle (5 min) resumes where we left off.
    let rateLimitHits = 0;
    // Global per-run call cap: bound the total dials fired across ALL campaigns in
    // a single invocation so the write burst (CallLog.create + several updates per
    // dial) can never exceed the platform rate limit and time the function out.
    // Remaining work resumes on the next 5-min poll cycle.
    let callsFiredThisRun = 0;
    // Raised 20→80: with the cron GET now running in the background (no HTTP
    // timeout) and DID reads done inline (no 429), one cycle can fill every
    // campaign's free slots (~12 campaigns × 5 = 60) instead of stopping at 20.
    const MAX_CALLS_PER_RUN = 80;
    const pace = (ms) => new Promise(r => setTimeout(r, ms));

    // Rate-limit-safe read helper: retries any SDK read on 429 with backoff so a
    // transient burst doesn't bubble up as a campaign error / circuit-breaker trip.
    const safeRead = async (fn, fallback = []) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (/429|rate limit/i.test(e.message || '') && attempt < 4) {
            // Exponential-ish backoff (0.8s, 1.6s, 2.4s, 3.2s) so retries land
            // AFTER the per-second platform window clears, not on top of it.
            await pace(800 * (attempt + 1));
            continue;
          }
          throw e;
        }
      }
      return fallback;
    };

    // Rate-limit-safe WRITE helper — the per-lead loop fires CallLog.create +
    // several CampaignLead/CallLog updates; under load these were the bursts
    // that tripped the limit. Retrying with backoff keeps them from failing.
    const safeWrite = async (fn) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (/429|rate limit/i.test(e.message || '') && attempt < 4) {
            await pace(800 * (attempt + 1));
            continue;
          }
          throw e;
        }
      }
    };

    for (let _iter = 0; _iter < runningCampaigns.length; _iter++) {
      const campaign = runningCampaigns[_iter];
      // Inter-campaign pacing — now that the per-campaign count read is a direct
      // Postgres query (no Base44 cross-function invoke) and the per-dial Lead.get
      // is gone, the read burst is tiny. Lowered 1200→400ms so the serial loop
      // reaches ALL campaigns every cycle (late multi-DID campaigns were starving).
      if (_iter > 0) await pace(400);
      if (rateLimitHits >= 2) {
        console.warn(`[campaignPoller] ⛔ Circuit-breaker: ${rateLimitHits} rate-limit hits — stopping loop, resuming next cycle`);
        results.errors.push({ campaign: 'GLOBAL', error: 'Circuit-breaker tripped (rate limit) — remaining campaigns deferred to next poll' });
        break;
      }
      if (callsFiredThisRun >= MAX_CALLS_PER_RUN) {
        console.log(`[campaignPoller] 🛑 Reached per-run call cap (${MAX_CALLS_PER_RUN}) — deferring remaining campaigns to next cycle`);
        break;
      }
      try {
        results.campaigns_processed++;
        const campaignId = campaign.id;

        // === STEP 0 (PG-first): reconcile PG leads stuck in "calling" ===
        // The canonical lead state lives in Postgres now. If a webhook is lost,
        // a lead stays "calling" in PG forever and the campaign stops dialing
        // ("waiting for slots"). Reset PG leads stuck > 5 min back to pending so
        // they re-dial next cycle. This is what the Base44 STEP-1 recovery can't
        // do (the Base44 mirror lags / never flipped to calling).
        try {
          const pgReset = await pgSweepStuckCalling(campaignId, 5 * 60 * 1000);
          if (pgReset > 0) {
            results.stuck_fixed += pgReset;
            console.log(`[campaignPoller] 🔧 PG-reset ${pgReset} stuck "calling" leads → pending for "${campaign.name}"`);
          }
        } catch (e) {
          console.warn(`[campaignPoller] PG stuck-calling sweep error for "${campaign.name}": ${e.message}`);
        }

        // === STEP 1: Fix stuck "calling" and "processing" leads ===
        // Pull from the batched in-memory map (read once above). Falls back to a
        // per-campaign read only if the batched read failed for this campaign.
        const stuckCalling = stuckCallingByCampaign[campaignId]
          || await safeRead(() => svc.entities.CampaignLead.filter(
            { campaign_id: campaignId, status: 'calling' }, 'created_date', 100
          ));
        const stuckProcessing = stuckProcessingByCampaign[campaignId]
          || await safeRead(() => svc.entities.CampaignLead.filter(
            { campaign_id: campaignId, status: 'processing' }, 'created_date', 100
          ));
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
              // call_log_id is now a POSTGRES id (Option A zero-Base44 dial path).
              // Read from PG FIRST (canonical) — avoids the 404-log spam from
              // Base44 .get on a PG id. Only fall back to Base44 for legacy rows
              // where call_log_id is still a Base44 id.
              let callLog = await pgGetCallLog(cl.call_log_id);
              if (!callLog) callLog = await svc.entities.CallLog.get(cl.call_log_id).catch(() => null);
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
                  // call_log_id is a PG id (Option A) — update PG (canonical).
                  pgUpdateCallLogStatus(cl.call_log_id, callLog.call_sid || '', 'completed').catch(() => {});
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
                  // call_log_id is a PG id (Option A) — update PG (canonical).
                  pgUpdateCallLogStatus(cl.call_log_id, '', 'no_answer').catch(() => {});
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
        // CRITICAL: query by status separately (smaller result sets, no SDK 1000-cap truncation).
        // Previous bug: paginating ALL leads via offset hit the SDK's undocumented ~1000 record
        // ceiling — page.length < PAGE_SIZE triggered an early break, so leads beyond #1000 were
        // never counted → pendingReadyCount=0 → campaign falsely marked "completed".
        // Rate-limit-resilient pagination: retry pages on 429 with backoff and
        // pace between pages. On large campaigns (900+ leads) running this for
        // every campaign every 5 min previously exhausted the Base44 SDK rate
        // limit and crashed the poller — leaving leads stuck in "calling".
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const fetchAllByStatus = async (statusValue) => {
          const out = [];
          const PAGE_SIZE = 200;
          let pageIdx = 0;
          while (true) {
            let page = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                page = await svc.entities.CampaignLead.filter(
                  { campaign_id: campaignId, status: statusValue }, 'created_date', PAGE_SIZE, pageIdx * PAGE_SIZE
                );
                break;
              } catch (e) {
                if (/429|rate limit/i.test(e.message) && attempt < 2) {
                  await sleep(400 * (attempt + 1));
                  continue;
                }
                throw e;
              }
            }
            if (!page || page.length === 0) break;
            out.push(...page);
            pageIdx++;
            if (pageIdx > 250) { // safety cap: 50k per status
              console.warn(`[campaignPoller] Status "${statusValue}" exceeded 50k — stopping pagination`);
              break;
            }
            await sleep(120); // gentle pacing between pages
          }
          return out;
        };

        // ═══════════════════════════════════════════════════════════════════
        // RATE-LIMIT GUARD: only do the FULL 5-status scan when the campaign
        // might be finished. While there's still pending/calling work, the exact
        // completed/failed counts don't change any decision — so we skip the
        // expensive pagination entirely and go straight to triggering the next
        // batch. This is the single biggest 429 reducer: with 11 live campaigns
        // every 5 min, the old code paginated 5 full status scans PER campaign,
        // colliding with live-call DB reads.
        const now = new Date();
        const PROBE = 200;

        // ── SQL-FIRST progress check (Postgres campaign_leads mirror) ──
        // ONE SQL call returns all status counts + ready/retry split, replacing
        // the 3 per-campaign head-page probes AND the multi-page completed/failed
        // scan that were the dominant per-cycle 429 source. The dial BATCH still
        // comes from a small Base44 head page (pendingProbe) so the loop's fresh
        // per-lead re-reads stay authoritative. Falls back to Base44 probes if
        // the SQL mirror is unreachable.
        let pendingReadyCount, pendingRetryLaterCount, callingCount, pendingPageFull;
        let pgCounts = null;
        try {
          // Direct Postgres read — no cross-function invoke (avoids 403/429 throttling).
          pgCounts = await pgGetCampaignCounts(campaignId);
        } catch (e) {
          console.warn(`[campaignPoller] pgGetCampaignCounts failed (${e.message}) — using Base44 probes`);
        }

        // Small Base44 head page — needed for the actual dial batch below.
        const pendingProbe = await safeRead(() => svc.entities.CampaignLead.filter(
          { campaign_id: campaignId, status: 'pending' }, 'created_date', PROBE
        ), []);

        if (pgCounts) {
          pendingReadyCount = pgCounts.pending_ready || 0;
          pendingRetryLaterCount = pgCounts.pending_retry_later || 0;
          callingCount = (pgCounts.counts.calling || 0) + (pgCounts.counts.processing || 0);
          pendingPageFull = false; // SQL gives exact counts — no head-page heuristic needed
        } else {
          pendingReadyCount = pendingProbe.filter(l => !l.followup_call_date || new Date(l.followup_call_date) <= now).length;
          pendingRetryLaterCount = pendingProbe.filter(l => l.followup_call_date && new Date(l.followup_call_date) > now).length;
          const callingProbe = await safeRead(() => svc.entities.CampaignLead.filter({ campaign_id: campaignId, status: 'calling' }, 'created_date', PROBE), []);
          const processingProbe = await safeRead(() => svc.entities.CampaignLead.filter({ campaign_id: campaignId, status: 'processing' }, 'created_date', PROBE), []);
          callingCount = callingProbe.length + processingProbe.length;
          pendingPageFull = pendingProbe.length >= PROBE;
        }
        const pendingCount = pendingReadyCount + pendingRetryLaterCount;

        const stillHasWork = pendingPageFull || pendingReadyCount > 0 || callingCount > 0 || pendingRetryLaterCount > 0;

        // When the campaign LOOKS done, refresh final stats from SQL (or fall back
        // to the paginated Base44 scan) before flipping to completed.
        if (!stillHasWork) {
          let completedCount, failedCount, outcomes;
          if (pgCounts) {
            completedCount = pgCounts.counts.completed || 0;
            failedCount = pgCounts.counts.failed || 0;
            outcomes = pgCounts.outcomes;
          } else {
            const completedLeadsAll = await fetchAllByStatus('completed');
            const failedLeadsAll = await fetchAllByStatus('failed');
            completedCount = completedLeadsAll.length;
            failedCount = failedLeadsAll.length;
            outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
            [...completedLeadsAll, ...failedLeadsAll].forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
          }
          await svc.entities.Campaign.update(campaignId, {
            calls_completed: completedCount, calls_failed: failedCount, outcomes_summary: outcomes
          });
          console.log(`[campaignPoller] "${campaign.name}" appears done — completed=${completedCount}, failed=${failedCount}`);
        } else {
          console.log(`[campaignPoller] "${campaign.name}": pendingReady=${pendingReadyCount}, retryLater=${pendingRetryLaterCount}, calling=${callingCount} — skipping full stat scan (still active)`);
        }

        // SAFETY GUARD: never auto-complete while the Postgres mirror still
        // reports ANY pending leads (ready OR retry-later) or in-flight calls.
        // Prevents the early-completion bug where a head-page probe under-counted
        // ready leads (or a transient break exited the dial loop) and the
        // campaign flipped to "completed" with thousands of uncalled leads.
        const mirrorPending = pgCounts
          ? ((pgCounts.counts.pending || 0) + (pgCounts.counts.calling || 0) + (pgCounts.counts.processing || 0))
          : null;
        const safeToComplete =
          !pendingPageFull &&
          pendingReadyCount === 0 &&
          callingCount === 0 &&
          pendingRetryLaterCount === 0 &&
          (mirrorPending === null || mirrorPending === 0);

        if (!safeToComplete && mirrorPending > 0 && pgCounts) {
          console.warn(`[campaignPoller] ⚠️ "${campaign.name}" NOT completing — mirror still shows ${mirrorPending} pending/in-flight leads (probe said ready=0). Will re-dial next cycle.`);
        }

        if (safeToComplete) {
          await svc.entities.Campaign.update(campaignId, {
            status: 'completed', completed_at: new Date().toISOString()
          });
          // NOTE: completedCount/failedCount are only computed inside the
          // `if (!stillHasWork)` stat-scan block above. They may be undefined
          // here (when the campaign finishes via this branch without that scan),
          // so we log defensively to avoid a ReferenceError that previously left
          // campaigns stuck in "running".
          console.log(`[campaignPoller] Campaign "${campaign.name}" completed`);
          results.completed++;
          continue;
        }

        if (pendingRetryLaterCount > 0 && pendingReadyCount === 0 && callingCount === 0) {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingRetryLaterCount} leads waiting for retry later. Skipping.`);
          continue;
        }

        // === STEP 3: Trigger next batch INLINE (no cross-function invoke) ===
        // TRAI gate: skip new call initiations outside 10 AM – 9 PM IST
        if (!isWithinTRAIWindow) {
          console.log(`[campaignPoller] Campaign "${campaign.name}": skipping batch — outside TRAI 9AM-9PM IST window`);
          continue;
        }
        const maxConcurrent = campaign.max_concurrent_calls || 5;
        if (pendingReadyCount > 0 && callingCount < maxConcurrent) {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingCount} pending, ${callingCount} calling — triggering next batch`);
          try {
            let agent = null;
            try {
              agent = await safeRead(() => svc.entities.Agent.get(campaign.agent_id), null);
            } catch (agentErr) {
              // Agent record was deleted — pause campaign so user can reassign
              const note = `Campaign auto-paused: agent (id=${campaign.agent_id}) no longer exists. Reassign an agent and resume the campaign.`;
              console.warn(`[campaignPoller] ⏸️ Pausing "${campaign.name}" — ${note}`);
              await svc.entities.Campaign.update(campaignId, {
                status: 'paused',
                notes: ((campaign.notes || '') + `\n[${new Date().toISOString()}] ${note}`).trim()
              });
              continue;
            }
            const agentDIDs = (agent?.assigned_dids?.length > 0)
              ? agent.assigned_dids
              : (agent?.assigned_did ? [agent.assigned_did] : []);

            if (!agent || agentDIDs.length === 0) {
              // Agent exists but has no DIDs — pause campaign so user can assign one
              const note = `Campaign auto-paused: agent "${agent?.name || campaign.agent_id}" has no DIDs assigned. Assign a DID to the agent and resume the campaign.`;
              console.warn(`[campaignPoller] ⏸️ Pausing "${campaign.name}" — ${note}`);
              await svc.entities.Campaign.update(campaignId, {
                status: 'paused',
                notes: ((campaign.notes || '') + `\n[${new Date().toISOString()}] ${note}`).trim()
              });
              continue;
            }

            let kbContent = '';
            if (agent.knowledge_base_ids?.length > 0) {
              for (const kbId of agent.knowledge_base_ids) {
                try {
                  const doc = await svc.entities.KnowledgeBase.get(kbId);
                  if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
                } catch (_) {}
              }
            }

            // Cap this campaign's batch to BOTH its free slots AND the run-wide
            // remaining call budget, so no single poller invocation over-dials.
            const runBudget = Math.max(0, MAX_CALLS_PER_RUN - callsFiredThisRun);
            const slotsAvailable = Math.min(Math.max(0, maxConcurrent - callingCount), runBudget);
            let successfulCalls = 0;
            // Pull the dial batch from POSTGRES (canonical state) so we never try
            // to claim leads PG already flipped to calling (eliminates the
            // "already claimed" wasted iterations + a stale Base44 read). Falls
            // back to the Base44 pendingProbe only if PG is unreachable.
            const pgBatch = slotsAvailable > 0 ? await pgGetPendingBatch(campaignId, slotsAvailable) : [];
            const pendingBatch = pgBatch !== null
              ? pgBatch
              : pendingProbe.filter(l =>
                  !l.followup_call_date || new Date(l.followup_call_date) <= now
                ).slice(0, slotsAvailable);

            // Load per-DID concurrency caps + current active outbound count per DID
            const didRecords = await safeRead(() => svc.entities.DID.filter({ client_id: campaign.client_id }));
            const didCapMap = {};
            for (const n of agentDIDs) {
              const rec = didRecords.find((d) => d.number === n);
              didCapMap[n] = rec?.max_concurrent_calls || 1;
            }
            // Per-DID active counts read DIRECTLY from Postgres (no cross-function
            // invoke → no 403/429). Keyed by last-10 digits.
            const activeMap = {};
            for (const n of agentDIDs) activeMap[norm10(n)] = 0;
            try {
              const pgActive = await pgGetActiveCounts(agentDIDs);
              for (const k of Object.keys(pgActive)) activeMap[k] = pgActive[k];
            } catch (e) {
              console.warn(`[campaignPoller] pgGetActiveCounts failed (${e.message}) — assuming 0 active`);
            }
            // Round-robin across the agent's DIDs. Among DIDs that still have a
            // free slot, pick the LEAST-loaded one (fewest active calls). On ties
            // (e.g. all idle), advance a rotating cursor so successive dials in the
            // same batch spread evenly across every DID instead of always hitting
            // the first one. This is what gives multi-DID agents true round-robin.
            let rrCursor = 0;
            const pickDID = () => {
              const available = agentDIDs.filter(
                (n) => (didCapMap[n] || 1) - (activeMap[norm10(n)] || 0) > 0
              );
              if (available.length === 0) return null;
              // Lowest active count wins; the rotating cursor breaks ties fairly.
              let best = null;
              let bestActive = Infinity;
              for (let k = 0; k < available.length; k++) {
                const n = available[(rrCursor + k) % available.length];
                const active = activeMap[norm10(n)] || 0;
                if (active < bestActive) { best = n; bestActive = active; }
              }
              rrCursor = (rrCursor + 1) % available.length;
              return best;
            };

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
            const resolveCampaignProvider = (a, phone, c) => {
              const pref = String(a?.calling_provider || 'auto').toLowerCase();
              if (pref === 'smartflo' || pref === 'twilio') return pref;
              const region = String(c?.region || '').toUpperCase();
              if (region === 'US' || region === 'UK') return 'twilio';
              return detectCountryFromPhone(phone) === 'IN' ? 'smartflo' : 'twilio';
            };
            const campaignClient = await safeRead(() => svc.entities.Client.get(campaign.client_id), null);

            for (let i = 0; i < pendingBatch.length; i++) {
              const cl = pendingBatch[i];
              try {
                // ─── TWILIO BRANCH (international) ───
                const providerForLead = resolveCampaignProvider(agent, cl.lead_phone, campaignClient);
                if (providerForLead === 'twilio') {
                  // GUARD: for an India-region client, a "+1" + 10-digit number is
                  // almost always a misformatted Indian number (e.g. "19793030579"
                  // = stray leading 1 + a 10-digit Indian mobile). Twilio rejects
                  // it as an invalid US number and the lead retries forever. If the
                  // last-10 digits look like a valid Indian mobile, the number is
                  // un-dialable as US → permanently FAIL it in PG (no retry).
                  const twDigits = (cl.lead_phone || '').replace(/\D/g, '');
                  const twLast10 = twDigits.slice(-10);
                  const clientIsIN = String(campaignClient?.region || 'IN').toUpperCase() === 'IN';
                  const looksMisformattedIndian =
                    clientIsIN &&
                    twDigits.startsWith('1') &&
                    twDigits.length === 11 &&
                    /^[6-9]\d{9}$/.test(twLast10);
                  if (looksMisformattedIndian) {
                    console.warn(`[campaignPoller] ✋ Misformatted Indian number routed to Twilio for ${cl.lead_name} ("${cl.lead_phone}") — marking failed, no retry`);
                    // Canonical fail in PG so the poller never re-dials it.
                    await pgFailLead(cl.id, `Invalid number "${cl.lead_phone}" (misformatted Indian number). Fix the lead's phone and re-add it.`).catch(() => {});
                    svc.entities.CampaignLead.update(cl.id, {
                      status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
                      conversation_summary: `Invalid number "${cl.lead_phone}" — looks like a misformatted Indian number. Remove the leading "1" and re-add the lead.`
                    }).catch(() => {});
                    if (i < pendingBatch.length - 1) await new Promise(r => setTimeout(r, 200));
                    continue;
                  }
                  await svc.entities.CampaignLead.update(cl.id, {
                    status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
                  });
                  try {
                    const twRes = await svc.functions.invoke('twilioInitiateCall', {
                      lead_id: cl.lead_id, agent_id: campaign.agent_id,
                      phone_number: cl.lead_phone, service_call: true
                    });
                    const twData = twRes?.data || {};
                    if (twData.success && twData.call_log_id) {
                      await svc.entities.CampaignLead.update(cl.id, { call_log_id: twData.call_log_id });
                      successfulCalls++; callsFiredThisRun++;
                      console.log(`[campaignPoller] ✅ Twilio call fired for ${cl.lead_name} (callLog=${twData.call_log_id})`);
                    } else {
                      // Twilio hard-rejected the number → terminal fail. Write to PG
                      // (canonical) so the lead is NOT re-dialed next cycle, then
                      // mirror to Base44 for the dashboard.
                      await pgFailLead(cl.id, `Twilio error: ${twData.error || 'unknown'}`).catch(() => {});
                      svc.entities.CampaignLead.update(cl.id, {
                        status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
                        conversation_summary: `Twilio error: ${twData.error || 'unknown'}`
                      }).catch(() => {});
                    }
                  } catch (twErr) {
                    await pgFailLead(cl.id, `Twilio invoke error: ${twErr.message}`).catch(() => {});
                    svc.entities.CampaignLead.update(cl.id, {
                      status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
                      conversation_summary: `Twilio invoke error: ${twErr.message}`
                    }).catch(() => {});
                  }
                  if (i < pendingBatch.length - 1) await new Promise(r => setTimeout(r, 500));
                  continue; // skip Smartflo block for this lead
                }
                // ─── End Twilio branch — fall through to Smartflo for IN ───

                const selectedDID = pickDID();
                if (!selectedDID) {
                  console.log(`[campaignPoller] All DIDs saturated for "${campaign.name}" — pausing batch`);
                  break;
                }

                // ─── POSTGRES-FIRST: atomic claim (race-safe, no Base44) ───
                // Replaces both the CampaignLead.get re-read AND the 'calling' write.
                // Returns true only if THIS run flipped pending→calling. null = PG
                // unreachable → skip this lead (next cycle retries) rather than risk
                // a Base44 race / 429.
                const claimed = await pgClaimLead(cl.id);
                if (claimed === false) {
                  console.log(`[campaignPoller] Lead ${cl.lead_name} already claimed (race avoided) — skipping`);
                  continue;
                }
                if (claimed === null) {
                  console.warn(`[campaignPoller] PG claim unavailable for ${cl.lead_name} — deferring to next cycle`);
                  continue;
                }
                if (claimed === 'not_mirrored') {
                  // Lead not yet in the PG mirror — claim via Base44 (re-read guard),
                  // then upsert into PG so the fast path works next time.
                  const freshLead = await safeRead(() => svc.entities.CampaignLead.get(cl.id), null);
                  if (!freshLead || freshLead.status !== 'pending') {
                    console.log(`[campaignPoller] Lead ${cl.lead_name} not pending (Base44 claim) — skipping`);
                    continue;
                  }
                  // Best-effort upsert into PG so it's claimable next cycle.
                  svc.functions.invoke('pgCampaignLeadSync', { campaign_lead: { ...freshLead, status: 'calling' } }).catch(() => {});
                }

                activeMap[norm10(selectedDID)] = (activeMap[norm10(selectedDID)] || 0) + 1;

                // ─── Normalize callee to valid Indian E.164 (last-10 + 91) ───
                // Imported leads sometimes carry junk-prefixed numbers (e.g.
                // "9109960613131" = 91 + 09960613131). Smartflo rejects these →
                // the call fails and the lead retries forever. Take the last 10
                // digits as the real subscriber number; if that's not exactly 10
                // digits, the number is unrecoverable — permanently fail the lead
                // (do NOT keep retrying an un-dialable number).
                const digitsOnly = (cl.lead_phone || '').replace(/\D/g, '');
                const last10 = digitsOnly.slice(-10);
                if (last10.length !== 10 || !/^[6-9]\d{9}$/.test(last10)) {
                  console.warn(`[campaignPoller] ✋ Invalid number for ${cl.lead_name} ("${cl.lead_phone}") — marking failed, no retry`);
                  pgFailLead(cl.id, `Invalid phone number "${cl.lead_phone}" — cannot dial.`).catch(() => {});
                  pgUpdateCallLogStatus(genUuid(), '', 'failed').catch(() => {});
                  // release the slot we reserved on this DID
                  activeMap[norm10(selectedDID)] = Math.max(0, (activeMap[norm10(selectedDID)] || 1) - 1);
                  continue;
                }
                const cleanPhone = last10; // Smartflo customer_number = 10-digit subscriber number
                const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                const callLogId = genUuid();

                // Lead context built from CampaignLead fields already in memory —
                // NO per-dial Base44 Lead.get read (that was the biggest hot-path
                // read, multiplying DB load per call and slowing the serial loop so
                // late campaigns barely got serviced). streamGeminiOutgoing fetches
                // full lead detail at call-connect time anyway via custom_identifier.
                const leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;

                const personalizedPrompt = [
                  agent.system_prompt || '',
                  campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
                  campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
                  campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
                  campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
                  leadContext ? `\n\n--- LEAD CONTEXT ---\n${leadContext}` : ''
                ].filter(Boolean).join('\n');

                // Build the agent config blob ONCE — used for both PG (primary) and
                // the async Base44 mirror.
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

                // ─── POSTGRES-PRIMARY: insert CallLog (incl. config blob) ───
                // This is the ONLY write the live call path depends on. No Base44
                // write blocks the dial, so the platform rate limit can NEVER again
                // stop campaign calls. streamGeminiOutgoing reads this blob from PG.
                await pgInsertCallLog({
                  id: callLogId, client_id: campaign.client_id, agent_id: campaign.agent_id,
                  lead_id: cl.lead_id, campaign_id: campaignId, call_sid: callSid,
                  caller_id: selectedDID, callee_number: cleanPhone, status: 'initiated',
                  agent_config_cache: configBlob
                });
                // Attach call_log_id to the PG lead (best-effort).
                pgAttachCallLog(cl.id, callLogId).catch(() => {});

                // ─── NO per-dial Base44 mirror (was the 429 source) ───
                // The canonical lead/call state lives in POSTGRES now: the live call
                // path (streamGeminiOutgoing), smartfloWebhook, and progress counts
                // all read PG. Creating a Base44 CallLog + CampaignLead.update PER DIAL
                // (hundreds/cycle across 12 campaigns) was tripping the platform rate
                // limit and choking dialing. The PG insert above + pgAttachCallLog are
                // the authoritative writes. Dashboards read from the PG mirror
                // (pgDashboardCounts / pgAnalytics). The CampaignLead was already
                // flipped to "calling" by pgClaimLead in PG.

                // Use agent's own API token (falls back to global key for demo agents)
                let smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
                const isDemoAgent = campaignClient && (campaignClient.account_status === 'trial' || campaignClient.account_status === 'onboarding');
                if (isDemoAgent) smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');

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
                    // O(1) call resolution: pack our CallLog id so streamGeminiOutgoing
                    // resolves the config directly from PG (no fragile phone-scan).
                    custom_identifier: callLogId
                  })
                });

                const smartfloData = await smartfloResp.json();
                if (smartfloResp.ok && smartfloData.success !== false) {
                  const newCallSid = smartfloData.call_id || smartfloData.ref_id || smartfloData.call_sid || callSid;
                  // PG status update (primary). No Base44 update here — the mirror row
                  // gets its own id and the webhook updates it; forcing it 404'd before.
                  pgUpdateCallLogStatus(callLogId, newCallSid, 'ringing').catch(() => {});
                  // Increment Postgres DID counter inline (campaign calls bypass initiateCall).
                  pgIncrement(selectedDID, campaign.client_id, didCapMap[selectedDID] || 1)
                    .catch((e) => console.error(`[campaignPoller] DID increment failed: ${e.message}`));
                  successfulCalls++; callsFiredThisRun++;
                  console.log(`[campaignPoller] Call initiated: ${cl.lead_name} → ${cleanPhone} (PG callLog=${callLogId})`);
                } else {
                  // Hard Smartflo failure — fail the lead in PG (canonical). No Base44
                  // write here (it was a 429 source); the PG mirror is authoritative.
                  pgUpdateCallLogStatus(callLogId, callSid, 'failed').catch(() => {});
                  pgFailLead(cl.id, `Smartflo error: ${smartfloData.message || 'Unknown'}`).catch(() => {});
                }

                if (i < pendingBatch.length - 1) await new Promise(r => setTimeout(r, 300));
              } catch (e) {
                const msg = e?.message || '';
                // Detect transient Base44/Cloudflare errors that should NOT burn the lead.
                // Reset to pending so the next poll retries it, instead of marking completed.
                const isTransient = /429|401|502|503|504|timeout|ETIMEDOUT|ECONNRESET|Just a moment/i.test(msg);
                if (isTransient) {
                  console.warn(`[campaignPoller] Transient error for ${cl.lead_name} (${msg.substring(0, 100)}) — resetting to pending for retry`);
                  // Reset in PG (canonical, claim lives there). No Base44 write (429 source).
                  pgResetLeadPending(cl.id, true).catch(() => {});
                  // On a rate-limit specifically: trip the circuit-breaker and STOP
                  // dialing this batch immediately. Continuing only deepens the 429
                  // storm and risks the 180s timeout. Remaining leads resume next cycle.
                  if (/429|rate limit/i.test(msg)) {
                    rateLimitHits++;
                    console.warn(`[campaignPoller] ⛔ Rate-limit during dial — aborting batch (hit ${rateLimitHits})`);
                    break;
                  }
                } else {
                  console.error(`[campaignPoller] Call error for ${cl.lead_name}: ${msg}`);
                  // Fail in PG (canonical). No Base44 write.
                  pgFailLead(cl.id, `Error: ${msg}`).catch(() => {});
                }
              }
            }

            results.batches_triggered++;
            console.log(`[campaignPoller] Triggered ${successfulCalls}/${pendingBatch.length} calls for "${campaign.name}"`);
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
        // Count rate-limit errors toward the circuit-breaker so we bail out
        // early instead of failing every remaining campaign.
        if (/429|rate limit/i.test(e.message || '')) {
          rateLimitHits++;
          await pace(1500); // back off before the next campaign
        }
      }
    }

    return results;
}

export default async function campaignPoller(c: any) {
  const req = c.req.raw || c.req;
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
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
      console.log('[campaignPoller] Triggered by external cron — sharding into parallel background runs, returning 202 immediately');

      const client = base44;;

      // ── Decide shard count from live campaign volume ──
      // One shard per ~10 running campaigns so each shard's serial dial loop
      // stays well under the function time limit. Caps at 8 shards to keep the
      // aggregate Base44 write rate within the platform limit. Override via
      // ?shards=N for manual tuning.
      let shardCount = 1;
      try {
        const forced = parseInt(url.searchParams.get('shards') || '', 10);
        if (Number.isInteger(forced) && forced >= 1 && forced <= 16) {
          shardCount = forced;
        } else {
          const running = await client.asServiceRole.entities.Campaign.filter({ status: 'running' });
          shardCount = Math.min(8, Math.max(1, Math.ceil(running.length / 10)));
        }
      } catch (e) {
        console.warn(`[campaignPoller] Shard-count probe failed (${e.message}) — defaulting to 1 shard`);
      }

      // CRITICAL: each shard does serial, deliberately-paced work that can exceed
      // a cron HTTP timeout. Respond 202 IMMEDIATELY and run every shard in
      // parallel in the background so the cron never sees a timeout. Shard 0 also
      // does the global housekeeping (sweeper + scheduled-promotion).
      const tasks = [];
      for (let s = 0; s < shardCount; s++) {
        tasks.push(
          runPoller(client, { shardIndex: s, shardCount })
            .then((r) => console.log(`[campaignPoller] Shard ${s}/${shardCount} finished:`, JSON.stringify(r)))
            .catch((e) => console.error(`[campaignPoller] Shard ${s}/${shardCount} error:`, e.message))
        );
      }
      const bgTask = Promise.all(tasks);
      try { EdgeRuntime.waitUntil(bgTask); } catch (_) { /* waitUntil unavailable — tasks still run */ }

      return c.json({ data: { success: true, accepted: true, shards: shardCount, message: `Poller started in ${shardCount} parallel shard(s)` } }, 202);
    }

    // Internal / POST invocation — run synchronously and return full results.
    const client = base44;;
    const results = await runPoller(client);
    return c.json({ data: { success: true, ...results } });
  } catch (error) {
    console.error('[campaignPoller] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};