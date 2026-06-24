import { base44ORM as base44 } from "../db/orm.ts";

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
    const allIntegrations = await base44.entities.CRMIntegration.filter({ status: "active" });
    const integrationsByClient: any = {};
    for (const int of allIntegrations) {
      if (!int.webhook_url) continue;
      if (!integrationsByClient[int.client_id]) integrationsByClient[int.client_id] = [];
      integrationsByClient[int.client_id].push(int);
    }
    const activeClientIds = Object.keys(integrationsByClient);
    if (activeClientIds.length === 0) return;

    const safetyCutoff = new Date(Date.now() - SAFETY_LOOKBACK_MS).toISOString();

    const recentCalls = await base44.entities.CallLog.filter({ status: "completed" }, "-updated_date", 200);
    const toPushCalls = recentCalls.filter((c: any) =>
      activeClientIds.includes(c.client_id) && (c.updated_date || c.created_date) >= safetyCutoff && isEligibleForRetry(c)
    ).slice(0, 8);

    for (const call of toPushCalls) {
      if (Date.now() - runStart > RUN_DEADLINE_MS) break;
      try {
        const pushResult = await pushToWebhooks(integrationsByClient[call.client_id], "call_completed", call.id, call);
        if (pushResult.any_sent) {
          await base44.entities.CallLog.update(call.id, { crm_pushed_at: new Date().toISOString(), crm_push_attempts: 0, crm_push_last_error: "", crm_push_next_retry_at: "" });
          results.calls_pushed++;
        } else {
          const attempts = (call.crm_push_attempts || 0) + 1;
          const errorMsg = pushResult.results.map((r: any) => `${r.crm}:${r.error || r.http_status}`).join("; ").substring(0, 500);
          if (attempts >= MAX_ATTEMPTS) {
            await base44.entities.CallLog.update(call.id, { crm_push_attempts: attempts, crm_push_last_error: `DEAD-LETTER: ${errorMsg}` });
            results.dead_lettered++;
          } else {
            await base44.entities.CallLog.update(call.id, { crm_push_attempts: attempts, crm_push_last_error: errorMsg, crm_push_next_retry_at: nextRetryAt(attempts) });
            results.calls_failed++;
          }
        }
      } catch (e: any) {
        results.errors.push({ call_id: call.id, error: e.message });
      }
    }

    const recentLeads = await base44.entities.Lead.filter({}, "-updated_date", 200);
    const toPushLeads = recentLeads.filter((l: any) =>
      activeClientIds.includes(l.client_id) && (l.updated_date || l.created_date) >= safetyCutoff && l.last_call_date && isEligibleForRetry(l)
    ).slice(0, 7);

    for (const lead of toPushLeads) {
      if (Date.now() - runStart > RUN_DEADLINE_MS) break;
      try {
        const pushResult = await pushToWebhooks(integrationsByClient[lead.client_id], "lead_updated", lead.id, lead);
        if (pushResult.any_sent) {
          await base44.entities.Lead.update(lead.id, { crm_pushed_at: new Date().toISOString(), crm_push_attempts: 0, crm_push_last_error: "", crm_push_next_retry_at: "" });
          results.leads_pushed++;
        } else {
          const attempts = (lead.crm_push_attempts || 0) + 1;
          const errorMsg = pushResult.results.map((r: any) => `${r.crm}:${r.error || r.http_status}`).join("; ").substring(0, 500);
          if (attempts >= MAX_ATTEMPTS) {
            await base44.entities.Lead.update(lead.id, { crm_push_attempts: attempts, crm_push_last_error: `DEAD-LETTER: ${errorMsg}` });
            results.dead_lettered++;
          } else {
            await base44.entities.Lead.update(lead.id, { crm_push_attempts: attempts, crm_push_last_error: errorMsg, crm_push_next_retry_at: nextRetryAt(attempts) });
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
      await base44.entities.CRMIntegration.update(integration.id, { last_sync: new Date().toISOString(), status: res.ok ? "active" : "error" });
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
