import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

/**
 * CRM Outbound Push — Pushes events FROM this platform TO external CRM webhooks.
 * 
 * TWO MODES:
 * 
 * 1) DIRECT INVOCATION (single event):
 *    POST /functions/crmOutboundPush
 *    Body: { client_id, event_type, entity_id, data? }
 *    Pushes ONE event to the client's webhook.
 * 
 * 2) EXTERNAL CRON POLLER (recommended — avoids entity automation credits):
 *    GET /functions/crmOutboundPush?api_key=<CRON_API_KEY>
 *    Scans for:
 *      - CallLogs that became 'completed' / 'failed' / 'no_answer' in the last 30 min
 *        and haven't been pushed yet → pushes 'call_completed'
 *      - Leads whose status/score/sentiment changed in the last 30 min and
 *        haven't been pushed for that change → pushes 'lead_updated'
 *    Marks each record as synced via custom_fields.crm_pushed_at (Lead) /
 *    a transferred_to-style tag on CallLog (we use a dedicated field).
 *    Cap: 15 events per run to fit cron 30s timeout.
 */
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
      if (!isValid) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }

      const svc = createClient({ appId, asServiceRole: true });
      const runStart = Date.now();
      const RUN_DEADLINE_MS = 22 * 1000;
      const results = { calls_pushed: 0, leads_pushed: 0, skipped: 0, errors: [] };

      // Build a quick index of active CRM integrations (client_id → integration[])
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

      // ── 1. Find recent CallLogs that haven't been pushed ──
      const cutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const recentCalls = await svc.entities.CallLog.filter(
        { status: 'completed' }, '-updated_date', 100
      );
      const toPushCalls = recentCalls.filter(c =>
        activeClientIds.includes(c.client_id) &&
        (c.updated_date || c.created_date) >= cutoffIso &&
        !c.crm_pushed_at
      ).slice(0, 8);

      for (const call of toPushCalls) {
        if (Date.now() - runStart > RUN_DEADLINE_MS) break;
        try {
          const pushResult = await pushToWebhooks(
            svc, integrationsByClient[call.client_id], 'call_completed', call.id, call
          );
          if (pushResult.any_sent) {
            await svc.entities.CallLog.update(call.id, { crm_pushed_at: new Date().toISOString() });
            results.calls_pushed++;
          } else {
            results.skipped++;
          }
        } catch (e) {
          results.errors.push({ call_id: call.id, error: e.message });
        }
      }

      // ── 2. Find recent Lead updates that haven't been pushed (for this change) ──
      const recentLeads = await svc.entities.Lead.filter({}, '-updated_date', 100);
      const toPushLeads = recentLeads.filter(l =>
        activeClientIds.includes(l.client_id) &&
        (l.updated_date || l.created_date) >= cutoffIso &&
        l.last_call_date && // only leads that were touched by a call
        (!l.crm_pushed_at || new Date(l.crm_pushed_at) < new Date(l.updated_date))
      ).slice(0, 7);

      for (const lead of toPushLeads) {
        if (Date.now() - runStart > RUN_DEADLINE_MS) break;
        try {
          const pushResult = await pushToWebhooks(
            svc, integrationsByClient[lead.client_id], 'lead_updated', lead.id, lead
          );
          if (pushResult.any_sent) {
            await svc.entities.Lead.update(lead.id, { crm_pushed_at: new Date().toISOString() });
            results.leads_pushed++;
          } else {
            results.skipped++;
          }
        } catch (e) {
          results.errors.push({ lead_id: lead.id, error: e.message });
        }
      }

      const elapsedSec = Math.round((Date.now() - runStart) / 1000);
      console.log(`[crmOutboundPush:CRON] Done in ${elapsedSec}s. Calls:${results.calls_pushed} Leads:${results.leads_pushed} Errors:${results.errors.length}`);
      return Response.json({ success: true, elapsed_sec: elapsedSec, ...results });
    }

    // ─── MODE 1: Direct invocation (single event) ───
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    const payload = await req.json();
    let { client_id, event_type, entity_id, data: overrideData } = payload;

    // Support x-auth-key / x-api-key for external callers
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

    const integrations = await svc.entities.CRMIntegration.filter({
      client_id, status: 'active'
    });

    if (integrations.length === 0) {
      return Response.json({ success: true, skipped: 'no_active_integration' });
    }

    let entityData = overrideData || {};
    if (entity_id && !overrideData) {
      entityData = await fetchEntityData(svc, event_type, entity_id);
    }

    const pushResult = await pushToWebhooks(svc, integrations, event_type, entity_id, entityData);
    return Response.json({ success: true, event_type, results: pushResult.results });

  } catch (error) {
    console.error('[crmOutboundPush] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// ─── Shared webhook delivery helper ───
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
        method: 'POST', headers, body: JSON.stringify(webhookPayload)
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
      });
    } catch (err) {
      results.push({ crm: integration.crm_type, status: 'error', error: err.message });
      console.error(`[crmOutboundPush] Error pushing to ${integration.crm_type}: ${err.message}`);
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