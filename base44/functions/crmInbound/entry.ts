import { createClient } from 'npm:@base44/sdk@0.8.31';

/**
 * CRM Inbound API — External CRMs push data TO this platform.
 * 
 * Auth: API key via header "x-api-key" matched against CRMIntegration.api_key
 * 
 * POST /functions/crmInbound
 * Body: {
 *   "action": "create_lead" | "update_lead" | "create_contact" | "create_deal" | "update_deal" | "create_activity",
 *   "data": { ...fields... }
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
    let integration = null;
    let clientRec = null;

    if (authKey) {
      // Authenticate via client platform auth key
      const clients = await base44.entities.Client.filter({ api_auth_key: authKey });
      if (clients.length === 0) {
        return Response.json({ error: 'Invalid authorization key' }, { status: 403 });
      }
      clientRec = clients[0];
      clientId = clients[0].id;
      // Optionally load integration for field mapping
      const integrations = await base44.entities.CRMIntegration.filter({ client_id: clientId, status: 'active' });
      if (integrations.length > 0) integration = integrations[0];
    } else {
      // Authenticate via CRM integration API key
      const integrations = await base44.entities.CRMIntegration.filter({ api_key: apiKey, status: 'active' });
      if (integrations.length === 0) {
        return Response.json({ error: 'Invalid API key or integration not active' }, { status: 403 });
      }
      integration = integrations[0];
      clientId = integration.client_id;
    }

    // ─── CRM API access gate: admin must activate this client ───
    // Reuse the record from auth if available; otherwise resolve it reliably by id.
    if (!clientRec) {
      clientRec = await resolveClient(base44, clientId);
    }
    // If the client record could not be resolved at all, that's a lookup failure —
    // don't masquerade it as "not_requested" (which is misleading to the client).
    if (!clientRec) {
      console.error(`[crmInbound] gate: could not resolve client record for clientId=${clientId} via=${authKey ? 'auth-key' : 'api-key'}`);
      return Response.json({
        error: 'Could not resolve your account record. Please retry; if this persists, contact support.',
        access_status: 'lookup_failed'
      }, { status: 503 });
    }
    const accessStatus = clientRec.crm_api_access_status || 'not_requested';
    console.log(`[crmInbound] gate: clientId=${clientId} found=true accessStatus=${accessStatus} via=${authKey ? 'auth-key' : 'api-key'}`);
    if (accessStatus !== 'active') {
      return Response.json({
        error: 'CRM Integration API access is not active for this account.',
        access_status: accessStatus,
        next_step: 'Go to the CRM Integration page and request access. An admin will activate it.'
      }, { status: 403 });
    }

    const { action, data } = await req.json();
    if (!action || !data) {
      return Response.json({ error: 'Missing "action" and "data" in request body' }, { status: 400 });
    }

    // Apply field mapping if configured
    const fieldMapping = integration.field_mapping || {};
    const mapped = applyFieldMapping(data, fieldMapping, action);

    let result;

    switch (action) {
      case 'create_lead': {
        if (!mapped.phone && !mapped.email) {
          return Response.json({ error: 'Lead requires at least phone or email' }, { status: 400 });
        }
        result = await base44.entities.Lead.create({
          client_id: clientId,
          name: mapped.name || '',
          phone: mapped.phone || '',
          email: mapped.email || '',
          company: mapped.company || '',
          source: mapped.source || 'crm_api',
          status: mapped.status || 'new',
          notes: mapped.notes || '',
          tags: mapped.tags || [],
          custom_fields: mapped.custom_fields || {}
        });
        console.log(`[crmInbound] Lead created: ${result.id} for client ${clientId}`);
        break;
      }

      case 'update_lead': {
        if (!mapped.id && !mapped.phone && !mapped.email) {
          return Response.json({ error: 'Provide id, phone, or email to identify the lead' }, { status: 400 });
        }
        let lead;
        if (mapped.id) {
          lead = await base44.entities.Lead.get(mapped.id);
        } else {
          const filter = mapped.phone
            ? { client_id: clientId, phone: mapped.phone }
            : { client_id: clientId, email: mapped.email };
          const leads = await base44.entities.Lead.filter(filter);
          lead = leads[0];
        }
        if (!lead) {
          return Response.json({ error: 'Lead not found' }, { status: 404 });
        }
        const updateFields = {};
        if (mapped.name) updateFields.name = mapped.name;
        if (mapped.status) updateFields.status = mapped.status;
        if (mapped.notes) updateFields.notes = mapped.notes;
        if (mapped.company) updateFields.company = mapped.company;
        if (mapped.email) updateFields.email = mapped.email;
        if (mapped.tags) updateFields.tags = mapped.tags;
        if (mapped.custom_fields) updateFields.custom_fields = mapped.custom_fields;
        result = await base44.entities.Lead.update(lead.id, updateFields);
        console.log(`[crmInbound] Lead updated: ${lead.id}`);
        break;
      }

      case 'create_contact': {
        if (!mapped.first_name || !mapped.phone) {
          return Response.json({ error: 'Contact requires first_name and phone' }, { status: 400 });
        }
        result = await base44.entities.Contact.create({
          client_id: clientId,
          first_name: mapped.first_name || '',
          last_name: mapped.last_name || '',
          phone: mapped.phone || '',
          email: mapped.email || '',
          company: mapped.company || '',
          job_title: mapped.job_title || '',
          notes: mapped.notes || '',
          custom_fields: mapped.custom_fields || {}
        });
        console.log(`[crmInbound] Contact created: ${result.id}`);
        break;
      }

      case 'create_deal': {
        if (!mapped.title) {
          return Response.json({ error: 'Deal requires title' }, { status: 400 });
        }
        result = await base44.entities.Deal.create({
          client_id: clientId,
          title: mapped.title,
          value: mapped.value || 0,
          currency: mapped.currency || 'INR',
          stage: mapped.stage || 'new',
          source: mapped.source || 'crm_api',
          lead_id: mapped.lead_id || '',
          contact_id: mapped.contact_id || '',
          expected_close_date: mapped.expected_close_date || '',
          notes: mapped.notes || '',
          custom_fields: mapped.custom_fields || {}
        });
        console.log(`[crmInbound] Deal created: ${result.id}`);
        break;
      }

      case 'update_deal': {
        if (!mapped.id) {
          return Response.json({ error: 'Deal update requires id' }, { status: 400 });
        }
        const dealUpdate = {};
        if (mapped.stage) dealUpdate.stage = mapped.stage;
        if (mapped.status) dealUpdate.status = mapped.status;
        if (mapped.value !== undefined) dealUpdate.value = mapped.value;
        if (mapped.notes) dealUpdate.notes = mapped.notes;
        if (mapped.lost_reason) dealUpdate.lost_reason = mapped.lost_reason;
        if (mapped.custom_fields) dealUpdate.custom_fields = mapped.custom_fields;
        dealUpdate.last_activity_date = new Date().toISOString();
        result = await base44.entities.Deal.update(mapped.id, dealUpdate);
        console.log(`[crmInbound] Deal updated: ${mapped.id}`);
        break;
      }

      case 'create_activity': {
        if (!mapped.type || !mapped.scheduled_date) {
          return Response.json({ error: 'Activity requires type and scheduled_date' }, { status: 400 });
        }
        result = await base44.entities.Activity.create({
          client_id: clientId,
          type: mapped.type,
          title: mapped.title || '',
          description: mapped.description || '',
          scheduled_date: mapped.scheduled_date,
          lead_id: mapped.lead_id || '',
          deal_id: mapped.deal_id || '',
          contact_id: mapped.contact_id || '',
          priority: mapped.priority || 'medium',
          assigned_to: mapped.assigned_to || '',
          status: 'scheduled'
        });
        console.log(`[crmInbound] Activity created: ${result.id}`);
        break;
      }

      default:
        return Response.json({ error: `Unknown action: ${action}. Supported: create_lead, update_lead, create_contact, create_deal, update_deal, create_activity` }, { status: 400 });
    }

    return Response.json({ success: true, action, id: result.id, data: result });

  } catch (error) {
    console.error('[crmInbound] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Reliably resolve a Client record by id across SDK quirks: try .get(), then filter by id.
async function resolveClient(base44, clientId) {
  try {
    const rec = await base44.entities.Client.get(clientId);
    if (rec) return rec;
  } catch (e) {
    console.log(`[resolveClient] .get() failed: ${e.message}`);
  }
  try {
    const recs = await base44.entities.Client.filter({ id: clientId });
    if (recs && recs.length > 0) return recs[0];
  } catch (e) {
    console.log(`[resolveClient] .filter({id}) failed: ${e.message}`);
  }
  return null;
}

// Apply field mapping: maps external CRM field names → internal field names
function applyFieldMapping(data, mapping, action) {
  if (!mapping || Object.keys(mapping).length === 0) return data;

  const actionMapping = mapping[action] || mapping['*'] || {};
  if (Object.keys(actionMapping).length === 0) return data;

  const result = {};
  for (const [key, value] of Object.entries(data)) {
    const mappedKey = actionMapping[key] || key;
    result[mappedKey] = value;
  }
  return result;
}