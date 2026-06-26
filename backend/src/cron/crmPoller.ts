import { client } from "../db/index.ts";

const WEBHOOK_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 6;
const SAFETY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];

function nextRetryAt(attemptsSoFar: number) {
  const idx = Math.min(attemptsSoFar, BACKOFF_MINUTES.length - 1);
  return new Date(Date.now() + BACKOFF_MINUTES[idx] * 60 * 1000).toISOString();
}

function isEligibleForRetry(record: any) {
  if (!record.crm_pushed_at && (record.crm_push_attempts || 0) === 0) return true;
  if (record.crm_pushed_at) return false;
  if ((record.crm_push_attempts || 0) >= MAX_ATTEMPTS) return false;
  if (record.crm_push_next_retry_at && new Date(record.crm_push_next_retry_at) > new Date()) return false;
  return true;
}

export async function processOutboundPush() {
  const runStart = Date.now();
  const RUN_DEADLINE_MS = 22 * 1000;
  const results: any = { calls_pushed: 0, leads_pushed: 0, calls_failed: 0, leads_failed: 0, dead_lettered: 0, skipped: 0, errors: [] };

  try {
    const allIntegrationsRes = await client.queryObject(`SELECT * FROM crmintegration WHERE status = 'active'`);
    const allIntegrations = allIntegrationsRes.rows as any[];
    
    const integrationsByClient: any = {};
    for (const int of allIntegrations) {
      if (!int.webhook_url) continue;
      if (!integrationsByClient[int.client_id]) integrationsByClient[int.client_id] = [];
      integrationsByClient[int.client_id].push(int);
    }
    const activeClientIds = Object.keys(integrationsByClient);
    if (activeClientIds.length === 0) return;

    const safetyCutoff = new Date(Date.now() - SAFETY_LOOKBACK_MS).toISOString();

    const recentCallsRes = await client.queryObject(`
      SELECT * FROM calllog 
      WHERE status = 'completed' 
        AND client_id = ANY($1) 
        AND COALESCE(updated_date, created_at) >= $2
      ORDER BY COALESCE(updated_date, created_at) DESC 
      LIMIT 100
    `, [activeClientIds, safetyCutoff]);
    
    const toPushCalls = (recentCallsRes.rows as any[]).filter(isEligibleForRetry).slice(0, 8);

    for (const call of toPushCalls) {
      if (Date.now() - runStart > RUN_DEADLINE_MS) break;
      try {
        const pushResult = await pushToWebhooks(integrationsByClient[call.client_id], "call_completed", call.id, call);
        if (pushResult.any_sent) {
          await client.queryObject(`
            UPDATE calllog 
            SET crm_pushed_at = $1, crm_push_attempts = 0, crm_push_last_error = '', crm_push_next_retry_at = NULL 
            WHERE id = $2
          `, [new Date().toISOString(), call.id]);
          results.calls_pushed++;
        } else {
          const attempts = (call.crm_push_attempts || 0) + 1;
          const errorMsg = pushResult.results.map((r: any) => `${r.crm}:${r.error || r.http_status}`).join("; ").substring(0, 500);
          if (attempts >= MAX_ATTEMPTS) {
            await client.queryObject(`
              UPDATE calllog 
              SET crm_push_attempts = $1, crm_push_last_error = $2 
              WHERE id = $3
            `, [attempts, `DEAD-LETTER: ${errorMsg}`, call.id]);
            results.dead_lettered++;
          } else {
            await client.queryObject(`
              UPDATE calllog 
              SET crm_push_attempts = $1, crm_push_last_error = $2, crm_push_next_retry_at = $3 
              WHERE id = $4
            `, [attempts, errorMsg, nextRetryAt(attempts), call.id]);
            results.calls_failed++;
          }
        }
      } catch (e: any) {
        results.errors.push({ call_id: call.id, error: e.message });
      }
    }

    const recentLeadsRes = await client.queryObject(`
      SELECT * FROM lead 
      WHERE client_id = ANY($1) 
        AND COALESCE(updated_date, created_at) >= $2 
        AND last_call_date IS NOT NULL
      ORDER BY COALESCE(updated_date, created_at) DESC 
      LIMIT 100
    `, [activeClientIds, safetyCutoff]);

    const toPushLeads = (recentLeadsRes.rows as any[]).filter(isEligibleForRetry).slice(0, 7);

    for (const lead of toPushLeads) {
      if (Date.now() - runStart > RUN_DEADLINE_MS) break;
      try {
        const pushResult = await pushToWebhooks(integrationsByClient[lead.client_id], "lead_updated", lead.id, lead);
        if (pushResult.any_sent) {
          await client.queryObject(`
            UPDATE lead 
            SET crm_pushed_at = $1, crm_push_attempts = 0, crm_push_last_error = '', crm_push_next_retry_at = NULL 
            WHERE id = $2
          `, [new Date().toISOString(), lead.id]);
          results.leads_pushed++;
        } else {
          const attempts = (lead.crm_push_attempts || 0) + 1;
          const errorMsg = pushResult.results.map((r: any) => `${r.crm}:${r.error || r.http_status}`).join("; ").substring(0, 500);
          if (attempts >= MAX_ATTEMPTS) {
            await client.queryObject(`
              UPDATE lead 
              SET crm_push_attempts = $1, crm_push_last_error = $2 
              WHERE id = $3
            `, [attempts, `DEAD-LETTER: ${errorMsg}`, lead.id]);
            results.dead_lettered++;
          } else {
            await client.queryObject(`
              UPDATE lead 
              SET crm_push_attempts = $1, crm_push_last_error = $2, crm_push_next_retry_at = $3 
              WHERE id = $4
            `, [attempts, errorMsg, nextRetryAt(attempts), lead.id]);
            results.leads_failed++;
          }
        }
      } catch (e: any) {
        results.errors.push({ lead_id: lead.id, error: e.message });
      }
    }
  } catch (err: any) {
    console.error("[CRON crmPoller] Error:", err.message);
  }
}

async function pushToWebhooks(integrations: any[], eventType: string, entityId: string, entityData: any) {
  const results = [];
  let any_sent = false;
  for (const integration of integrations) {
    if (!integration.webhook_url) continue;

    const payload = { event: eventType, timestamp: new Date().toISOString(), source: "bolify_ai", entity_id: entityId || null, data: entityData };
    try {
      const headers: any = { "Content-Type": "application/json" };
      if (integration.api_key) headers["x-api-key"] = integration.api_key;
      const res = await fetch(integration.webhook_url, {
        method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
      });
      const responseText = await res.text();
      results.push({ crm: integration.crm_type, status: res.ok ? "sent" : "failed", http_status: res.status, response: responseText.substring(0, 500) });
      if (res.ok) any_sent = true;
      await client.queryObject(`
        UPDATE crmintegration 
        SET last_sync = $1, status = $2 
        WHERE id = $3
      `, [new Date().toISOString(), res.ok ? 'active' : 'error', integration.id]);
    } catch (err: any) {
      results.push({ crm: integration.crm_type, status: "error", error: err.message });
    }
  }
  return { results, any_sent };
}

export function initCrmPoller() {
  setInterval(() => {
    processOutboundPush().catch(console.error);
  }, 60 * 1000); // Check every minute
}
