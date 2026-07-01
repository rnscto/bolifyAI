import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { Client as PgClient } from "jsr:@db/postgres@0.19.4";



// ═══════════════════════════════════════════════════════════════════
// POSTGRES-PRIMARY DIAL PRIMITIVES (identical to campaignPoller's path).
// The Start-button batch claims + dials through THESE so it shares ONE atomic
// lock with campaignPoller + smartfloWebhook — no Base44 race, zero Base44 in
// the dial hot path. CallLog lives in PG only (read by streamGeminiOutgoing).
// ═══════════════════════════════════════════════════════════════════
const _norm10 = (d) => String(d || '').replace(/\D/g, '').slice(-10);
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
function genUuid() {
  try { return crypto.randomUUID(); }
  catch (_) { return 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12); }
}
async function pgGetActiveCounts(didNumbers) {
  const dids = (didNumbers || []).map(_norm10).filter(Boolean);
  const active = {};
  if (dids.length === 0) return active;
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT did_number, active_count FROM did_concurrency WHERE did_number = ANY(${dids})`;
    for (const r of res.rows) active[r.did_number] = Number(r.active_count) || 0;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
  return active;
}
async function pgIncrement(didNumber, clientId, maxConcurrent) {
  const did = _norm10(didNumber);
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
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgGetPendingBatch(campaignId, limit) {
  const pg = makePgClient();
  const nowIso = new Date().toISOString();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT id, lead_id, lead_name, lead_phone, attempt_count, followup_call_date
      FROM campaign_leads
      WHERE campaign_id = ${campaignId} AND status = 'pending'
        AND (followup_call_date IS NULL OR followup_call_date <= ${nowIso}::timestamptz)
      ORDER BY created_date ASC LIMIT ${limit}`;
    return res.rows;
  } catch (e) {
    console.warn(`[campaign] pgGetPendingBatch failed (${e.message})`);
    return null;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgGetInFlight(campaignId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT COUNT(*) FILTER (WHERE status IN ('calling','processing'))::int AS in_flight
      FROM campaign_leads WHERE campaign_id = ${campaignId}`;
    return res.rows[0]?.in_flight || 0;
  } catch (_) { return null; } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgClaimLead(leadId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      UPDATE campaign_leads
        SET status = 'calling', attempt_count = COALESCE(attempt_count, 0) + 1, updated_at = now()
      WHERE id = ${leadId} AND status = 'pending' RETURNING id`;
    if (res.rows.length > 0) return true;
    const exists = await pg.queryObject`SELECT 1 FROM campaign_leads WHERE id = ${leadId} LIMIT 1`;
    return exists.rows.length > 0 ? false : 'not_mirrored';
  } catch (e) {
    console.warn(`[campaign] pgClaimLead failed (${e.message})`);
    return null;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgInsertCallLog(row) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const nowIso = new Date().toISOString();
    await pg.queryObject`
      INSERT INTO call_logs
        (id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
         callee_number, direction, status, agent_config_cache, call_start_time, created_date, updated_at)
      VALUES
        (${row.id}, ${row.client_id}, ${row.agent_id}, ${row.lead_id || null},
         ${row.campaign_id || null}, ${row.call_sid}, ${row.caller_id}, ${row.callee_number},
         'outbound', ${row.status || 'initiated'}, ${JSON.stringify(row.agent_config_cache || {})}::jsonb,
         ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
      ON CONFLICT (id) DO NOTHING`;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgUpdateCallLogStatus(id, callSid, status) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    if (callSid) await pg.queryObject`UPDATE call_logs SET call_sid = ${callSid}, status = ${status}, updated_at = now() WHERE id = ${id}`;
    else await pg.queryObject`UPDATE call_logs SET status = ${status}, updated_at = now() WHERE id = ${id}`;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgAttachCallLog(leadId, callLogId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`UPDATE campaign_leads SET call_log_id = ${callLogId}, updated_at = now() WHERE id = ${leadId}`;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgResetLeadPending(leadId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      UPDATE campaign_leads SET status = 'pending', call_log_id = NULL,
        attempt_count = GREATEST(0, COALESCE(attempt_count, 1) - 1), updated_at = now()
      WHERE id = ${leadId}`;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgFailLead(leadId) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`
      UPDATE campaign_leads SET status = 'completed', outcome = 'not_answered', updated_at = now() WHERE id = ${leadId}`;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}

export default async function executeCampaign(c: any) {
  const req = c.req.raw || c.req;
  try {
    const body = await c.req.json();
    const { campaign_id, action, _internal } = body;
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    let base44;
    let user = null;

    base44 = createClientFromRequest(req);
    if (!_internal) {
      user = c.get('jwtPayload');
      if (!user) {
        return c.json({ data: { error: 'Unauthorized' } }, 401);
      }
    }

    const svc = base44.asServiceRole;

    // updateCL — update a CampaignLead in Base44 AND mirror the operational
    // fields into Postgres in the same step (fire-and-forget). This removes the
    // dependency on the credit-gated entity-automation: the mirror stays live
    // inline, at zero integration-credit cost. Never blocks the Base44 write.
    const updateCL = async (id, fields) => {
      await svc.entities.CampaignLead.update(id, fields);
      svc.functions.invoke('pgCampaignLeadSync', {
        campaign_lead: { id, campaign_id, ...fields }
      }).catch((e) => console.warn(`[campaign] pg mirror skipped: ${e.message}`));
    };

    // Retry-on-429 wrapper for early reads — a transient platform rate-limit
    // burst should not crash the whole run with a 500. Backs off and retries.
    const safeRead = async (fn, fallback = undefined) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (/429|rate limit/i.test(e.message || '') && attempt < 4) {
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      return fallback;
    };

    const campaign = await safeRead(() => svc.entities.Campaign.get(campaign_id));
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    // Ownership check only for direct user calls
    if (user && !_internal) {
      if (user.role !== 'admin') {
        const clients = await base44.entities.Client.filter({ user_id: user.id });
        const clientIds = clients.map(c => c.id);
        if (!clientIds.includes(campaign.client_id)) {
          return c.json({ data: { error: 'Forbidden' } }, 403);
        }
      }
    }

    // Handle pause/resume/cancel
    if (action === 'pause') {
      await svc.entities.Campaign.update(campaign_id, { status: 'paused' });
      return c.json({ data: { success: true, status: 'paused' } });
    }
    if (action === 'cancel') {
      await svc.entities.Campaign.update(campaign_id, { status: 'cancelled' });
      return c.json({ data: { success: true, status: 'cancelled' } });
    }

    // Guard: don't restart a completed/cancelled campaign via internal trigger
    if (_internal && ['completed', 'cancelled'].includes(campaign.status)) {
      return c.json({ data: { success: true, skipped: `campaign_${campaign.status}` } });
    }

    // ─── ONE RUNNING CAMPAIGN PER AGENT (bandwidth / revenue guard) ───
    // An agent maps to a paid voice channel. Allowing one agent to drive
    // multiple concurrent campaigns lets a client consume bandwidth they
    // didn't pay for. Each agent may run only ONE campaign at a time.
    // A client with N agents can run N campaigns. To run another campaign on
    // the same agent, the current one must first complete or be cancelled.
    // (Only blocks STARTING a fresh run — pause/cancel above already returned.)
    if (campaign.status !== 'running' && campaign.agent_id) {
      const agentCampaigns = await svc.entities.Campaign.filter({
        client_id: campaign.client_id,
        agent_id: campaign.agent_id,
        status: 'running',
      });
      const otherRunning = agentCampaigns.find((c) => c.id !== campaign_id);
      if (otherRunning) {
        return c.json({ data: {
          error: `This agent is already running campaign "${otherRunning.name}". An agent can run only one campaign at a time — complete or cancel it first, or assign a different agent.`,
          code: 'agent_busy',
          busy_campaign_id: otherRunning.id,
          busy_campaign_name: otherRunning.name,
        } }, 409);
      }
    }

    // ─── REGION-AWARE CALLING WINDOW (Phase 4) ───
    // IN: 10 AM – 9 PM IST (TCCCPR 2018 — matches campaignPoller)
    // US: 8 AM – 9 PM local-rep time → use America/New_York as primary (covers TCPA 8a-9p)
    // UK: 8 AM – 9 PM London time (OFCOM guideline)
    // global: 9 AM – 6 PM UTC (broad safe window)
    const clientForWindow = await svc.entities.Client.get(campaign.client_id).catch(() => null);
    const region = clientForWindow?.region || 'IN';
    const WINDOW_BY_REGION = {
      IN: { tz: 'Asia/Kolkata', start: 10,  end: 21, label: '10 AM – 9 PM IST' },
      US: { tz: 'America/New_York', start: 8, end: 21, label: '8 AM – 9 PM ET (TCPA-safe)' },
      UK: { tz: 'Europe/London', start: 8, end: 21, label: '8 AM – 9 PM UK' },
      global: { tz: 'UTC', start: 9, end: 18, label: '9 AM – 6 PM UTC' },
    };
    const win = WINDOW_BY_REGION[region] || WINDOW_BY_REGION.IN;
    const localHour = parseInt(
      new Date().toLocaleString('en-GB', { timeZone: win.tz, hour: '2-digit', hour12: false }).trim(),
      10
    );
    if (localHour < win.start || localHour >= win.end) {
      console.log(`[campaign] Outside ${region} calling window (${win.tz} ${localHour}:00). Resumes ${win.label}.`);
      if (campaign.status !== 'running') {
        await svc.entities.Campaign.update(campaign_id, { status: 'running' });
      }
      return c.json({ data: {
        success: true,
        skipped: 'outside_calling_window',
        message: `Campaign calls are restricted to ${win.label}. Will resume automatically.`,
        region,
        current_local_hour: localHour,
        window: win
      } });
    }

    // Start or resume campaign
    await svc.entities.Campaign.update(campaign_id, {
      status: 'running',
      started_at: campaign.started_at || new Date().toISOString()
    });

    const agent = await svc.entities.Agent.get(campaign.agent_id);
    const agentDIDs = (agent?.assigned_dids && agent.assigned_dids.length > 0)
      ? agent.assigned_dids
      : (agent?.assigned_did ? [agent.assigned_did] : []);
    if (!agent || agentDIDs.length === 0) {
      await svc.entities.Campaign.update(campaign_id, { status: 'draft' });
      return c.json({ data: { error: 'Agent has no assigned DID' } }, 400);
    }

    // Load DID records to know per-DID concurrency caps
    const didRecords = await svc.entities.DID.filter({ client_id: campaign.client_id });
    const didCapMap = {};
    for (const n of agentDIDs) {
      const rec = didRecords.find((d) => d.number === n);
      didCapMap[n] = rec?.max_concurrent_calls || 1;
    }

    // Pre-fetch knowledge base content
    let kbContent = '';
    if (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await svc.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
        } catch (e) {
          console.log(`KB doc ${kbId} fetch failed: ${e.message}`);
        }
      }
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;

    // Fix any stuck 'calling' leads from previous runs — PG-canonical (matches the
    // poller's pgSweepStuckCalling). Any lead stuck in 'calling' > 5 min (webhook
    // lost) is reset to 'pending' so it re-dials. Done in ONE SQL UPDATE.
    try {
      const pg = makePgClient();
      try {
        ; /* pg.connect() not needed */
        const cutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const r = await pg.queryObject`
          UPDATE campaign_leads SET status = 'pending', call_log_id = NULL, updated_at = now()
          WHERE campaign_id = ${campaign_id} AND status = 'calling'
            AND updated_at < ${cutoffIso}::timestamptz RETURNING id`;
        if (r.rows.length > 0) console.log(`[campaign] PG-reset ${r.rows.length} stuck 'calling' leads → pending`);
      } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
    } catch (e) {
      console.error(`[campaign] Stuck-lead PG sweep failed: ${e.message}`);
    }

    // ─── FIRE-AND-FORGET BATCH: Initiate up to maxConcurrent calls without waiting ───
    const results = { initiated: 0, failed: 0, errors: [] };

    // Count currently active calls from PG (canonical) — campaign-level cap.
    const inFlight = await pgGetInFlight(campaign_id);
    const callingCount = inFlight === null ? 0 : inFlight;
    const slotsAvailable = Math.max(0, maxConcurrent - callingCount);

    // Per-DID active counts come from the atomic Postgres counter (direct read,
    // no cross-function invoke). Keyed by last-10 digits.
    const norm10 = _norm10;
    const activeCallsPerDID = async () => {
      const active = {};
      for (const n of agentDIDs) active[norm10(n)] = 0;
      try {
        const pgActive = await pgGetActiveCounts(agentDIDs);
        for (const k of Object.keys(pgActive)) active[k] = pgActive[k];
      } catch (e) {
        console.warn(`[campaign] pgGetActiveCounts failed (${e.message}) — assuming 0 active`);
      }
      return active;
    };

    // Round-robin across the agent's DIDs. Among DIDs that still have a free
    // slot, pick the LEAST-loaded one (fewest active calls). On ties (e.g. all
    // idle) advance a rotating cursor so successive dials in the same batch
    // spread evenly across every DID instead of always hitting the first one.
    // This gives multi-DID agents true round-robin.
    let rrCursor = 0;
    const pickDID = (activeMap) => {
      const available = agentDIDs.filter(
        (n) => (didCapMap[n] || 1) - (activeMap[norm10(n)] || 0) > 0
      );
      if (available.length === 0) return null;
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

    if (slotsAvailable === 0) {
      console.log(`[campaign] All ${maxConcurrent} slots occupied. Waiting for completions.`);
      return c.json({ data: { success: true, message: 'All slots occupied', currently_calling: callingCount } });
    }

    // Get next ready pending leads from PG (canonical state).
    const now = new Date();
    const pgPending = await pgGetPendingBatch(campaign_id, slotsAvailable);
    const pendingLeads = pgPending === null ? [] : pgPending;

    if (pendingLeads.length === 0) {
      // Check if campaign should be completed — now a SINGLE SQL query against
      // the Postgres campaign_leads mirror instead of paginating every status on
      // Base44 (the old approach hit the SDK ~1000-row ceiling AND exhausted the
      // rate limit on large campaigns). Falls back to the per-status Base44
      // pagination only if the SQL mirror is unreachable.
      let callingCount, pendingWithFutureRetry, pendingReady, completedCount, failedCount, outcomes;
      let usedPg = false;
      try {
        const pgRes = await svc.functions.invoke('pgCampaignLeadCounts', {
          service_call: true, campaign_id
        });
        const d = pgRes?.data;
        if (d && d.counts) {
          callingCount = (d.counts.calling || 0) + (d.counts.processing || 0);
          pendingWithFutureRetry = d.pending_retry_later || 0;
          pendingReady = d.pending_ready || 0;
          completedCount = d.counts.completed || 0;
          failedCount = d.counts.failed || 0;
          outcomes = d.outcomes;
          usedPg = true;
        }
      } catch (e) {
        console.warn(`[campaign] pgCampaignLeadCounts failed (${e.message}) — falling back to Base44 scan`);
      }

      if (!usedPg) {
        const fetchAllByStatus = async (statusValue) => {
          const out = [];
          const PAGE_SIZE = 200;
          let pageIdx = 0;
          while (true) {
            const page = await safeRead(() => svc.entities.CampaignLead.filter(
              { campaign_id, status: statusValue }, 'created_date', PAGE_SIZE, pageIdx * PAGE_SIZE
            ), []);
            if (!page || page.length === 0) break;
            out.push(...page);
            pageIdx++;
            if (pageIdx > 250) break; // safety: 50k per status
            await new Promise(r => setTimeout(r, 120));
          }
          return out;
        };
        const [pendingAll, callingAll, completedAll, failedAll] = await Promise.all([
          fetchAllByStatus('pending'),
          fetchAllByStatus('calling'),
          fetchAllByStatus('completed'),
          fetchAllByStatus('failed'),
        ]);
        callingCount = callingAll.length;
        pendingWithFutureRetry = pendingAll.filter(l => l.followup_call_date && new Date(l.followup_call_date) > now).length;
        pendingReady = pendingAll.filter(l => !l.followup_call_date || new Date(l.followup_call_date) <= now).length;
        completedCount = completedAll.length;
        failedCount = failedAll.length;
        outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
        [...completedAll, ...failedAll].forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
      }

      if (callingCount === 0 && pendingReady === 0 && pendingWithFutureRetry === 0) {
        await svc.entities.Campaign.update(campaign_id, {
          status: 'completed', completed_at: new Date().toISOString(),
          calls_completed: completedCount, calls_failed: failedCount, outcomes_summary: outcomes
        });
        console.log(`[campaign] Campaign completed: ${completedCount} done, ${failedCount} failed`);
        return c.json({ data: { success: true, status: 'completed', completed: completedCount, failed: failedCount } });
      }

      if (pendingWithFutureRetry > 0) {
        console.log(`[campaign] ${pendingWithFutureRetry} leads waiting for retry. Campaign continues.`);
      }
      return c.json({ data: { success: true, message: 'No ready leads', pending_retry: pendingWithFutureRetry, calling: callingCount } });
    }

    // Determine Smartflo API key
    let smartfloApiKey;
    try {
      const clientData = await svc.entities.Client.get(campaign.client_id);
      const isDemoAgent = clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding');
      smartfloApiKey = isDemoAgent
        ? Deno.env.get('SMARTFLO_API_KEY')
        : (agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY'));
    } catch (_) {
      smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    }

    // Initial DID load-counts; we'll increment locally as we fire calls
    const activeMap = await activeCallsPerDID();

    // ─── DND / WHATSAPP UNSUBSCRIBE CHECK ───
    // Pre-load the client's unsubscribe + do-not-call list once per execution.
    // We skip leads on either list to honor DPDP / TRAI compliance.
    let dndPhones = new Set();
    try {
      const unsubs = await svc.entities.WhatsAppUnsubscribe.filter({ client_id: campaign.client_id }).catch(() => []);
      unsubs.forEach(u => {
        const p = String(u.recipient_phone || '').replace(/[^0-9]/g, '');
        if (p) dndPhones.add(p);
      });
      // Also honor Lead.status === 'do_not_call'
      const dncLeads = await svc.entities.Lead.filter({ client_id: campaign.client_id, status: 'do_not_call' }).catch(() => []);
      dncLeads.forEach(l => {
        const p = String(l.phone || '').replace(/[^0-9]/g, '');
        if (p) dndPhones.add(p);
      });
      if (dndPhones.size > 0) console.log(`[campaign] DND list loaded: ${dndPhones.size} phones`);
    } catch (e) {
      console.error(`[campaign] DND list load failed: ${e.message}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // CAMPAIGN PROVIDER ROUTING (inline — kept in sync across 4 sites)
    // Domestic IN → Smartflo (existing path below, unchanged).
    // International (US/UK/other) → Twilio via twilioInitiateCall.
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
    const campaignClient = await svc.entities.Client.get(campaign.client_id).catch(() => null);

    // ─── Fire all calls in quick succession (PG-primary, no Base44 CallLog) ───
    for (const cl of pendingLeads) {
      try {
        // ─── TWILIO BRANCH (international) ───
        // Delegate to twilioInitiateCall (owns its CallLog). Claim is PG-atomic.
        const providerForLead = resolveCampaignProvider(agent, cl.lead_phone, campaignClient);
        if (providerForLead === 'twilio') {
          const claimed = await pgClaimLead(cl.id);
          if (claimed === false) { console.log(`[campaign] Lead ${cl.lead_name} already claimed — skipping`); continue; }
          if (claimed === null) { console.warn(`[campaign] PG claim unavailable — deferring to poller`); continue; }
          if (claimed === 'not_mirrored') {
            const fresh = await svc.entities.CampaignLead.get(cl.id).catch(() => null);
            if (!fresh || fresh.status !== 'pending') continue;
          }
          try {
            const twRes = await base44.functions.invoke('twilioInitiateCall', {
              lead_id: cl.lead_id, agent_id: campaign.agent_id,
              phone_number: cl.lead_phone, service_call: true
            });
            const twData = twRes?.data || {};
            if (twData.success && twData.call_log_id) {
              await pgAttachCallLog(cl.id, twData.call_log_id);
              svc.entities.CampaignLead.update(cl.id, { call_log_id: twData.call_log_id }).catch(() => {});
              results.initiated++;
              console.log(`[campaign] ✅ Twilio call fired for ${cl.lead_name} (callLog=${twData.call_log_id})`);
            } else {
              await pgFailLead(cl.id);
              results.failed++;
              results.errors.push({ lead: cl.lead_phone, error: twData.error || 'twilio_failed' });
            }
          } catch (twErr) {
            await pgResetLeadPending(cl.id);
            results.failed++;
            results.errors.push({ lead: cl.lead_phone, error: twErr.message });
          }
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        // ─── End Twilio branch — fall through to Smartflo for IN ───

        // ─── DND check: skip if phone is on unsubscribe / do-not-call list ───
        const leadPhoneClean = String(cl.lead_phone || '').replace(/[^0-9]/g, '');
        const leadPhoneLast10 = leadPhoneClean.slice(-10);
        const isDND = dndPhones.has(leadPhoneClean) ||
                      (leadPhoneLast10.length === 10 && Array.from(dndPhones).some(p => p.endsWith(leadPhoneLast10)));
        if (isDND) {
          console.log(`[campaign] 🛑 Skipping ${cl.lead_name} — on DND/unsubscribe list`);
          updateCL(cl.id, {
            status: 'skipped', outcome: 'do_not_call', call_status: 'not_answered',
            conversation_summary: 'Skipped — lead is on the DND / WhatsApp unsubscribe list (compliance).'
          }).catch(() => {});
          continue;
        }

        // Pick DID with most free capacity; stop if no DID has room.
        const selectedDID = pickDID(activeMap);
        if (!selectedDID) {
          console.log(`[campaign] All DIDs saturated — leaving ${cl.lead_name} pending for next cycle`);
          break;
        }

        // ─── ATOMIC PG CLAIM (shares one lock with poller + webhook) ───
        const claimed = await pgClaimLead(cl.id);
        if (claimed === false) { console.log(`[campaign] Lead ${cl.lead_name} already claimed — skipping`); continue; }
        if (claimed === null) { console.warn(`[campaign] PG claim unavailable — deferring`); continue; }
        if (claimed === 'not_mirrored') {
          const fresh = await svc.entities.CampaignLead.get(cl.id).catch(() => null);
          if (!fresh || fresh.status !== 'pending') continue;
        }
        activeMap[norm10(selectedDID)] = (activeMap[norm10(selectedDID)] || 0) + 1;

        // Normalize callee → valid Indian 10-digit subscriber number.
        const cleanPhone = leadPhoneClean.slice(-10);
        if (cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
          console.warn(`[campaign] ✋ Invalid number for ${cl.lead_name} ("${cl.lead_phone}") — failing, no retry`);
          await pgFailLead(cl.id);
          activeMap[norm10(selectedDID)] = Math.max(0, (activeMap[norm10(selectedDID)] || 1) - 1);
          continue;
        }
        const callSid = `camp_${campaign_id.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const callLogId = genUuid();

        // Lead context from CampaignLead fields (stream fetches full lead at connect).
        const leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;

        const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const timeContext = `\n\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time).\nUse this to calculate relative times. Always confirm callback times in IST.`;

        const personalizedPrompt = [
          agent.system_prompt || '',
          timeContext,
          campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
          campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
          campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
          campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
          `\n\n--- LEAD CONTEXT (YOU MUST USE THIS DATA IN THE CONVERSATION) ---\n${leadContext}`
        ].filter(Boolean).join('\n');

        // ─── POSTGRES-PRIMARY: insert CallLog (config blob read by stream) ───
        await pgInsertCallLog({
          id: callLogId, client_id: campaign.client_id, agent_id: campaign.agent_id,
          lead_id: cl.lead_id, campaign_id, call_sid: callSid,
          caller_id: selectedDID, callee_number: cleanPhone, status: 'initiated',
          agent_config_cache: {
            agent_name: agent.name, agent_id: agent.id, client_id: campaign.client_id,
            lead_id: cl.lead_id || null, core_prompt: personalizedPrompt,
            persona: agent.persona || {}, greeting_message: agent.greeting_message || '',
            tool_flags: {
              has_kb: !!(agent.kb_file_uri || (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0)),
              has_shopify: false, has_unicommerce: false,
              has_call_history: !!cl.lead_id, has_transfer: !!agent.human_transfer_number, has_end_call: true
            },
            kb_file_uri: agent.kb_file_uri || '',
            human_transfer_number: agent.human_transfer_number || '',
            enable_auto_transfer: agent.enable_auto_transfer !== false
          }
        });
        pgAttachCallLog(cl.id, callLogId).catch(() => {});

        // ─── Initiate the call via Smartflo ───
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
        console.log(`[campaign] Smartflo response for ${cl.lead_name}: ${JSON.stringify(smartfloData)}`);

        if (!(smartfloResp.ok && smartfloData.success !== false)) {
          await pgUpdateCallLogStatus(callLogId, callSid, 'failed');
          await pgFailLead(cl.id);
          results.failed++;
          results.errors.push({ lead: cl.lead_phone, error: smartfloData.message || 'API error' });
          continue;
        }

        const smartfloCallId = smartfloData.call_id || smartfloData.ref_id || smartfloData.call_sid || callSid;
        await pgUpdateCallLogStatus(callLogId, smartfloCallId, 'ringing');
        // Increment Postgres DID counter inline (campaign calls bypass initiateCall).
        pgIncrement(selectedDID, campaign.client_id, didCapMap[selectedDID] || 1)
          .catch((e) => console.error(`[campaign] DID increment failed: ${e.message}`));
        results.initiated++;
        console.log(`[campaign] ✅ Call fired for ${cl.lead_name} (PG callLog=${callLogId}, sid=${smartfloCallId})`);

        await new Promise(r => setTimeout(r, 1500));

      } catch (err) {
        console.error(`[campaign] Error calling ${cl.lead_phone}:`, err.message);
        await pgResetLeadPending(cl.id);
        results.failed++;
        results.errors.push({ lead: cl.lead_phone, error: err.message });
      }
    }

    // Update campaign counts — ONE SQL call against the Postgres mirror replaces
    // the four paginated CampaignLead scans that previously exhausted the Base44
    // rate limit (429) on large campaigns right after dialing.
    try {
      const pgRes = await svc.functions.invoke('pgCampaignLeadCounts', {
        service_call: true, campaign_id
      });
      const d = pgRes?.data;
      if (!d || !d.counts) throw new Error('pg counts unavailable');
      await svc.entities.Campaign.update(campaign_id, {
        calls_completed: d.counts.completed || 0, calls_failed: d.counts.failed || 0
      });
      return c.json({ data: {
        success: true, ...results,
        pending_remaining: d.counts.pending || 0,
        currently_calling: d.counts.calling || 0
      } });
    } catch (countErr) {
      // Counting unavailable — calls already fired successfully, so report success.
      // campaignPoller will refresh the counters on its next cycle.
      console.warn(`[campaign] Post-run counting skipped (${countErr.message}). Calls already fired.`);
      return c.json({ data: {
        success: true, ...results,
        counts_deferred: true,
        message: 'Calls fired; counters will refresh shortly.'
      } });
    }

  } catch (error) {
    console.error('[executeCampaign] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};