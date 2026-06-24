import { Context } from "hono";
import { base44ORM as base44 } from "../db/orm.ts";

export async function crmInboundHandler(c: Context) {
  try {
    const authKey = c.req.header("x-auth-key");
    const apiKey = c.req.header("x-api-key");
    if (!authKey && !apiKey) return c.json({ error: "Missing authentication" }, 401);

    let clientId;
    let clientRec;

    if (authKey) {
      const clients = await base44.entities.Client.filter({ api_auth_key: authKey });
      if (!clients.length) return c.json({ error: "Invalid auth key" }, 403);
      clientRec = clients[0];
      clientId = clientRec.id;
    } else {
      const integrations = await base44.entities.CRMIntegration.filter({ api_key: apiKey, status: "active" });
      if (!integrations.length) return c.json({ error: "Invalid API key" }, 403);
      clientId = integrations[0].client_id;
      const clients = await base44.entities.Client.filter({ id: clientId });
      if (clients.length) clientRec = clients[0];
    }

    if (!clientRec) return c.json({ error: "Could not resolve account record", access_status: "lookup_failed" }, 503);
    const accessStatus = clientRec.crm_api_access_status || "not_requested";
    if (accessStatus !== "active") return c.json({ error: "CRM API not active", access_status: accessStatus }, 403);

    const { action, data } = await c.req.json();
    if (!action || !data) return c.json({ error: "Missing action/data" }, 400);

    let result;
    switch (action) {
      case "create_lead":
        if (!data.phone && !data.email) return c.json({ error: "Requires phone or email" }, 400);
        result = await base44.entities.Lead.create({ client_id: clientId, source: "crm_api", status: "new", ...data });
        break;
      case "update_lead":
        if (!data.id && !data.phone && !data.email) return c.json({ error: "Provide id, phone, or email" }, 400);
        let lead;
        if (data.id) lead = await base44.entities.Lead.get(data.id);
        else {
          const filter = data.phone ? { client_id: clientId, phone: data.phone } : { client_id: clientId, email: data.email };
          const leads = await base44.entities.Lead.filter(filter);
          lead = leads[0];
        }
        if (!lead) return c.json({ error: "Lead not found" }, 404);
        result = await base44.entities.Lead.update(lead.id, data);
        break;
      default:
        return c.json({ error: `Unsupported action: ${action}` }, 400);
    }
    return c.json({ success: true, action, id: result.id, data: result });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}

export async function crmFetchDataHandler(c: Context) {
  try {
    const authKey = c.req.header("x-auth-key");
    const apiKey = c.req.header("x-api-key");
    if (!authKey && !apiKey) return c.json({ error: "Missing authentication" }, 401);

    let clientId;
    let clientRec;
    if (authKey) {
      const clients = await base44.entities.Client.filter({ api_auth_key: authKey });
      if (!clients.length) return c.json({ error: "Invalid auth key" }, 403);
      clientRec = clients[0];
      clientId = clientRec.id;
    } else {
      const integrations = await base44.entities.CRMIntegration.filter({ api_key: apiKey, status: "active" });
      if (!integrations.length) return c.json({ error: "Invalid API key" }, 403);
      clientId = integrations[0].client_id;
      const clients = await base44.entities.Client.filter({ id: clientId });
      if (clients.length) clientRec = clients[0];
    }

    if (!clientRec) return c.json({ error: "Could not resolve account record", access_status: "lookup_failed" }, 503);
    const accessStatus = clientRec.crm_api_access_status || "not_requested";
    if (accessStatus !== "active") return c.json({ error: "CRM API not active", access_status: accessStatus }, 403);

    const { entity, filters, limit, sort } = await c.req.json();
    if (!entity) return c.json({ error: "Missing entity" }, 400);

    const query = { client_id: clientId, ...(filters || {}) };
    const sortOrder = sort || "-created_at";
    const maxLimit = Math.min(limit || 50, 200);

    let records;
    switch (entity) {
      case "leads": records = await base44.entities.Lead.filter(query, sortOrder, maxLimit); break;
      case "contacts": records = await base44.entities.Contact.filter(query, sortOrder, maxLimit); break;
      case "deals": records = await base44.entities.Deal.filter(query, sortOrder, maxLimit); break;
      case "call_logs": records = await base44.entities.CallLog.filter(query, sortOrder, maxLimit); break;
      case "activities": records = await base44.entities.Activity.filter(query, sortOrder, maxLimit); break;
      default: return c.json({ error: "Unknown entity" }, 400);
    }
    
    return c.json({ success: true, entity, count: records.length, data: records });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}

export async function crmOutboundPushHandler(c: Context) {
  try {
    const { client_id, event_type, entity_id, data } = await c.req.json();
    if (!client_id || !event_type) return c.json({ error: "Missing client_id or event_type" }, 400);

    const clients = await base44.entities.Client.filter({ id: client_id });
    if (!clients.length) return c.json({ error: "Client not found" }, 404);
    if (clients[0].crm_api_access_status !== "active") return c.json({ error: "CRM API not active" }, 403);

    const integrations = await base44.entities.CRMIntegration.filter({ client_id, status: "active" });
    if (!integrations.length) return c.json({ success: true, skipped: "no_active_integration" });

    const results = [];
    for (const int of integrations) {
      if (!int.webhook_url) continue;
      try {
        const payload = { event: event_type, timestamp: new Date().toISOString(), source: "bolify_ai", entity_id, data };
        const res = await fetch(int.webhook_url, {
          method: "POST", headers: { "Content-Type": "application/json", "x-api-key": int.api_key || "" },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(5000)
        });
        results.push({ crm: int.crm_type, status: res.ok ? "sent" : "failed", http_status: res.status });
        if (res.ok) await base44.entities.CRMIntegration.update(int.id, { last_sync: new Date().toISOString(), status: "active" });
      } catch (err: any) {
        results.push({ crm: int.crm_type, status: "error", error: err.message });
      }
    }
    return c.json({ success: true, event_type, results });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}
