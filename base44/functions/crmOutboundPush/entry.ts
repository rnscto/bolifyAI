import { createClient } from 'npm:@base44/sdk@0.8.23';

/**
 * CRM Outbound Push — Pushes data FROM this platform TO external CRM webhooks.
 * Called by entity automations or manually from frontend.
 * 
 * POST /functions/crmOutboundPush
 * Body: {
 *   "client_id": "...",
 *   "event_type": "lead_created" | "lead_updated" | "deal_created" | "deal_updated" | "call_completed" | "activity_created",
 *   "entity_id": "...",
 *   "data": { ...optional override data... }
 * }
 */
Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const payload = await req.json();
    let { client_id, event_type, entity_id, data: overrideData } = payload;

    // Support x-auth-key for external callers who don't know their client_id
    if (!client_id) {
      const authKey = req.headers.get('x-auth-key');
      const apiKey = req.headers.get('x-api-key');
      if (authKey) {
        const matched = await base44.entities.Client.filter({ api_auth_key: authKey });
        if (matched.length > 0) client_id = matched[0].id;
      } else if (apiKey) {
        const integrations = await base44.entities.CRMIntegration.filter({ api_key: apiKey, status: 'active' });
        if (integrations.length > 0) client_id = integrations[0].client_id;
      }
    }

    if (!client_id || !event_type) {
      return Response.json({ error: 'Missing client_id or event_type' }, { status: 400 });
    }

    // Find active CRM integrations for this client
    const integrations = await base44.entities.CRMIntegration.filter({
      client_id: client_id,
      status: 'active'
    });

    if (integrations.length === 0) {
      return Response.json({ success: true, skipped: 'no_active_integration' });
    }

    // Fetch entity data if entity_id provided
    let entityData = overrideData || {};
    if (entity_id && !overrideData) {
      entityData = await fetchEntityData(base44, event_type, entity_id);
    }

    // Push to each active CRM integration
    const results = [];
    for (const integration of integrations) {
      if (!integration.webhook_url) {
        results.push({ crm: integration.crm_type, status: 'skipped', reason: 'no_webhook_url' });
        continue;
      }

      // Apply reverse field mapping (internal → external CRM fields)
      const fieldMapping = integration.field_mapping || {};
      const reverseMapping = fieldMapping.outbound || fieldMapping['*_reverse'] || {};
      const mappedData = applyReverseMapping(entityData, reverseMapping);

      const webhookPayload = {
        event: event_type,
        timestamp: new Date().toISOString(),
        source: 'getway_ai',
        entity_id: entity_id || null,
        data: mappedData
      };

      try {
        const headers = { 'Content-Type': 'application/json' };
        // Add API key if configured
        if (integration.api_key) {
          headers['x-api-key'] = integration.api_key;
        }

        const response = await fetch(integration.webhook_url, {
          method: 'POST',
          headers,
          body: JSON.stringify(webhookPayload)
        });

        const responseText = await response.text();
        const success = response.ok;

        results.push({
          crm: integration.crm_type,
          status: success ? 'sent' : 'failed',
          http_status: response.status,
          response: responseText.substring(0, 500)
        });

        console.log(`[crmOutboundPush] ${event_type} → ${integration.crm_type}: ${response.status}`);

        // Update last sync timestamp
        await base44.entities.CRMIntegration.update(integration.id, {
          last_sync: new Date().toISOString(),
          status: success ? 'active' : 'error'
        });

      } catch (err) {
        results.push({
          crm: integration.crm_type,
          status: 'error',
          error: err.message
        });
        console.error(`[crmOutboundPush] Error pushing to ${integration.crm_type}: ${err.message}`);
      }
    }

    return Response.json({ success: true, event_type, results });

  } catch (error) {
    console.error('[crmOutboundPush] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function fetchEntityData(base44, eventType, entityId) {
  try {
    if (eventType.startsWith('lead_')) {
      return await base44.entities.Lead.get(entityId);
    } else if (eventType.startsWith('deal_')) {
      return await base44.entities.Deal.get(entityId);
    } else if (eventType.startsWith('call_')) {
      return await base44.entities.CallLog.get(entityId);
    } else if (eventType.startsWith('activity_')) {
      return await base44.entities.Activity.get(entityId);
    } else if (eventType.startsWith('contact_')) {
      return await base44.entities.Contact.get(entityId);
    }
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