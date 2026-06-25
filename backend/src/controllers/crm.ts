import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";

export const crmRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

// Secure all routes
crmRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

import { qualifyLeadHandler, rescoreLeadHandler, buildLeadContextHandler } from "./crmLeadOps.ts";
import { autoEnrollSequenceHandler } from "./crmAutoEnroll.ts";
import { crmInboundHandler, crmFetchDataHandler, crmOutboundPushHandler } from "./crmIntegration.ts";

crmRouter.post("/qualify-lead", qualifyLeadHandler);
crmRouter.post("/rescore-lead", rescoreLeadHandler);
crmRouter.post("/build-lead-context", buildLeadContextHandler);

crmRouter.get("/auto-enroll", autoEnrollSequenceHandler);
crmRouter.post("/auto-enroll", autoEnrollSequenceHandler);

crmRouter.post("/inbound", crmInboundHandler);
crmRouter.post("/fetch-data", crmFetchDataHandler);
crmRouter.post("/outbound-push", crmOutboundPushHandler);

// POST /api/crm/leads/bulk-import
// Bulk import leads for a campaign or group
crmRouter.post("/leads/bulk-import", async (c) => {
  const user = c.get("jwtPayload") as any;
  const { campaign_id, group_id, leads, client_id } = await c.req.json();

  if (!leads || !Array.isArray(leads)) {
    return c.json({ error: "Leads array is required" }, 400);
  }

  const targetClientId = (user.role === 'admin' && client_id) ? client_id : user.client_id;

  try {
    const insertedIds = [];

    // Simple bulk insert (in a real app, use a proper unnest query for efficiency)
    for (const lead of leads) {
      const result = await client.queryObject(
        `INSERT INTO "lead" (client_id, first_name, last_name, phone_number, email) 
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [targetClientId, lead.first_name, lead.last_name, lead.phone_number, lead.email]
      );
      const leadId = (result.rows[0] as any).id;
      insertedIds.push(leadId);

      // If tied to a campaign, add to campaignlead table
      if (campaign_id) {
        await client.queryObject(
          `INSERT INTO "campaignlead" (campaign_id, lead_id, status) VALUES ($1, $2, 'pending')`,
          [campaign_id, leadId]
        );
      }
    }

    return c.json({ success: true, count: insertedIds.length, message: "Leads imported successfully" });
  } catch (error: any) {
    console.error("Bulk Import Error:", error);
    return c.json({ error: error.message }, 500);
  }
});

// GET /api/crm/stats
// Get high-level CRM dashboard statistics
crmRouter.get("/stats", async (c) => {
  const user = c.get("jwtPayload") as any;

  try {
    let leadsCountResult, callsCountResult;
    
    if (user.role === 'admin') {
      leadsCountResult = await client.queryObject(`SELECT COUNT(*) as count FROM "lead"`);
      callsCountResult = await client.queryObject(`SELECT COUNT(*) as count FROM "calllog"`);
    } else {
      leadsCountResult = await client.queryObject(
        `SELECT COUNT(*) as count FROM "lead" WHERE client_id = $1`,
        [user.client_id]
      );
      callsCountResult = await client.queryObject(
        `SELECT COUNT(*) as count FROM "calllog" c
         INNER JOIN "lead" l ON c.lead_id = l.id::text
         WHERE l.client_id = $1`,
        [user.client_id]
      );
    }

    return c.json({
      total_leads: Number((leadsCountResult.rows[0] as any).count),
      total_calls: Number((callsCountResult.rows[0] as any).count)
    });

  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});
