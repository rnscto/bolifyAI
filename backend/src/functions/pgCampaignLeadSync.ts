import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgCampaignLeadSync — dual-write the Base44 CampaignLead entity into Azure
// Postgres `campaign_leads`.
// ═══════════════════════════════════════════════════════════════════════
// Mirrors ONLY operational fields (no transcript / conversation_summary blobs)
// so campaign completion checks + next-batch selection run as single SQL
// queries instead of paginating thousands of CampaignLead reads per poll.
//
// Best-effort: never blocks the CampaignLead write. Supports:
//   1) Direct call:        { campaign_lead:{...} } or { campaign_leads:[...] }
//   2) Delete:             { delete_id:"..." } or { delete_campaign_id:"..." }
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

// CampaignLead is PG-primary. The upsert carries the FULL result set (operational
// + display fields). To support partial updates (callers that only send a few
// changed fields), every display column uses COALESCE(EXCLUDED.x, existing.x) so
// an omitted field never wipes a previously-stored value.
async function upsert(client, cl) {
  const has = (k) => Object.prototype.hasOwnProperty.call(cl, k);
  // `followupTouched` lets a full update clear followup_call_date (set null) while
  // a partial update that omits the field preserves the existing value.
  const followupTouched = has('followup_call_date');
  const followupVal = followupTouched ? (cl.followup_call_date || null) : null;
  await client.queryArray`
    INSERT INTO campaign_leads (
      id, campaign_id, client_id, lead_id, status, outcome, call_log_id,
      attempt_count, lead_name, lead_phone, followup_call_date,
      transcript, conversation_summary, call_duration, call_status,
      followup_email_sent, followup_scheduled, created_date, updated_at
    )
    VALUES (
      ${cl.id}, ${cl.campaign_id}, ${cl.client_id || null}, ${cl.lead_id || null},
      ${cl.status || null}, ${cl.outcome || null}, ${cl.call_log_id || null},
      ${cl.attempt_count ?? null}, ${cl.lead_name || null}, ${cl.lead_phone || null},
      ${followupVal},
      ${has('transcript') ? cl.transcript : null},
      ${has('conversation_summary') ? cl.conversation_summary : null},
      ${cl.call_duration ?? null}, ${cl.call_status || null},
      ${has('followup_email_sent') ? !!cl.followup_email_sent : null},
      ${has('followup_scheduled') ? !!cl.followup_scheduled : null},
      ${cl.created_date || null}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      campaign_id = EXCLUDED.campaign_id,
      client_id = COALESCE(EXCLUDED.client_id, campaign_leads.client_id),
      lead_id = COALESCE(EXCLUDED.lead_id, campaign_leads.lead_id),
      status = COALESCE(EXCLUDED.status, campaign_leads.status),
      outcome = COALESCE(EXCLUDED.outcome, campaign_leads.outcome),
      call_log_id = COALESCE(EXCLUDED.call_log_id, campaign_leads.call_log_id),
      attempt_count = COALESCE(EXCLUDED.attempt_count, campaign_leads.attempt_count),
      lead_name = COALESCE(EXCLUDED.lead_name, campaign_leads.lead_name),
      lead_phone = COALESCE(EXCLUDED.lead_phone, campaign_leads.lead_phone),
      followup_call_date = CASE WHEN ${followupTouched} THEN EXCLUDED.followup_call_date ELSE campaign_leads.followup_call_date END,
      transcript = COALESCE(EXCLUDED.transcript, campaign_leads.transcript),
      conversation_summary = COALESCE(EXCLUDED.conversation_summary, campaign_leads.conversation_summary),
      call_duration = COALESCE(EXCLUDED.call_duration, campaign_leads.call_duration),
      call_status = COALESCE(EXCLUDED.call_status, campaign_leads.call_status),
      followup_email_sent = COALESCE(EXCLUDED.followup_email_sent, campaign_leads.followup_email_sent),
      followup_scheduled = COALESCE(EXCLUDED.followup_scheduled, campaign_leads.followup_scheduled),
      created_date = COALESCE(EXCLUDED.created_date, campaign_leads.created_date),
      updated_at = now()
  `;
}

