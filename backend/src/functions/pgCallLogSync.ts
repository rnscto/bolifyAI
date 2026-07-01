import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgCallLogSync — dual-write the Base44 CallLog entity into Azure Postgres.
// ═══════════════════════════════════════════════════════════════════════
// Mirrors ONLY operational fields (no transcript / agent_config_cache blobs)
// into the `call_logs` table. Lets campaign-completion, per-DID and per-agent
// aggregations run as a single SQL query instead of paginating thousands of
// Base44 CallLog reads (kills 429 pressure).
//
// Best-effort: never blocks the CallLog write. Supports:
//   1) Direct call:        { call_log:{...} }  or  { call_logs:[...] }
//   2) Delete:             { delete_id:"..." } or { delete_client_id:"..." }
//   3) Entity-automation:  { event:{type,entity_id}, data, old_data }
// ═══════════════════════════════════════════════════════════════════════

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

async function upsert(client, cl) {
  await client.queryArray`
    INSERT INTO call_logs (
      id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
      callee_number, direction, status, duration, provider, country_code,
      provider_cost, provider_currency, post_processed,
      call_start_time, call_end_time, updated_at
    )
    VALUES (
      ${cl.id}, ${cl.client_id}, ${cl.agent_id || null}, ${cl.lead_id || null},
      ${cl.campaign_id || null}, ${cl.call_sid || null}, ${cl.caller_id || null},
      ${cl.callee_number || null}, ${cl.direction || null}, ${cl.status || null},
      ${cl.duration ?? null}, ${cl.provider || null}, ${cl.country_code || null},
      ${cl.provider_cost ?? null}, ${cl.provider_currency || null},
      ${!!cl.post_processed}, ${cl.call_start_time || null},
      ${cl.call_end_time || null}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      agent_id = EXCLUDED.agent_id,
      lead_id = EXCLUDED.lead_id,
      campaign_id = EXCLUDED.campaign_id,
      call_sid = EXCLUDED.call_sid,
      caller_id = EXCLUDED.caller_id,
      callee_number = EXCLUDED.callee_number,
      direction = EXCLUDED.direction,
      status = EXCLUDED.status,
      duration = EXCLUDED.duration,
      provider = EXCLUDED.provider,
      country_code = EXCLUDED.country_code,
      provider_cost = EXCLUDED.provider_cost,
      provider_currency = EXCLUDED.provider_currency,
      post_processed = EXCLUDED.post_processed,
      call_start_time = EXCLUDED.call_start_time,
      call_end_time = EXCLUDED.call_end_time,
      updated_at = now()
  `;
}

export default async function pgCallLogSync(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));

    // 1) Batch direct call
    if (body.call_logs && Array.isArray(body.call_logs)) {
      const client = pgClient();
      let synced = 0;
      try {
        ; /* client.connect() not needed */
        for (const cl of body.call_logs) {
          if (!cl?.id || !cl.client_id) continue;
          await upsert(client, cl);
          synced++;
        }
        return c.json({ data: { success: true, synced } });
      } finally { try { ; /* client.end() not needed */ } catch (_) {} }
    }

    // 2) Single direct call / delete
    if (body.call_log || body.delete_id || body.delete_client_id) {
      if (body.delete_client_id) {
        const client = pgClient();
        try {
          ; /* client.connect() not needed */
          await client.queryArray`DELETE FROM call_logs WHERE client_id = ${body.delete_client_id}`;
          return c.json({ data: { success: true, deleted_client: body.delete_client_id } });
        } finally { try { ; /* client.end() not needed */ } catch (_) {} }
      }
      if (body.delete_id) {
        const client = pgClient();
        try {
          ; /* client.connect() not needed */
          await client.queryArray`DELETE FROM call_logs WHERE id = ${body.delete_id}`;
          return c.json({ data: { success: true, deleted: body.delete_id } });
        } finally { try { ; /* client.end() not needed */ } catch (_) {} }
      }
      const cl = body.call_log;
      if (!cl?.id || !cl.client_id) return c.json({ data: { success: true, skipped: 'no_id_or_client' } });
      const client = pgClient();
      try {
        ; /* client.connect() not needed */
        await upsert(client, cl);
        return c.json({ data: { success: true, synced: cl.id } });
      } finally { try { ; /* client.end() not needed */ } catch (_) {} }
    }

    // 3) Entity-automation shape
    const event = body.event || {};
    const eventType = event.type; // create | update | delete
    let data = body.data || null;
    const oldData = body.old_data || null;

    if (body.payload_too_large && event.entity_id && eventType !== 'delete') {
      data = await svc.entities.CallLog.get(event.entity_id).catch(() => null);
    }

    const id = event.entity_id || data?.id || oldData?.id;
    if (!id) return c.json({ data: { success: true, skipped: 'no_id' } });

    const client = pgClient();
    try {
      ; /* client.connect() not needed */
      if (eventType === 'delete') {
        await client.queryArray`DELETE FROM call_logs WHERE id = ${id}`;
        return c.json({ data: { success: true, deleted: id } });
      }
      const cl = data || {};
      if (!cl.client_id) return c.json({ data: { success: true, skipped: 'no_client_id' } });
      await upsert(client, { ...cl, id });
      return c.json({ data: { success: true, synced: id } });
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    // best-effort mirror; never blocks the CallLog write
    console.warn(`[pgCallLogSync] skipped: ${error.message}`);
    return c.json({ data: { success: true, skipped: 'error', message: error.message } });
  }

};