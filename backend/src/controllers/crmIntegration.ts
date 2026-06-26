import { Context } from "hono";
import { client } from "../db/index.ts";

export async function crmInboundHandler(c: Context) {
  try {
    const authKey = c.req.header("x-auth-key");
    const apiKey = c.req.header("x-api-key");
    if (!authKey && !apiKey) return c.json({ error: "Missing authentication" }, 401);

    let clientId;
    let clientRec;

    if (authKey) {
      const clientsRes = await client.queryObject(`SELECT * FROM client WHERE api_auth_key = $1`, [authKey]);
      if (clientsRes.rows.length === 0) return c.json({ error: "Invalid auth key" }, 403);
      clientRec = clientsRes.rows[0] as any;
      clientId = clientRec.id;
    } else {
      const integrationsRes = await client.queryObject(`SELECT client_id FROM crmintegration WHERE api_key = $1 AND status = 'active'`, [apiKey]);
      if (integrationsRes.rows.length === 0) return c.json({ error: "Invalid API key" }, 403);
      clientId = (integrationsRes.rows[0] as any).client_id;
      const clientsRes = await client.queryObject(`SELECT * FROM client WHERE id = $1`, [clientId]);
      if (clientsRes.rows.length > 0) clientRec = clientsRes.rows[0] as any;
    }

    if (!clientRec) return c.json({ error: "Could not resolve account record", access_status: "lookup_failed" }, 503);
    const accessStatus = clientRec.crm_api_access_status || "not_requested";
    if (accessStatus !== "active") return c.json({ error: "CRM API not active", access_status: accessStatus }, 403);

    const { action, data } = await c.req.json();
    if (!action || !data) return c.json({ error: "Missing action/data" }, 400);

    let result;
    switch (action) {
      case "create_lead": {
        if (!data.phone && !data.email) return c.json({ error: "Requires phone or email" }, 400);

        const keys = ["client_id", "source", "status", ...Object.keys(data)];
        const values = [clientId, "crm_api", "new", ...Object.values(data)];
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

        const createRes = await client.queryObject(`
          INSERT INTO lead (${keys.join(", ")})
          VALUES (${placeholders})
          RETURNING *
        `, values);
        result = createRes.rows[0];
        break;
      }
      case "update_lead": {
        if (!data.id && !data.phone && !data.email) return c.json({ error: "Provide id, phone, or email" }, 400);
        let lead;
        if (data.id) {
          const leadRes = await client.queryObject(`SELECT * FROM lead WHERE id = $1`, [data.id]);
          lead = leadRes.rows[0];
        } else {
          let leadRes;
          if (data.phone) {
            leadRes = await client.queryObject(`SELECT * FROM lead WHERE client_id = $1 AND phone = $2 LIMIT 1`, [clientId, data.phone]);
          } else {
            leadRes = await client.queryObject(`SELECT * FROM lead WHERE client_id = $1 AND email = $2 LIMIT 1`, [clientId, data.email]);
          }
          lead = leadRes?.rows[0];
        }
        if (!lead) return c.json({ error: "Lead not found" }, 404);

        const updateKeys = Object.keys(data).filter(k => k !== 'id');
        const updateValues = updateKeys.map(k => data[k]);
        const setClause = updateKeys.map((k, i) => `${k} = $${i + 2}`).join(", ");

        const updateRes = await client.queryObject(`
          UPDATE lead SET ${setClause} WHERE id = $1 RETURNING *
        `, [(lead as any).id, ...updateValues]);
        result = updateRes.rows[0];
        break;
      }
      default:
        return c.json({ error: `Unsupported action: ${action}` }, 400);
    }
    return c.json({ success: true, action, id: (result as any).id, data: result });
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
      const clientsRes = await client.queryObject(`SELECT * FROM client WHERE api_auth_key = $1`, [authKey]);
      if (clientsRes.rows.length === 0) return c.json({ error: "Invalid auth key" }, 403);
      clientRec = clientsRes.rows[0] as any;
      clientId = clientRec.id;
    } else {
      const integrationsRes = await client.queryObject(`SELECT client_id FROM crmintegration WHERE api_key = $1 AND status = 'active'`, [apiKey]);
      if (integrationsRes.rows.length === 0) return c.json({ error: "Invalid API key" }, 403);
      clientId = (integrationsRes.rows[0] as any).client_id;
      const clientsRes = await client.queryObject(`SELECT * FROM client WHERE id = $1`, [clientId]);
      if (clientsRes.rows.length > 0) clientRec = clientsRes.rows[0] as any;
    }

    if (!clientRec) return c.json({ error: "Could not resolve account record", access_status: "lookup_failed" }, 503);
    const accessStatus = clientRec.crm_api_access_status || "not_requested";
    if (accessStatus !== "active") return c.json({ error: "CRM API not active", access_status: accessStatus }, 403);

    const { entity, filters, limit, sort } = await c.req.json();
    if (!entity) return c.json({ error: "Missing entity" }, 400);

    const allowedEntities = ['lead', 'contact', 'deal', 'calllog', 'activity'];
    const tableMap: any = { 'leads': 'lead', 'contacts': 'contact', 'deals': 'deal', 'call_logs': 'calllog', 'activities': 'activity' };
    const tableName = tableMap[entity];

    if (!tableName || !allowedEntities.includes(tableName)) {
      return c.json({ error: "Unknown entity" }, 400);
    }

    const sortOrder = sort || "-created_at";
    const sortField = sortOrder.startsWith("-") ? sortOrder.substring(1) : sortOrder;
    const sortDir = sortOrder.startsWith("-") ? "DESC" : "ASC";
    const maxLimit = Math.min(limit || 50, 200);

    const queryParams: any[] = [clientId];
    let whereClause = `WHERE client_id = $1`;
    let paramIndex = 2;

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        whereClause += ` AND ${key} = $${paramIndex}`;
        queryParams.push(value);
        paramIndex++;
      }
    }

    const recordsRes = await client.queryObject(`
      SELECT * FROM ${tableName} 
      ${whereClause} 
      ORDER BY ${sortField} ${sortDir} 
      LIMIT ${maxLimit}
    `, queryParams);

    return c.json({ success: true, entity, count: recordsRes.rows.length, data: recordsRes.rows });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}

