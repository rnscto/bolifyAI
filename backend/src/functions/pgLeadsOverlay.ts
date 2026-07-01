import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// pgLeadsOverlay — live status/score/summary overlay for ClientLeads, read
// straight from Azure Postgres (NOT Base44). Zero Base44 rate-limit cost.
// ═══════════════════════════════════════════════════════════════════════
// The ClientLeads table pulls its rows (name/phone/etc.) from Base44 via
// getLeadsPage. But the LIVE call results (status, qualification_tier, AI
// score, last call summary, last call date) land in Postgres first — the
// `leads` mirror (status/tier) and `call_logs` (score embedded in summary +
// conversation_summary). This function takes the visible lead IDs and returns
// the freshest values for each so the page can overlay them on the rows
// WITHOUT waiting for the (credit-throttled) Base44 Lead write-back.
//
// Payload: { client_id, lead_ids: [...] }
// Returns: { overlays: { <lead_id>: { status, qualification_tier, score,
//            summary, last_call_date } } }
// ═══════════════════════════════════════════════════════════════════════

import { Client } from 'jsr:@db/postgres@0.19.4';

function pgClient() {
  return new Client({
    hostname: Deno.env.get('AZURE_PG_HOST'),
    port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
    database: Deno.env.get('AZURE_PG_DATABASE'),
    user: Deno.env.get('AZURE_PG_USER'),
    password: Deno.env.get('AZURE_PG_PASSWORD'),
    tls: { enabled: true, enforce: true },
    connection: { attempts: 1 },
  });
}

// Pull a "Score: NN/100" out of a summary string if the container embedded it.
function deriveScore(summary) {
  if (!summary) return null;
  const m = /Score:\s*(\d{1,3})\s*\/\s*100/i.exec(summary);
  if (!m) return null;
  return Math.min(100, Math.max(0, parseInt(m[1], 10)));
}

export default async function pgLeadsOverlay(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id, lead_ids } = await c.req.json().catch(() => ({}));
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);
    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return c.json({ data: { overlays: {} } });
    }

    const client = pgClient();
    const overlays = {};
    try {
      ; /* client.connect() not needed */

      // 1) Mirrored status + tier + dedicated score + last_call_date from the
      //    `leads` table (fast, authoritative when present).
      const leadRows = await client.queryObject`
        SELECT id, status, qualification_tier, score, last_call_date
        FROM leads
        WHERE client_id = ${client_id} AND id = ANY(${lead_ids})
      `;
      for (const r of leadRows.rows) {
        overlays[r.id] = {
          status: r.status || null,
          qualification_tier: r.qualification_tier || null,
          score: typeof r.score === 'number' ? r.score : null,
          summary: null,
          last_call_date: r.last_call_date || null,
        };
      }

      // 2) Latest finalized call per lead from `call_logs` — provides the call
      //    summary, and a fallback score/last_call_date if the leads mirror
      //    doesn't carry them yet. DISTINCT ON keeps the most recent call.
      const callRows = await client.queryObject`
        SELECT DISTINCT ON (lead_id)
          lead_id, conversation_summary, call_end_time, call_start_time, created_date
        FROM call_logs
        WHERE client_id = ${client_id}
          AND lead_id = ANY(${lead_ids})
          AND conversation_summary IS NOT NULL
        ORDER BY lead_id, COALESCE(call_end_time, call_start_time, created_date) DESC
      `;
      for (const r of callRows.rows) {
        const o = overlays[r.lead_id] || { status: null, qualification_tier: null, score: null, last_call_date: null };
        o.summary = r.conversation_summary || null;
        if (o.score === null) o.score = deriveScore(r.conversation_summary);
        if (!o.last_call_date) o.last_call_date = r.call_end_time || r.call_start_time || r.created_date || null;
        overlays[r.lead_id] = o;
      }
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }

    return c.json({ data: { overlays } });
  } catch (error) {
    console.error('pgLeadsOverlay error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};