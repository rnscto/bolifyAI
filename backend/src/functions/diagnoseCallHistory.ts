import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { Client as PgClient } from "jsr:@db/postgres@0.19.4";



// ONE-SHOT DIAGNOSTIC — verify whether lead call_history actually reaches the
// container. Checks the exact columns/queries the container relies on:
//   1. Does PG `leads` have a populated call_history / last_summary column?
//   2. For a sample lead with >1 call, what does the container's history read return?
//   3. Does call_logs.agent_config_cache carry the lead snapshot one-liner?
// Read-only. Safe to delete after diagnosis.

function pg() {
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

export default async function diagnoseCallHistory(c: any) {
  const req = c.req.raw || c.req;
  const out = {};
  let db;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));
    db = pg();
    ; /* db.connect() not needed */

    // 0. Confirm the columns exist on `leads`
    const cols = await db.queryObject`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'leads' AND column_name IN ('call_history','last_summary','score','last_call_date')`;
    out.lead_columns_present = cols.rows.map(r => r.column_name);

    // 1. How many leads actually have call_history written?
    const counts = await db.queryObject`
      SELECT
        COUNT(*) FILTER (WHERE call_history IS NOT NULL AND call_history <> '')::int AS with_history,
        COUNT(*) FILTER (WHERE last_summary IS NOT NULL AND last_summary <> '')::int AS with_summary,
        COUNT(*)::int AS total
      FROM leads`;
    out.lead_history_counts = counts.rows[0];

    // 2. How many leads have >1 finalized call (i.e. SHOULD have history on the 2nd call)?
    const multi = await db.queryObject`
      SELECT lead_id, COUNT(*)::int AS n
      FROM call_logs
      WHERE lead_id IS NOT NULL AND status IN ('completed','answered')
      GROUP BY lead_id HAVING COUNT(*) > 1
      ORDER BY n DESC LIMIT 5`;
    out.sample_multi_call_leads = multi.rows;

    // 3. For the top multi-call lead, replicate the container's EXACT history read.
    if (multi.rows.length > 0) {
      const leadId = multi.rows[0].lead_id;
      const hr = await db.queryObject`
        SELECT call_history, last_summary, score, status
        FROM leads WHERE id = ${leadId} LIMIT 1`;
      const row = hr.rows[0] || {};
      out.container_read_for_top_lead = {
        lead_id: leadId,
        call_count: Number(multi.rows[0].n),
        has_call_history: !!(row.call_history && row.call_history.trim()),
        has_last_summary: !!(row.last_summary && row.last_summary.trim()),
        call_history_len: (row.call_history || '').length,
        call_history_preview: (row.call_history || '').slice(0, 300),
        last_summary_preview: (row.last_summary || '').slice(0, 200),
      };

      // 4. Do the finalized call_logs for that lead actually carry summaries?
      const cl = await db.queryObject`
        SELECT id, status, duration::int AS duration,
               (conversation_summary IS NOT NULL AND conversation_summary <> '') AS has_summary,
               length(conversation_summary)::int AS summary_len
        FROM call_logs WHERE lead_id = ${leadId}
        ORDER BY COALESCE(call_start_time, created_date) DESC LIMIT 5`;
      out.top_lead_call_logs = cl.rows;
    }

    return c.json({ data: { success: true, ...out } });
  } catch (error) {
    return c.json({ data: { success: false, error: error.message, partial: out } }, 500);
  } finally {
    try { if (db) ; /* db.end() not needed */ } catch (_) {}
  }

};