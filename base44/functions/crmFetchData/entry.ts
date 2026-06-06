import { createClient } from 'npm:@base44/sdk@0.8.31';

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

    // Authenticate via x-auth-key (client platform key) OR x-api-key (CRM integration key)
    const authKey = req.headers.get('x-auth-key');
    const apiKey = req.headers.get('x-api-key');

    if (!authKey && !apiKey) {
      return Response.json({ error: 'Missing authentication. Provide x-auth-key (platform key) or x-api-key (CRM integration key) header.' }, { status: 401 });
    }

    let clientId;

    if (authKey) {
      const clients = await base44.entities.Client.filter({ api_auth_key: authKey });
      if (clients.length === 0) {
        return Response.json({ error: 'Invalid authorization key' }, { status: 403 });
      }
      clientId = clients[0].id;
    } else {
      const integrations = await base44.entities.CRMIntegration.filter({ api_key: apiKey, status: 'active' });
      if (integrations.length === 0) {
        return Response.json({ error: 'Invalid API key or integration not active' }, { status: 403 });
      }
      clientId = integrations[0].client_id;
    }

    // ─── CRM API access gate: admin must activate this client ───
    const clientRec = await base44.entities.Client.get(clientId).catch(() => null);
    const accessStatus = clientRec?.crm_api_access_status || 'not_requested';
    if (accessStatus !== 'active') {
      return Response.json({
        error: 'CRM Integration API access is not active for this account.',
        access_status: accessStatus,
        next_step: 'Go to the CRM Integration page and request access. An admin will activate it.'
      }, { status: 403 });
    }

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