import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { sendWhatsAppMessage } from "../integrations/whatsapp.ts";
import { sendEmail } from "../integrations/email.ts";
import { sendSMS } from "../integrations/sms.ts";
import { client } from "../db/index.ts";

export const integrationRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

// All endpoints require a valid JWT token / API Key from the client
integrationRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

// --- Messaging Configuration Endpoints ---

integrationRouter.get("/messaging-config", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    if (!clientId) return c.json({ error: "Missing client_id in token" }, 400);

    const res = await client.queryObject(
      `SELECT * FROM "clientmessagingconfig" WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    
    return c.json({ success: true, config: res.rows[0] || null });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

integrationRouter.post("/messaging-config", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    if (!clientId) return c.json({ error: "Missing client_id in token" }, 400);

    const body = await c.req.json();
    
    // Check if exists
    const check = await client.queryObject(`SELECT id FROM "clientmessagingconfig" WHERE client_id = $1`, [clientId]);
    
    if (check.rows.length > 0) {
      // Update
      const keys = Object.keys(body).filter(k => k !== 'id' && k !== 'client_id' && k !== 'created_at');
      if (keys.length === 0) return c.json({ success: true });
      
      const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
      const vals = [clientId, ...keys.map(k => body[k])];
      
      await client.queryObject(`UPDATE "clientmessagingconfig" SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE client_id = $1`, vals);
    } else {
      // Insert
      const payload = { ...body, client_id: clientId };
      const keys = Object.keys(payload).filter(k => k !== 'id' && k !== 'created_at' && k !== 'updated_at');
      const cols = keys.map(k => `"${k}"`).join(", ");
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
      const vals = keys.map(k => payload[k]);
      
      await client.queryObject(`INSERT INTO "clientmessagingconfig" (${cols}) VALUES (${placeholders})`, vals);
    }
    
    const res = await client.queryObject(`SELECT * FROM "clientmessagingconfig" WHERE client_id = $1`, [clientId]);
    return c.json({ success: true, config: res.rows[0] });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Plug & Play Endpoint: Send WhatsApp
integrationRouter.post("/whatsapp/send", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const body = await c.req.json();
    const { to, templateName, variables } = body;

    if (!to || !templateName) {
      return c.json({ error: "Missing 'to' or 'templateName'" }, 400);
    }

    const clientId = user.client_id || user.id;
    const success = await sendWhatsAppMessage(to, templateName, variables || [], clientId);
    return c.json({ success });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Plug & Play Endpoint: Send Email
integrationRouter.post("/email/send", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const body = await c.req.json();
    const { to, subject, bodyText, bodyHtml } = body;

    if (!to || !subject || !bodyText) {
      return c.json({ error: "Missing 'to', 'subject', or 'bodyText'" }, 400);
    }

    const clientId = user.client_id || user.id;
    const success = await sendEmail(to, subject, bodyText, bodyHtml, clientId);
    return c.json({ success });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Plug & Play Endpoint: Send SMS
integrationRouter.post("/sms/send", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const body = await c.req.json();
    const { to, message } = body;

    if (!to || !message) {
      return c.json({ error: "Missing 'to' or 'message'" }, 400);
    }

    const clientId = user.client_id || user.id;
    const success = await sendSMS(to, message, clientId);
    return c.json({ success });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Plug & Play Endpoint: Webhook to Sync Leads (e.g., from GoHighLevel/Zapier)
integrationRouter.post("/crm/webhook", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const body = await c.req.json();
    
    // Support generic webhook payloads mapping to standard lead format
    const name = body.name || body.full_name || body.firstName || "Unknown Webhook Lead";
    const phone = body.phone || body.phone_number || body.contact;
    const email = body.email || null;
    const campaignId = body.campaign_id || body.campaignId || null;

    if (!phone) {
      return c.json({ error: "Webhook payload must include a phone number" }, 400);
    }

    const clientId = user.client_id;

    const result = await client.queryObject(
      `INSERT INTO "lead" (client_id, name, phone_number, email) VALUES ($1, $2, $3, $4) RETURNING id`,
      [clientId, name, phone, email]
    );
    const newLeadId = (result.rows[0] as any).id;

    // Optional: Auto-enroll in a campaign if passed in webhook
    if (campaignId) {
      await client.queryObject(
         `INSERT INTO "campaignlead" (campaign_id, lead_id, status) VALUES ($1, $2, 'pending')`,
         [campaignId, newLeadId]
      );
    }

    return c.json({ success: true, lead_id: newLeadId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

import { getSmartfloToken } from "../services/smartflo.ts";
import { base44ORM as base44 } from "../db/orm.ts";

integrationRouter.post("/smartflo/fetch-dids", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    if (user.role !== "admin") return c.json({ error: "Admin access required" }, 403);

    let token;
    try {
      token = await getSmartfloToken();
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }

    let response = await fetch("https://api-smartflo.tatateleservices.com/v1/my_number", {
      method: "GET",
      headers: { Authorization: token, "Content-Type": "application/json", Accept: "application/json" },
    });

    if (response.status === 401 || response.status === 403) {
      token = await getSmartfloToken(true);
      response = await fetch("https://api-smartflo.tatateleservices.com/v1/my_number", {
        method: "GET",
        headers: { Authorization: token, "Content-Type": "application/json", Accept: "application/json" },
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      return c.json({ error: "Failed to fetch DIDs", details: errorText }, response.status as any);
    }

    const smartfloData = await response.json();
    const didsArray = Array.isArray(smartfloData) ? smartfloData : (smartfloData.data || []);
    if (!Array.isArray(didsArray)) return c.json({ error: "Unexpected format", response: smartfloData }, 500);

    const existingDids = await base44.entities.DID.filter({});
    const existingSet = new Set();
    for (const d of existingDids) {
      if (!d.number) continue;
      const n = String(d.number).replace(/\D/g, "");
      existingSet.add(n);
      if (n.length >= 10) existingSet.add(n.slice(-10));
    }

    const newDids = [];
    for (const did of didsArray) {
      const rawDid = did.did || did.alias || "";
      const phoneNumber = rawDid.replace(/^\+/, "").replace(/\D/g, "");
      if (!phoneNumber) continue;
      const local10 = phoneNumber.slice(-10);
      if (existingSet.has(phoneNumber) || existingSet.has(local10)) continue;
      newDids.push({ number: phoneNumber, country_code: "+91", status: "available", monthly_cost: 6500 });
      existingSet.add(phoneNumber);
      existingSet.add(local10);
    }

    let inserted = 0;
    for (const d of newDids) {
      try {
        await base44.entities.DID.create(d);
        inserted++;
      } catch (e: any) {
        console.error(`Failed to insert DID: ${e.message}`);
      }
    }

    return c.json({
      success: true,
      total_dids: didsArray.length,
      existing_dids: existingDids.length,
      new_dids_added: inserted,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

integrationRouter.post("/smartflo/fetch-channels", async (c) => {
  return c.json({ error: "fetchSmartfloChannels logic requires similar sync structure." }, 501);
});