export async function crmOutboundPushHandler(c: Context) {
  try {
    const { client_id, event_type, entity_id, data } = await c.req.json();
    if (!client_id || !event_type) return c.json({ error: "Missing client_id or event_type" }, 400);

    const clientsRes = await client.queryObject(`SELECT crm_api_access_status FROM client WHERE id = $1`, [client_id]);
    if (clientsRes.rows.length === 0) return c.json({ error: "Client not found" }, 404);
    if ((clientsRes.rows[0] as any).crm_api_access_status !== "active") return c.json({ error: "CRM API not active" }, 403);

    const integrationsRes = await client.queryObject(`SELECT * FROM crmintegration WHERE client_id = $1 AND status = 'active'`, [client_id]);
    const integrations = integrationsRes.rows;
    if (integrations.length === 0) return c.json({ success: true, skipped: "no_active_integration" });

    const results = [];
    for (const int of integrations) {
      const intObj = int as any;
      if (!intObj.webhook_url) continue;
      try {
        const payload = { event: event_type, timestamp: new Date().toISOString(), source: "bolify_ai", entity_id, data };
        const res = await fetch(intObj.webhook_url, {
          method: "POST", headers: { "Content-Type": "application/json", "x-api-key": intObj.api_key || "" },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(5000)
        });
        results.push({ crm: intObj.crm_type, status: res.ok ? "sent" : "failed", http_status: res.status });
        if (res.ok) {
          await client.queryObject(`UPDATE crmintegration SET last_sync = $1, status = 'active' WHERE id = $2`, [new Date().toISOString(), intObj.id]);
        }
      } catch (err: any) {
        results.push({ crm: intObj.crm_type, status: "error", error: err.message });
      }
    }
    return c.json({ success: true, event_type, results });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}
