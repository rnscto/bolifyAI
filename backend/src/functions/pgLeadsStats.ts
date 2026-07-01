import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// pgLeadsStats — live tier / status / group / ungrouped counts for the
// ClientLeads page, read straight from Azure Postgres (NOT Base44). The
// summary cards + group sidebar otherwise show stale numbers because the
// Base44 Lead write-back (and the ClientStats materializer) are throttled by
// the exhausted integration credits. Postgres is the source of truth for live
// call results, so these counts always reflect reality at ZERO Base44 cost.
//
// Payload: { client_id }
// Returns: { stats: { tiers, statusCounts, groups, ungrouped, total } }
//   tiers:       { hot, warm, nurture, cold, disqualified }
//   statusCounts:{ new, contacted, interested, ... }
//   groups:      { <group_id>: { total, contacted, converted } }
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

export default async function pgLeadsStats(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id } = await c.req.json().catch(() => ({}));
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    const client = pgClient();
    const tiers = { hot: 0, warm: 0, nurture: 0, cold: 0, disqualified: 0 };
    const statusCounts = {};
    const groups = {};
    let ungrouped = 0;
    let total = 0;

    try {
      ; /* client.connect() not needed */

      // Base total
      const totalRes = await client.queryObject`
        SELECT COUNT(*)::int AS c FROM leads WHERE client_id = ${client_id}
      `;
      total = totalRes.rows[0]?.c || 0;

      // Tier counts
      const tierRes = await client.queryObject`
        SELECT qualification_tier AS tier, COUNT(*)::int AS c
        FROM leads WHERE client_id = ${client_id} AND qualification_tier IS NOT NULL
        GROUP BY qualification_tier
      `;
      for (const r of tierRes.rows) {
        if (tiers[r.tier] !== undefined) tiers[r.tier] = r.c;
      }

      // Status counts
      const statusRes = await client.queryObject`
        SELECT status, COUNT(*)::int AS c
        FROM leads WHERE client_id = ${client_id} AND status IS NOT NULL
        GROUP BY status
      `;
      for (const r of statusRes.rows) statusCounts[r.status] = r.c;

      // Ungrouped (no group_ids) — group_ids is a text[] column.
      const ungroupedRes = await client.queryObject`
        SELECT COUNT(*)::int AS c FROM leads
        WHERE client_id = ${client_id}
          AND (group_ids IS NULL OR array_length(group_ids, 1) IS NULL)
      `;
      ungrouped = ungroupedRes.rows[0]?.c || 0;

      // Per-group stats — unnest the group_ids text[] array.
      const groupRes = await client.queryObject`
        SELECT gid AS group_id,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE last_call_date IS NOT NULL)::int AS contacted,
               COUNT(*) FILTER (WHERE status = 'converted')::int AS converted
        FROM leads,
             unnest(COALESCE(group_ids, ARRAY[]::text[])) AS gid
        WHERE client_id = ${client_id}
        GROUP BY gid
      `;
      for (const r of groupRes.rows) {
        groups[r.group_id] = { total: r.total, contacted: r.contacted, converted: r.converted };
      }
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }

    return c.json({ data: { stats: { tiers, statusCounts, groups, ungrouped, total } } });
  } catch (error) {
    console.error('pgLeadsStats error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};