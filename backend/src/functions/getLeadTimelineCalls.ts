import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// getLeadTimelineCalls
// Returns a lead's full call history FROM POSTGRES (source of truth) for
// the Lead detail timeline UI.
//
// Why this exists: the Lead detail page used to read CallLog from Base44,
// but campaign calls finalize ONLY in Postgres (pgFinalizeCallLog) and are
// never mirrored to Base44. So the page showed stale/leftover Base44 rows
// (e.g. an old "failed" attempt) instead of the actual completed campaign
// call — producing a "Failed Call" badge that didn't match the real call.
// Postgres holds EVERY finalized call (campaign + non-campaign via pgLeadSync),
// so we read the timeline from there.
//
// For campaign rows (PG-only) the transcript/summary live on campaign_leads,
// so we enrich those. recording_url lives on the Base44 CallLog for non-campaign
// calls — we pull it when the row has a Base44 mirror.
// ═══════════════════════════════════════════════════════════════════




function pgClient() { return client; }

export default async function getLeadTimelineCalls(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));
    const { lead_id, limit } = body;
    if (!lead_id) return c.json({ data: { error: 'lead_id required' } }, 400);

    const max = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

    let rows = [];
    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */
      const res = await pg.queryObject`
        SELECT id, direction, status, duration, campaign_id, recording_url,
               call_start_time, created_date, lead_status_updated,
               transcript, conversation_summary
        FROM call_logs
        WHERE lead_id = ${lead_id}
        ORDER BY COALESCE(call_start_time, created_date) DESC NULLS LAST
        LIMIT ${max}`;
      rows = res.rows || [];

      // Enrich campaign (PG-only) rows with transcript/summary from campaign_leads,
      // where completed campaign calls store their results.
      const campIds = rows.filter(r => r.campaign_id).map(r => r.id);
      if (campIds.length) {
        const cl = await pg.queryObject`
          SELECT call_log_id, transcript, conversation_summary, call_duration, call_status
          FROM campaign_leads WHERE call_log_id = ANY(${campIds})`;
        const byId = {};
        for (const c of cl.rows) byId[c.call_log_id] = c;
        rows = rows.map(r => {
          const c = byId[r.id];
          if (!c) return r;
          return {
            ...r,
            transcript: c.transcript || null,
            conversation_summary: c.conversation_summary || r.conversation_summary,
            duration: r.duration || c.call_duration || 0,
            status: r.status || c.call_status || 'completed',
          };
        });
      }
    } catch (e) {
      console.error('[getLeadTimelineCalls] PG read failed:', e.message);
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }

    // Enrich non-campaign rows with transcript/recording from the Base44 CallLog
    // (those fields live on Base44 for non-campaign calls). Skip campaign rows —
    // they have no Base44 mirror and would just 404.
    const enriched = await Promise.all(rows.map(async (r) => {
      if (r.campaign_id) return r;
      const b = await base44.entities.CallLog.get(r.id).catch(() => null);
      return {
        ...r,
        // Transcript/recording/summary live primarily on the PG row — fall back to
        // Base44 if missing. PG-only rows (UUID id, no Base44 mirror) hold the only copy.
        transcript: r.transcript || b?.transcript || null,
        recording_url: r.recording_url || b?.recording_url || null,
        conversation_summary: r.conversation_summary || b?.conversation_summary || null,
      };
    }));

    // ── Base44 safety-net merge ──
    // The PG call_logs mirror is a best-effort dual-write (pgLeadSync) that can
    // silently miss a row (transient PG error, 429, etc.). Non-campaign calls
    // (single-dial, SignalWire/Twilio direct) always have a Base44 CallLog, so
    // pull those directly and union any that the PG read didn't already return.
    // This guarantees Lead Details never shows an empty timeline for a real call.
    try {
      const pgIds = new Set(enriched.map(r => r.id));
      const b44Calls = await base44.entities.CallLog.filter({ lead_id }, '-created_date', max);
      for (const b of b44Calls) {
        if (pgIds.has(b.id)) continue;
        enriched.push({
          id: b.id,
          direction: b.direction,
          status: b.status,
          duration: b.duration,
          campaign_id: null,
          recording_url: b.recording_url || null,
          call_start_time: b.call_start_time || b.created_date,
          created_date: b.created_date,
          lead_status_updated: b.lead_status_updated,
          transcript: b.transcript || null,
          conversation_summary: b.conversation_summary || null,
        });
      }
      // Keep newest-first ordering after the merge.
      enriched.sort((a, b) =>
        new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date)
      );
    } catch (e) {
      console.error('[getLeadTimelineCalls] Base44 safety-net merge failed:', e.message);
    }

    return c.json({ data: { calls: enriched.slice(0, max) } });
  } catch (error) {
    console.error('[getLeadTimelineCalls] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};