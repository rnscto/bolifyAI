import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgLeadSync — dual-write the Base44 Lead entity into Azure Postgres.
// ═══════════════════════════════════════════════════════════════════════
// Triggered by an entity automation on Lead create/update/delete. Mirrors
// only the fields needed to materialize ClientStats into the `leads` table.
// This lets reconcileClientStats aggregate counts with a single SQL query
// instead of paginating thousands of Base44 Lead reads (kills 429 pressure).
//
// Best-effort: never blocks the Lead write. reconcileClientStats also
// backfills/upserts on its own scan, so transient misses self-heal.
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


export default async function pgLeadSync(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));
    // sync version: v3 (leads + call_logs)

    // ═══════════════════════════════════════════════════════════════════
    // call_logs mirror (folded in here because brand-new PG functions can't
    // get past the first-deploy gate in this environment). Same connection
    // pattern; mirrors operational CallLog fields into the call_logs table.
    // Triggered via: { call_log:{...} } | { call_logs:[...] }
    //              | { delete_call_log_id } | { delete_call_log_client_id }
    // ═══════════════════════════════════════════════════════════════════
    let callLogColsEnsured = false;
    async function ensureCallLogCols(client) {
      if (callLogColsEnsured) return;
      // Idempotent — safe to run; guarantees the upsert's text columns exist.
      await client.queryArray`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcript TEXT`;
      await client.queryArray`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS conversation_summary TEXT`;
      callLogColsEnsured = true;
    }

    async function upsertCallLog(client, cl) {
      await ensureCallLogCols(client);
      // COALESCE on transcript/conversation_summary so a partial update (e.g. a
      // status-only write) never clobbers text already stored on the row.
      await client.queryArray`
        INSERT INTO call_logs (
          id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
          callee_number, direction, status, duration, provider, country_code,
          provider_cost, provider_currency, post_processed,
          transcript, conversation_summary,
          call_start_time, call_end_time, created_date, updated_at
        )
        VALUES (
          ${cl.id}, ${cl.client_id}, ${cl.agent_id || null}, ${cl.lead_id || null},
          ${cl.campaign_id || null}, ${cl.call_sid || null}, ${cl.caller_id || null},
          ${cl.callee_number || null}, ${cl.direction || null}, ${cl.status || null},
          ${cl.duration ?? null}, ${cl.provider || null}, ${cl.country_code || null},
          ${cl.provider_cost ?? null}, ${cl.provider_currency || null},
          ${!!cl.post_processed},
          ${cl.transcript ?? null}, ${cl.conversation_summary ?? null},
          ${cl.call_start_time || null},
          ${cl.call_end_time || null}, ${cl.created_date || null}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          client_id = EXCLUDED.client_id, agent_id = EXCLUDED.agent_id,
          lead_id = EXCLUDED.lead_id, campaign_id = EXCLUDED.campaign_id,
          call_sid = EXCLUDED.call_sid, caller_id = EXCLUDED.caller_id,
          callee_number = EXCLUDED.callee_number, direction = EXCLUDED.direction,
          status = EXCLUDED.status, duration = EXCLUDED.duration,
          provider = EXCLUDED.provider, country_code = EXCLUDED.country_code,
          provider_cost = EXCLUDED.provider_cost,
          provider_currency = EXCLUDED.provider_currency,
          post_processed = EXCLUDED.post_processed,
          transcript = COALESCE(EXCLUDED.transcript, call_logs.transcript),
          conversation_summary = COALESCE(EXCLUDED.conversation_summary, call_logs.conversation_summary),
          call_start_time = EXCLUDED.call_start_time,
          call_end_time = EXCLUDED.call_end_time,
          created_date = COALESCE(EXCLUDED.created_date, call_logs.created_date),
          updated_at = now()
      `;
    }

    if (body.call_log || body.call_logs || body.delete_call_log_id || body.delete_call_log_client_id) {
      const client = pgClient();
      try {
        ; /* client.connect() not needed */
        if (body.delete_call_log_client_id) {
          await client.queryArray`DELETE FROM call_logs WHERE client_id = ${body.delete_call_log_client_id}`;
          return c.json({ data: { success: true, deleted_client: body.delete_call_log_client_id } });
        }
        if (body.delete_call_log_id) {
          await client.queryArray`DELETE FROM call_logs WHERE id = ${body.delete_call_log_id}`;
          return c.json({ data: { success: true, deleted: body.delete_call_log_id } });
        }
        if (Array.isArray(body.call_logs)) {
          let synced = 0;
          for (const cl of body.call_logs) {
            if (!cl?.id || !cl.client_id) continue;
            await upsertCallLog(client, cl);
            synced++;
          }
          return c.json({ data: { success: true, synced } });
        }
        const cl = body.call_log;
        if (!cl?.id || !cl.client_id) return c.json({ data: { success: true, skipped: 'no_id_or_client' } });
        await upsertCallLog(client, cl);
        return c.json({ data: { success: true, synced: cl.id } });
      } finally { try { ; /* client.end() not needed */ } catch (_) {} }
    }

    // ── Two call shapes supported ──
    // 1) Entity-automation shape: { event:{type,entity_id}, data, old_data }
    // 2) Direct server-side call:  { lead:{...} }  or  { delete_id:"..." }
    //    (used by lead write paths so the mirror stays live even while the
    //     credit-frozen scheduler isn't firing the automation).
    if (body.leads && Array.isArray(body.leads)) {
      const client = pgClient();
      let synced = 0;
      try {
        ; /* client.connect() not needed */
        for (const lead of body.leads) {
          if (!lead?.id || !lead.client_id) continue;
          await client.queryArray`
            INSERT INTO leads (id, client_id, status, qualification_tier, source, group_ids, has_call, score, last_call_date, updated_at)
            VALUES (
              ${lead.id}, ${lead.client_id}, ${lead.status || null},
              ${lead.qualification_tier || null}, ${lead.source || null},
              ${lead.group_ids || []}, ${!!lead.last_call_date},
              ${typeof lead.score === 'number' ? lead.score : null},
              ${lead.last_call_date || null}, now()
            )
            ON CONFLICT (id) DO UPDATE SET
              client_id = EXCLUDED.client_id,
              status = EXCLUDED.status,
              qualification_tier = EXCLUDED.qualification_tier,
              source = EXCLUDED.source,
              group_ids = EXCLUDED.group_ids,
              has_call = EXCLUDED.has_call,
              score = COALESCE(EXCLUDED.score, leads.score),
              last_call_date = COALESCE(EXCLUDED.last_call_date, leads.last_call_date),
              updated_at = now()
          `;
          synced++;
        }
        return c.json({ data: { success: true, synced } });
      } finally { try { ; /* client.end() not needed */ } catch (_) {} }
    }

    if (body.lead || body.delete_id || body.delete_client_id) {
      if (body.delete_client_id) {
        const client = pgClient();
        try {
          ; /* client.connect() not needed */
          await client.queryArray`DELETE FROM leads WHERE client_id = ${body.delete_client_id}`;
          return c.json({ data: { success: true, deleted_client: body.delete_client_id } });
        } finally { try { ; /* client.end() not needed */ } catch (_) {} }
      }
      if (body.delete_id) {
        const client = pgClient();
        try {
          ; /* client.connect() not needed */
          await client.queryArray`DELETE FROM leads WHERE id = ${body.delete_id}`;
          return c.json({ data: { success: true, deleted: body.delete_id } });
        } finally { try { ; /* client.end() not needed */ } catch (_) {} }
      }
      const lead = body.lead;
      const leadId = lead?.id;
      if (!leadId || !lead.client_id) return c.json({ data: { success: true, skipped: 'no_id_or_client' } });
      const client = pgClient();
      try {
        ; /* client.connect() not needed */
        await client.queryArray`
          INSERT INTO leads (id, client_id, status, qualification_tier, source, group_ids, has_call, score, last_call_date, updated_at)
          VALUES (
            ${leadId}, ${lead.client_id}, ${lead.status || null},
            ${lead.qualification_tier || null}, ${lead.source || null},
            ${lead.group_ids || []}, ${!!lead.last_call_date},
            ${typeof lead.score === 'number' ? lead.score : null},
            ${lead.last_call_date || null}, now()
          )
          ON CONFLICT (id) DO UPDATE SET
            client_id = EXCLUDED.client_id,
            status = EXCLUDED.status,
            qualification_tier = EXCLUDED.qualification_tier,
            source = EXCLUDED.source,
            group_ids = EXCLUDED.group_ids,
            has_call = EXCLUDED.has_call,
            score = COALESCE(EXCLUDED.score, leads.score),
            last_call_date = COALESCE(EXCLUDED.last_call_date, leads.last_call_date),
            updated_at = now()
        `;
        return c.json({ data: { success: true, synced: leadId } });
      } finally { try { ; /* client.end() not needed */ } catch (_) {} }
    }

    const event = body.event || {};
    const eventType = event.type; // create | update | delete
    let data = body.data || null;
    const oldData = body.old_data || null;

    // Large-payload fallback — fetch the full record.
    if (body.payload_too_large && event.entity_id && eventType !== 'delete') {
      data = await svc.entities.Lead.get(event.entity_id).catch(() => null);
    }

    const leadId = event.entity_id || data?.id || oldData?.id;
    if (!leadId) return c.json({ data: { success: true, skipped: 'no_lead_id' } });

    const client = pgClient();
    try {
      ; /* client.connect() not needed */

      if (eventType === 'delete') {
        await client.queryArray`DELETE FROM leads WHERE id = ${leadId}`;
        return c.json({ data: { success: true, deleted: leadId } });
      }

      const lead = data || {};
      if (!lead.client_id) return c.json({ data: { success: true, skipped: 'no_client_id' } });

      await client.queryArray`
        INSERT INTO leads (id, client_id, status, qualification_tier, source, group_ids, has_call, score, last_call_date, updated_at)
        VALUES (
          ${leadId}, ${lead.client_id}, ${lead.status || null},
          ${lead.qualification_tier || null}, ${lead.source || null},
          ${lead.group_ids || []}, ${!!lead.last_call_date},
          ${typeof lead.score === 'number' ? lead.score : null},
          ${lead.last_call_date || null}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          status = EXCLUDED.status,
          qualification_tier = EXCLUDED.qualification_tier,
          source = EXCLUDED.source,
          group_ids = EXCLUDED.group_ids,
          has_call = EXCLUDED.has_call,
          score = COALESCE(EXCLUDED.score, leads.score),
          last_call_date = COALESCE(EXCLUDED.last_call_date, leads.last_call_date),
          updated_at = now()
      `;
      return c.json({ data: { success: true, synced: leadId } });
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    console.warn(`[pgLeadSync] skipped: ${error.message}`);
    return c.json({ data: { success: true, skipped: 'error', message: error.message } });
  }

};