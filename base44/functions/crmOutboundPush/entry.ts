import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

/**
 * CRM Outbound Push — Pushes events FROM this platform TO external CRM webhooks.
 *
 * PRODUCTION-GRADE FEATURES:
 *  • 5-second webhook timeout (one slow webhook can't stall the run)
 *  • Exponential backoff retry (1m, 5m, 30m, 2h, 6h, then dead-letter)
 *  • Max 6 attempts → record marked dead-letter (skip forever, log error)
 *  • Uses crm_pushed_at IS NULL as primary filter (not a time window)
 *  • 24h safety upper bound (don't push ancient records on first deploy)
 *  • Per-run budget: 8 calls + 7 leads, 22s deadline
 *
 * TWO MODES:
 *
 * 1) DIRECT INVOCATION (single event):
 *    POST /functions/crmOutboundPush
 *    Body: { client_id, event_type, entity_id, data? }
 *
 * 2) EXTERNAL CRON POLLER (recommended — avoids entity automation credits):
 *    GET /functions/crmOutboundPush?api_key=<CRON_API_KEY>
 */

const WEBHOOK_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 6;
const SAFETY_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h
// Backoff schedule: attempt 1 fails → wait 1m, 2→5m, 3→30m, 4→2h, 5→6h, 6→dead
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];

function nextRetryAt(attemptsSoFar) {
  const idx = Math.min(attemptsSoFar, BACKOFF_MINUTES.length - 1);
  return new Date(Date.now() + BACKOFF_MINUTES[idx] * 60 * 1000).toISOString();
}

