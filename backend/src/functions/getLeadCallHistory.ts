import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// getLeadCallHistory
// Backend for the `get_call_history` AI tool.
// Returns compact summaries of a lead's most recent calls so the AI
// can answer questions like "remember what we discussed last time?"
// without inflating the system prompt.
//
// ⚠️ READS FROM POSTGRES (source of truth), NOT Base44.
// Campaign calls finalize ONLY in Postgres (pgFinalizeCallLog) and are
// never mirrored to Base44. Reading CallLog from Base44 therefore missed
// the most recent campaign calls and served stale history. Postgres holds
// EVERY finalized call (campaign + non-campaign via pgLeadSync), so we read
// the call history from there. The Lead profile itself still comes from Base44.
// ═══════════════════════════════════════════════════════════════════




function pgClient() { return client; }

export default async function getLeadCallHistory(c: any) {
  const req = c.req.raw || c.req;
  try {
    const svc = base44;;
    const body = await c.req.json().catch(() => ({}));
    const { lead_id, limit } = body;
    if (!lead_id) return c.json({ data: { error: 'lead_id required' } }, 400);

    const max = Math.min(Math.max(parseInt(limit) || 5, 1), 10);

    // Lead profile from Base44 (authoritative for name/status/score/tier/notes).
    const lead = await svc.entities.Lead.get(lead_id).catch(() => null);
    if (!lead) return c.json({ data: { error: 'Lead not found' } }, 404);

    // Call history from POSTGRES — includes campaign calls that never reach Base44.
    // Order by most-recent first; fall back to created_date when call_start_time is null.
    let rows = [];
    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */
      const res = await pg.queryObject`
        SELECT call_start_time, created_date, duration, status,
               lead_status_updated, conversation_summary
        FROM call_logs
        WHERE lead_id = ${lead_id}
        ORDER BY COALESCE(call_start_time, created_date) DESC NULLS LAST
        LIMIT ${max}`;
      rows = res.rows || [];
    } catch (e) {
      console.error('[getLeadCallHistory] PG read failed:', e.message);
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }

    const calls = rows.map((cl, i) => {
      const ts = cl.call_start_time || cl.created_date;
      const date = ts
        ? new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
        : 'Unknown';
      return {
        index: i + 1,
        date,
        duration_seconds: Number(cl.duration) || 0,
        outcome: cl.lead_status_updated || cl.status || 'unknown',
        summary: (cl.conversation_summary || '').substring(0, 400)
      };
    });

    return c.json({ data: {
      lead: {
        name: lead.name || 'Unknown',
        status: lead.status || 'new',
        score: lead.score || 0,
        qualification_tier: lead.qualification_tier || 'cold'
      },
      call_count: calls.length,
      calls,
      notes: (lead.notes || '').substring(0, 500)
    } });
  } catch (error) {
    console.error('[getLeadCallHistory] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};