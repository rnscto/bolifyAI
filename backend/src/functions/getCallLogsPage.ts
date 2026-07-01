import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";



// ═══════════════════════════════════════════════════════════════════════
// getCallLogsPage — server-side paginated Call Logs (no full dataset in browser)
// ═══════════════════════════════════════════════════════════════════════
// Replaces the old ClientCallLogs pattern that loaded ALL leads (7000+) +
// ALL contacts just to resolve names on 100 visible rows, every 60s.
//
// Strategy:
//   1. One page of CallLogs (50) from Base44 (server-paginated, filterable).
//   2. Stat counts (total / outbound / inbound / completed / per-agent) from
//      the PG call_logs mirror in a single SQL query (no row scans in browser).
//   3. Resolve names ONLY for the phone numbers on the current page — query
//      just those leads/contacts, not the entire database.
//
// Payload: { client_id, page?, page_size?, agent_id? }
// Returns: { calls, total, stats:{outbound,inbound,completed,total,by_agent}, names:{<last10>:name} }
// ═══════════════════════════════════════════════════════════════════════

function pgClient() { return client; }

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// Fetch ONE page of call rows DIRECTLY from the Postgres call_logs mirror.
// Campaign dials (Option A) write CallLogs to Postgres ONLY and skip the Base44
// mirror, so reading rows from Base44 misses every campaign call — that's why the
// page appeared "stuck" on yesterday's calls. Postgres is the canonical source.
async function getCallRows(clientId, agentId, pageSize, offset) {
  const pg = pgClient();
  try {
    ; /* pg.connect() not needed */
    const res = agentId
      ? await pg.queryObject`
          SELECT id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
                 callee_number, direction, status, duration, provider, country_code,
                 call_start_time, call_end_time, created_date, agent_config_cache,
                 recording_url, transcript, conversation_summary
          FROM call_logs
          WHERE client_id = ${clientId} AND agent_id = ${agentId}
          ORDER BY created_date DESC
          LIMIT ${pageSize} OFFSET ${offset}`
      : await pg.queryObject`
          SELECT id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
                 callee_number, direction, status, duration, provider, country_code,
                 call_start_time, call_end_time, created_date, agent_config_cache,
                 recording_url, transcript, conversation_summary
          FROM call_logs
          WHERE client_id = ${clientId}
          ORDER BY created_date DESC
          LIMIT ${pageSize} OFFSET ${offset}`;
    return res.rows;
  } catch (e) {
    console.warn(`[getCallLogsPage] PG rows failed (${e.message}) — falling back to Base44`);
    return null; // null → caller falls back to Base44
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

// Aggregate counts from the PG call_logs mirror — fast, no row scans in browser.
async function getStats(clientId) {
  const pg = pgClient();
  try {
    ; /* pg.connect() not needed */
    const totals = await pg.queryObject`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
        COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
      FROM call_logs WHERE client_id = ${clientId}`;
    const byAgentRes = await pg.queryObject`
      SELECT agent_id, COUNT(*)::int AS n
      FROM call_logs WHERE client_id = ${clientId} AND agent_id IS NOT NULL
      GROUP BY agent_id`;
    const by_agent = {};
    for (const r of byAgentRes.rows) by_agent[r.agent_id] = r.n;
    const t = totals.rows[0] || {};
    return { total: t.total || 0, outbound: t.outbound || 0, inbound: t.inbound || 0, completed: t.completed || 0, by_agent };
  } catch (e) {
    console.warn(`[getCallLogsPage] PG stats failed (${e.message}) — returning empty stats`);
    return null;
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }
}

export default async function getCallLogsPage(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const user = c.get('jwtPayload').catch(() => null);
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json().catch(() => ({}));
    const clientId = body.client_id;
    if (!clientId) return c.json({ data: { error: 'client_id required' } }, 400);

    const pageSize = Math.min(200, Math.max(1, parseInt(body.page_size, 10) || 50));
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const offset = (page - 1) * pageSize;
    const agentId = body.agent_id && body.agent_id !== 'all' ? body.agent_id : null;

    // 1) One page of CallLogs (newest first) — ORDER from POSTGRES (canonical).
    // Campaign dials live ONLY in PG, so reading rows from Base44 missed them and
    // made the page look stuck on old calls. We page from PG, then enrich each row
    // with the Base44 record (transcript / recording_url / summary / stream_sid live
    // on Base44, not PG). Falls back to a pure Base44 page if PG is unreachable.
    let calls = await getCallRows(clientId, agentId, pageSize, offset);
    if (calls === null) {
      const filter = { client_id: clientId };
      if (agentId) filter.agent_id = agentId;
      calls = await svc.entities.CallLog.filter(filter, '-created_date', pageSize, offset);
    } else if (calls.length > 0) {
      // Enrich PG rows with the Base44 record (transcript/recording/summary live on
      // Base44, not PG). Campaign-only rows have NO Base44 mirror (Option A writes
      // them to PG only) — calling Base44.get on those just 404-spams the log. So we
      // only enrich rows WITHOUT a campaign_id; campaign rows get their transcript/
      // summary from the campaign_leads PG mirror instead.
      const enriched = await Promise.all(calls.map(async (row) => {
        if (row.campaign_id) {
          // Campaign calls store their recording on the PG call_logs row itself —
          // keep it (row.recording_url) instead of nulling it.
          return { ...row, stream_sid: null, recording_url: row.recording_url || null, transcript: null, conversation_summary: row.conversation_summary || '', lead_status_updated: null };
        }
        // Skip the Base44 lookup when the PG row already carries the display data.
        // PG-only rows (UUID id) have no Base44 mirror — calling .get() just 404-spams
        // the log and adds latency. Only hit Base44 when transcript is actually missing.
        const needsBase44 = !row.transcript || !row.recording_url;
        const b = needsBase44 ? await svc.entities.CallLog.get(row.id).catch(() => null) : null;
        return {
          ...row,
          stream_sid: b?.stream_sid || null,
          // Recording/transcript/summary live primarily on the PG row — fall back
          // to Base44 if missing. PG-only rows (UUID id, no Base44 mirror) hold the
          // only copy, so reading Base44 alone dropped their transcript.
          recording_url: row.recording_url || b?.recording_url || null,
          transcript: row.transcript || b?.transcript || null,
          conversation_summary: row.conversation_summary || b?.conversation_summary || '',
          lead_status_updated: b?.lead_status_updated || null,
          duration: row.duration || b?.duration || 0,
        };
      }));
      // For campaign rows, pull transcript/summary/duration from the campaign_leads
      // PG mirror (where completed campaign calls store their results).
      const campRowIdxByCallLog = {};
      enriched.forEach((r, i) => { if (r.campaign_id) campRowIdxByCallLog[r.id] = i; });
      const callLogIds = Object.keys(campRowIdxByCallLog);
      if (callLogIds.length > 0) {
        const pg2 = pgClient();
        try {
          ; /* pg2.connect() not needed */
          const clRows = await pg2.queryObject`
            SELECT call_log_id, transcript, conversation_summary, call_duration, call_status
            FROM campaign_leads WHERE call_log_id = ANY(${callLogIds})`;
          for (const cl of clRows.rows) {
            const idx = campRowIdxByCallLog[cl.call_log_id];
            if (idx === undefined) continue;
            enriched[idx].transcript = cl.transcript || null;
            enriched[idx].conversation_summary = cl.conversation_summary || enriched[idx].conversation_summary || '';
            if (cl.call_duration) enriched[idx].duration = cl.call_duration;
          }
        } catch (e) {
          console.warn(`[getCallLogsPage] campaign_leads enrich failed (${e.message})`);
        } finally {
          try { ; /* pg2.end() not needed */ } catch (_) {}
        }
      }
      calls = enriched;
    }

    // 2) Aggregate stats from PG mirror (fast). page total respects agent filter.
    const stats = await getStats(clientId);
    const total = agentId ? (stats?.by_agent?.[agentId] || 0) : (stats?.total || 0);

    // 3) Resolve names ONLY for the phone numbers on THIS page.
    const phones = new Set();
    for (const c of calls) {
      const raw = c.direction === 'inbound' ? (c.caller_id || c.callee_number) : (c.callee_number || c.caller_id);
      const k = last10(raw);
      if (k.length === 10) phones.add(k);
    }
    const names = {};
    if (phones.size > 0) {
      const phoneList = Array.from(phones);
      // TrustedContacts take priority, then Leads — match by last-10 digits in PG.
      const pg = pgClient();
      try {
        ; /* pg.connect() not needed */
        // Leads first (lower priority — contacts overwrite below)
        const leadRows = await pg.queryObject`
          SELECT name, RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) AS k
          FROM leads
          WHERE client_id = ${clientId}
            AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = ANY(${phoneList})
            AND name IS NOT NULL AND name <> ''`;
        for (const r of leadRows.rows) if (r.k && !names[r.k]) names[r.k] = r.name;
      } catch (e) {
        console.warn(`[getCallLogsPage] lead name resolve failed (${e.message})`);
      } finally {
        try { ; /* pg.end() not needed */ } catch (_) {}
      }
      // TrustedContacts via Base44 (small table) — overwrite leads (priority).
      try {
        const contacts = await svc.entities.TrustedContact.filter({ client_id: clientId });
        for (const c of contacts) {
          const k = last10(c.phone);
          if (k.length === 10 && c.name) names[k] = c.name;
        }
      } catch (_) { /* ignore */ }
    }

    return c.json({ data: { success: true, calls, total, stats: stats || { total: 0, outbound: 0, inbound: 0, completed: 0, by_agent: {} }, names } });
  } catch (error) {
    console.error('[getCallLogsPage] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};