function isEligibleForRetry(record) {
  // Never pushed yet → eligible
  if (!record.crm_pushed_at && (record.crm_push_attempts || 0) === 0) return true;
  // Already successfully pushed → skip
  if (record.crm_pushed_at) return false;
  // Dead-letter → skip forever
  if ((record.crm_push_attempts || 0) >= MAX_ATTEMPTS) return false;
  // In backoff window → skip until next_retry_at
  if (record.crm_push_next_retry_at && new Date(record.crm_push_next_retry_at) > new Date()) return false;
  return true;
}

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');

    // ─── MODE 2: External cron poller ───
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronApiKey = url.searchParams.get('api_key');
      const cronSecret = url.searchParams.get('cron_secret');
      const expectedKey = Deno.env.get('CRON_API_KEY');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const isValid = (expectedKey && cronApiKey === expectedKey) ||
                      (expectedSecret && cronSecret === expectedSecret);
      if (!isValid) return Response.json({ error: 'Forbidden' }, { status: 403 });

      const svc = createClient({ appId, asServiceRole: true });
      const runStart = Date.now();
      const RUN_DEADLINE_MS = 22 * 1000;
      const results = { calls_pushed: 0, leads_pushed: 0, calls_failed: 0, leads_failed: 0, dead_lettered: 0, skipped: 0, errors: [] };

      // Build index of active CRM integrations with webhook_url
      const allIntegrations = await svc.entities.CRMIntegration.filter({ status: 'active' });
      const integrationsByClient = {};
      for (const int of allIntegrations) {
        if (!int.webhook_url) continue;
        if (!integrationsByClient[int.client_id]) integrationsByClient[int.client_id] = [];
        integrationsByClient[int.client_id].push(int);
      }
      const activeClientIds = Object.keys(integrationsByClient);
      if (activeClientIds.length === 0) {
        return Response.json({ success: true, message: 'No active CRM integrations with webhook_url' });
      }

      const safetyCutoff = new Date(Date.now() - SAFETY_LOOKBACK_MS).toISOString();

      // ── 1. CallLogs: completed in last 24h, not yet pushed, eligible for retry ──
      const recentCalls = await svc.entities.CallLog.filter(
        { status: 'completed' }, '-updated_date', 200
      );
      const toPushCalls = recentCalls.filter(c =>
        activeClientIds.includes(c.client_id) &&
        (c.updated_date || c.created_date) >= safetyCutoff &&
        isEligibleForRetry(c)
      ).slice(0, 8);

      for (const call of toPushCalls) {
        if (Date.now() - runStart > RUN_DEADLINE_MS) break;
        try {
          const pushResult = await pushToWebhooks(
            svc, integrationsByClient[call.client_id], 'call_completed', call.id, call
          );
          if (pushResult.any_sent) {
            await svc.entities.CallLog.update(call.id, {
              crm_pushed_at: new Date().toISOString(),
              crm_push_attempts: 0,
              crm_push_last_error: '',
              crm_push_next_retry_at: ''
            });
            results.calls_pushed++;
          } else {
            const attempts = (call.crm_push_attempts || 0) + 1;
            const errorMsg = pushResult.results.map(r => `${r.crm}:${r.error || r.http_status}`).join('; ').substring(0, 500);
            if (attempts >= MAX_ATTEMPTS) {
              await svc.entities.CallLog.update(call.id, {
                crm_push_attempts: attempts,
                crm_push_last_error: `DEAD-LETTER: ${errorMsg}`
              });
              results.dead_lettered++;
            } else {
              await svc.entities.CallLog.update(call.id, {
                crm_push_attempts: attempts,
                crm_push_last_error: errorMsg,
                crm_push_next_retry_at: nextRetryAt(attempts)
              });
              results.calls_failed++;
            }
          }
        } catch (e) {
          results.errors.push({ call_id: call.id, error: e.message });
        }
      }

      // ── 2. Leads: touched by a call in last 24h, not yet pushed, eligible for retry ──
      const recentLeads = await svc.entities.Lead.filter({}, '-updated_date', 200);
      const toPushLeads = recentLeads.filter(l =>
        activeClientIds.includes(l.client_id) &&
        (l.updated_date || l.created_date) >= safetyCutoff &&
        l.last_call_date &&
        isEligibleForRetry(l)
      ).slice(0, 7);

      for (const lead of toPushLeads) {
        if (Date.now() - runStart > RUN_DEADLINE_MS) break;
        try {
          const pushResult = await pushToWebhooks(
            svc, integrationsByClient[lead.client_id], 'lead_updated', lead.id, lead
          );
          if (pushResult.any_sent) {
            await svc.entities.Lead.update(lead.id, {
              crm_pushed_at: new Date().toISOString(),
              crm_push_attempts: 0,
              crm_push_last_error: '',
              crm_push_next_retry_at: ''
            });
            results.leads_pushed++;
          } else {
            const attempts = (lead.crm_push_attempts || 0) + 1;
            const errorMsg = pushResult.results.map(r => `${r.crm}:${r.error || r.http_status}`).join('; ').substring(0, 500);
            if (attempts >= MAX_ATTEMPTS) {
              await svc.entities.Lead.update(lead.id, {
                crm_push_attempts: attempts,
                crm_push_last_error: `DEAD-LETTER: ${errorMsg}`
              });
              results.dead_lettered++;
            } else {
              await svc.entities.Lead.update(lead.id, {
                crm_push_attempts: attempts,
                crm_push_last_error: errorMsg,
                crm_push_next_retry_at: nextRetryAt(attempts)
              });
              results.leads_failed++;
            }
          }
        } catch (e) {
          results.errors.push({ lead_id: lead.id, error: e.message });
        }
      }

      const elapsedSec = Math.round((Date.now() - runStart) / 1000);
      console.log(`[crmOutboundPush:CRON] ${elapsedSec}s — pushed C:${results.calls_pushed} L:${results.leads_pushed}, failed C:${results.calls_failed} L:${results.leads_failed}, dead:${results.dead_lettered}`);
      return Response.json({ success: true, elapsed_sec: elapsedSec, ...results });
    }

    // ─── MODE 1: Direct invocation (single event) ───
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const payload = await req.json();
    let { client_id, event_type, entity_id, data: overrideData } = payload;

    if (!client_id) {
      const authKey = req.headers.get('x-auth-key');
      const apiKey = req.headers.get('x-api-key');
      if (authKey) {
        const matched = await svc.entities.Client.filter({ api_auth_key: authKey });
        if (matched.length > 0) client_id = matched[0].id;
      } else if (apiKey) {
        const integrations = await svc.entities.CRMIntegration.filter({ api_key: apiKey, status: 'active' });
        if (integrations.length > 0) client_id = integrations[0].client_id;
      }
    }

    if (!client_id || !event_type) {
      return Response.json({ error: 'Missing client_id or event_type' }, { status: 400 });
    }

    // ─── CRM API access gate: admin must activate this client ───
    const clientRec = await svc.entities.Client.get(client_id).catch(() => null);
    const accessStatus = clientRec?.crm_api_access_status || 'not_requested';
    if (accessStatus !== 'active') {
      return Response.json({
        error: 'CRM Integration API access is not active for this client.',
        access_status: accessStatus
      }, { status: 403 });
    }

    const integrations = await svc.entities.CRMIntegration.filter({ client_id, status: 'active' });
    if (integrations.length === 0) {
      return Response.json({ success: true, skipped: 'no_active_integration' });
    }

    let entityData = overrideData || {};
    if (entity_id && !overrideData) entityData = await fetchEntityData(svc, event_type, entity_id);

    const pushResult = await pushToWebhooks(svc, integrations, event_type, entity_id, entityData);
    return Response.json({ success: true, event_type, results: pushResult.results });

  } catch (error) {
    console.error('[crmOutboundPush] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// ─── Shared webhook delivery helper (5s timeout per webhook) ───
async function pushToWebhooks(svc, integrations, eventType, entityId, entityData) {
  const results = [];
  let any_sent = false;
  for (const integration of integrations) {
    if (!integration.webhook_url) {
      results.push({ crm: integration.crm_type, status: 'skipped', reason: 'no_webhook_url' });
      continue;
    }
    const fieldMapping = integration.field_mapping || {};
    const reverseMapping = fieldMapping.outbound || fieldMapping['*_reverse'] || {};
    const mappedData = applyReverseMapping(entityData, reverseMapping);

    const webhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      source: 'bolify_ai',
      entity_id: entityId || null,
      data: mappedData
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (integration.api_key) headers['x-api-key'] = integration.api_key;

      const response = await fetch(integration.webhook_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(webhookPayload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
      });
      const responseText = await response.text();
      const success = response.ok;

      results.push({
        crm: integration.crm_type,
        status: success ? 'sent' : 'failed',
        http_status: response.status,
        response: responseText.substring(0, 500)
      });
      if (success) any_sent = true;

      console.log(`[crmOutboundPush] ${eventType} → ${integration.crm_type}: ${response.status}`);
      await svc.entities.CRMIntegration.update(integration.id, {
        last_sync: new Date().toISOString(),
        status: success ? 'active' : 'error'
      }).catch(() => {});
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      results.push({
        crm: integration.crm_type,
        status: 'error',
        error: isTimeout ? `timeout_${WEBHOOK_TIMEOUT_MS}ms` : err.message
      });
      console.error(`[crmOutboundPush] ${integration.crm_type} error: ${err.message}`);
    }
  }
  return { results, any_sent };
}

async function fetchEntityData(svc, eventType, entityId) {
  try {
    if (eventType.startsWith('lead_')) return await svc.entities.Lead.get(entityId);
    if (eventType.startsWith('deal_')) return await svc.entities.Deal.get(entityId);
    if (eventType.startsWith('call_')) return await svc.entities.CallLog.get(entityId);
    if (eventType.startsWith('activity_')) return await svc.entities.Activity.get(entityId);
    if (eventType.startsWith('contact_')) return await svc.entities.Contact.get(entityId);
  } catch (e) {
    console.error(`[crmOutboundPush] Failed to fetch entity: ${e.message}`);
  }
  return {};
}

function applyReverseMapping(data, mapping) {
  if (!mapping || Object.keys(mapping).length === 0) return data;
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    const mappedKey = mapping[key] || key;
    result[mappedKey] = value;
  }
  return result;
}