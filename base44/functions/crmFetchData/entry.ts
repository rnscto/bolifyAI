import { createClient } from 'npm:@base44/sdk@0.8.23';

/**
 * CRM Fetch Data API — External CRMs pull data FROM this platform.
 * 
 * Auth: API key via header "x-api-key" matched against CRMIntegration.api_key
 * 
 * POST /functions/crmFetchData
 * Body: {
 *   "entity": "leads" | "contacts" | "deals" | "call_logs" | "activities",
 *   "filters": { ...optional filters... },
 *   "limit": 50,
 *   "sort": "-created_date"
 * }
 */
Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    // Authenticate via API key
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return Response.json({ error: 'Missing x-api-key header' }, { status: 401 });
    }

    const integrations = await base44.entities.CRMIntegration.filter({ api_key: apiKey, status: 'active' });
    if (integrations.length === 0) {
      return Response.json({ error: 'Invalid API key or integration not active' }, { status: 403 });
    }

    const integration = integrations[0];
    const clientId = integration.client_id;

    const { entity, filters, limit, sort } = await req.json();
    if (!entity) {
      return Response.json({ error: 'Missing "entity". Supported: leads, contacts, deals, call_logs, activities' }, { status: 400 });
    }

    const maxLimit = Math.min(limit || 50, 200);
    const sortOrder = sort || '-created_date';

    // Always scope to this client's data
    const query = { client_id: clientId, ...(filters || {}) };

    let records;
    switch (entity) {
      case 'leads':
        records = await base44.entities.Lead.filter(query, sortOrder, maxLimit);
        break;
      case 'contacts':
        records = await base44.entities.Contact.filter(query, sortOrder, maxLimit);
        break;
      case 'deals':
        records = await base44.entities.Deal.filter(query, sortOrder, maxLimit);
        break;
      case 'call_logs':
        records = await base44.entities.CallLog.filter(query, sortOrder, maxLimit);
        break;
      case 'activities':
        records = await base44.entities.Activity.filter(query, sortOrder, maxLimit);
        break;
      default:
        return Response.json({ error: `Unknown entity: ${entity}. Supported: leads, contacts, deals, call_logs, activities` }, { status: 400 });
    }

    // Strip internal fields for clean API response
    const cleaned = (records || []).map(r => ({
      id: r.id,
      created_date: r.created_date,
      updated_date: r.updated_date,
      ...stripInternalFields(r)
    }));

    console.log(`[crmFetchData] ${entity}: ${cleaned.length} records for client ${clientId}`);

    return Response.json({
      success: true,
      entity,
      count: cleaned.length,
      data: cleaned
    });

  } catch (error) {
    console.error('[crmFetchData] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

function stripInternalFields(record) {
  const { id, created_date, updated_date, created_by, created_by_id, entity_name, app_id, is_sample, is_deleted, deleted_date, environment, ...rest } = record;
  return rest;
}