export default async function pgCampaignLeadSync(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));

    // 1) Batch direct call — used by campaign creation. This is the AUTHORITATIVE
    //    write (PG is the source of truth the dialer reads), so a failure here is
    //    NOT best-effort: surface it (HTTP 500) so the caller can retry/alert
    //    instead of silently creating a campaign whose leads never reached PG.
    if (body.campaign_leads && Array.isArray(body.campaign_leads)) {
      const rows = body.campaign_leads.filter((cl) => cl?.id && cl.campaign_id);
      if (rows.length === 0) return c.json({ data: { success: true, synced: 0 } });
      const client = pgClient();
      try {
        ; /* client.connect() not needed */
        // Fast path: insert ALL rows for this chunk in a SINGLE multi-row INSERT
        // instead of one round-trip per row. These are brand-new campaign rows so
        // a plain insert with ON CONFLICT DO NOTHING is correct and much faster.
        const SUB = 1000; // rows per SQL statement (param-count safe)
        let synced = 0;
        for (let i = 0; i < rows.length; i += SUB) {
          const slice = rows.slice(i, i + SUB);
          const values = [];
          const params = [];
          let p = 1;
          for (const cl of slice) {
            values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, now())`);
            params.push(
              cl.id, cl.campaign_id, cl.client_id || null, cl.lead_id || null,
              cl.status || 'pending', cl.lead_name || null, cl.lead_phone || null
            );
          }
          await client.queryArray(
            `INSERT INTO campaign_leads
               (id, campaign_id, client_id, lead_id, status, lead_name, lead_phone, updated_at)
             VALUES ${values.join(',')}
             ON CONFLICT (id) DO NOTHING`,
            params
          );
          synced += slice.length;
        }
        return c.json({ data: { success: true, synced } });
      } catch (e) {
        console.error(`[pgCampaignLeadSync] BATCH write failed: ${e.message}`);
        return c.json({ data: { success: false, error: e.message, synced: 0 } }, 500);
      } finally { try { ; /* client.end() not needed */ } catch (_) {} }
    }

    // 1.5) Clear retry schedule for a whole campaign ("Call All Now").
    // PG-primary: flips all future-dated pending retries to call-ready in ONE
    // SQL statement (no Base44 pagination). Best-effort mirror to Base44 is done
    // by the caller separately.
    if (body.clear_retry_campaign_id) {
      const client = pgClient();
      try {
        ; /* client.connect() not needed */
        const res = await client.queryObject`
          UPDATE campaign_leads
            SET followup_call_date = NULL, updated_at = now()
          WHERE campaign_id = ${body.clear_retry_campaign_id}
            AND status = 'pending'
            AND followup_call_date IS NOT NULL
          RETURNING id`;
        return c.json({ data: { success: true, cleared: res.rows.length, ids: res.rows.map(r => r.id) } });
      } finally { try { ; /* client.end() not needed */ } catch (_) {} }
    }

    // 2) Single direct call / delete
    if (body.campaign_lead || body.delete_id || body.delete_campaign_id) {
      if (body.delete_campaign_id) {
        const client = pgClient();
        try {
          ; /* client.connect() not needed */
          await client.queryArray`DELETE FROM campaign_leads WHERE campaign_id = ${body.delete_campaign_id}`;
          return c.json({ data: { success: true, deleted_campaign: body.delete_campaign_id } });
        } finally { try { ; /* client.end() not needed */ } catch (_) {} }
      }
      if (body.delete_id) {
        const client = pgClient();
        try {
          ; /* client.connect() not needed */
          await client.queryArray`DELETE FROM campaign_leads WHERE id = ${body.delete_id}`;
          return c.json({ data: { success: true, deleted: body.delete_id } });
        } finally { try { ; /* client.end() not needed */ } catch (_) {} }
      }
      const cl = body.campaign_lead;
      if (!cl?.id || !cl.campaign_id) return c.json({ data: { success: true, skipped: 'no_id_or_campaign' } });
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
      data = await svc.entities.CampaignLead.get(event.entity_id).catch(() => null);
    }

    const id = event.entity_id || data?.id || oldData?.id;
    if (!id) return c.json({ data: { success: true, skipped: 'no_id' } });

    const client = pgClient();
    try {
      ; /* client.connect() not needed */
      if (eventType === 'delete') {
        await client.queryArray`DELETE FROM campaign_leads WHERE id = ${id}`;
        return c.json({ data: { success: true, deleted: id } });
      }
      const cl = data || {};
      if (!cl.campaign_id) return c.json({ data: { success: true, skipped: 'no_campaign_id' } });
      await upsert(client, { ...cl, id });
      return c.json({ data: { success: true, synced: id } });
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    // best-effort mirror; never blocks the CampaignLead write
    console.warn(`[pgCampaignLeadSync] skipped: ${error.message}`);
    return c.json({ data: { success: true, skipped: 'error', message: error.message } });
  }

};