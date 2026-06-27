import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";
import { base44ORM } from "../db/orm.ts";
import { broadcastEntityChange } from "../services/realtime.ts";

export const v1Router = new Hono();

const JWT_SECRET = (() => {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) {
    // Warn loudly in logs but use fallback to prevent startup failure in dev
    console.warn("[SECURITY WARNING] JWT_SECRET env var is not set! Using insecure fallback. Set JWT_SECRET in production.");
    return "super_secret_bolifyai_key_CHANGE_IN_PRODUCTION";
  }
  return secret;
})();

// Dynamic Branding Route for Resellers (PUBLIC) — includes reseller_id for signup attribution
v1Router.get("/branding", async (c) => {
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);

  try {
    const mappings = await base44ORM.entities.DomainMapping.filter({ custom_domain: domain });
    if (mappings.length > 0) {
      const mapping = mappings[0] as any;
      return c.json({
        success: true,
        branding: {
          brand_name: mapping.brand_name,
          logo_url: mapping.logo_url,
          theme_colors: mapping.theme_colors,
          reseller_id: mapping.reseller_id,   // ← critical: needed for signup attribution
          custom_domain: mapping.custom_domain
        }
      });
    }
    // Return default branding
    return c.json({
      success: true, branding: {
        brand_name: "Bolify AI",
        logo_url: "https://media.base44.com/images/public/69c78272bd33d5309cbe2b7c/a1247aabb_generated_image.png",
        theme_colors: { primary: "#00bcd4" },
        reseller_id: null
      }
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

v1Router.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

const sanitizeTableName = (name: string) => {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "");
};

const tableColumnsCache = new Map<string, Set<string>>();

async function getValidColumns(entity: string): Promise<Set<string>> {
  if (tableColumnsCache.has(entity)) {
    return tableColumnsCache.get(entity)!;
  }
  const result = await client.queryObject(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [entity]
  );
  const columns = new Set<string>(result.rows.map((row: any) => row.column_name));
  tableColumnsCache.set(entity, columns);
  return columns;
}

const buildCrudRouter = (tableName: string) => {
  const router = new Hono();
  const entity = sanitizeTableName(tableName);

  // GET / - list/filter
  router.get("/", async (c) => {
    const queryParams = c.req.query();
    const user = c.get("jwtPayload") as any;

    const validCols = await getValidColumns(entity);
    if (validCols.size === 0) {
      return c.json({ error: "Entity not found" }, 404);
    }

    let query = `SELECT * FROM "${entity}"`;
    const conditions: string[] = [];
    const args: any[] = [];
    let paramIndex = 1;

    // MULTI-TENANCY ENFORCEMENT
    if (user.role !== 'admin' && user.role !== 'master_admin') {
      if (entity === "client") {
        if (user.role === 'reseller' || user.role === 'master_reseller') {
          conditions.push(`("id"::text = $${paramIndex} OR "upline_id" = $${paramIndex})`);
        } else {
          conditions.push(`"id" = $${paramIndex}`);
        }
        args.push(user.client_id);
        paramIndex++;
      } else if (validCols.has("client_id")) {
        if (user.role === 'reseller' || user.role === 'master_reseller') {
          conditions.push(`"client_id"::text IN (SELECT id::text FROM "client" WHERE id::text = $${paramIndex} OR upline_id = $${paramIndex})`);
        } else {
          conditions.push(`"client_id"::text = $${paramIndex}`);
        }
        args.push(user.client_id);
        paramIndex++;
      }
    }

    for (const [key, value] of Object.entries(queryParams)) {
      if (key === 'limit' || key === 'offset' || key === 'sort') continue;
      if (!validCols.has(key)) {
        return c.json([]);
      }
      conditions.push(`"${key}" = $${paramIndex}`);
      args.push(value);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    if (queryParams.sort) {
      const sortField = queryParams.sort.startsWith('-') ? queryParams.sort.substring(1) : queryParams.sort;
      const sortOrder = queryParams.sort.startsWith('-') ? 'DESC' : 'ASC';
      if (validCols.has(sortField)) {
        query += ` ORDER BY "${sortField}" ${sortOrder}`;
      }
    }

    if (queryParams.limit) {
      query += ` LIMIT ${parseInt(queryParams.limit) || 100}`;
    } else {
      query += ` LIMIT 100`;
    }

    try {
      const result = await client.queryObject(query, args);
      return c.json(result.rows);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /:id - get one
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("jwtPayload") as any;

    const validCols = await getValidColumns(entity);

    try {
      let query = `SELECT * FROM "${entity}" WHERE id = $1`;
      const args: any[] = [id];

      // MULTI-TENANCY ENFORCEMENT
      if (user.role !== 'admin' && user.role !== 'master_admin') {
        if (entity === "client") {
          if (user.role === 'reseller' || user.role === 'master_reseller') {
            query += ` AND (id::text = $2 OR upline_id = $2)`;
          } else {
            query += ` AND id = $2`;
          }
          args.push(user.client_id);
        } else if (validCols.has("client_id")) {
          if (user.role === 'reseller' || user.role === 'master_reseller') {
            query += ` AND client_id::text IN (SELECT id::text FROM "client" WHERE id::text = $2 OR upline_id = $2)`;
          } else {
            query += ` AND client_id::text = $2`;
          }
          args.push(user.client_id);
        }
      }

      query += ` LIMIT 1`;

      const result = await client.queryObject(query, args);
      if (result.rows.length === 0) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json(result.rows[0]);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST / - create
  router.post("/", async (c) => {
    const body = await c.req.json();
    const user = c.get("jwtPayload") as any;

    const validCols = await getValidColumns(entity);
    if (validCols.size === 0) {
      return c.json({ error: "Entity not found" }, 404);
    }

    const filteredBody: Record<string, any> = {};
    for (const [k, v] of Object.entries(body)) {
      if (validCols.has(k) && k !== 'id' && k !== 'created_at' && k !== 'updated_at') {
        filteredBody[k] = v;
      }
    }

    if (validCols.has("client_id") && user.role !== 'admin' && user.role !== 'master_admin') {
      if (user.role === 'reseller' || user.role === 'master_reseller') {
        if (filteredBody["client_id"] && filteredBody["client_id"] !== user.client_id) {
          const check = await client.queryObject(`SELECT id FROM "client" WHERE id = $1 AND upline_id = $2`, [filteredBody["client_id"], user.client_id]);
          if (check.rows.length === 0) {
            filteredBody["client_id"] = user.client_id;
          }
        } else {
          filteredBody["client_id"] = user.client_id;
        }
      } else {
        filteredBody["client_id"] = user.client_id;
      }
    }
    
    // Auto-assign upline_id when resellers create a downline client
    if (entity === "client" && (user.role === 'reseller' || user.role === 'master_reseller')) {
      filteredBody["upline_id"] = user.client_id;
    }

    const columns = Object.keys(filteredBody).map(k => `"${k}"`).join(", ");
    const placeholders = Object.keys(filteredBody).map((_, i) => `$${i + 1}`).join(", ");
    const values = Object.values(filteredBody).map(v =>
      (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v
    );

    let query = `INSERT INTO "${entity}" DEFAULT VALUES RETURNING *`;
    if (columns.length > 0) {
      query = `INSERT INTO "${entity}" (${columns}) VALUES (${placeholders}) RETURNING *`;
    }

    try {
      const result = await client.queryObject(query, values);
      const newRecord = result.rows[0];
      broadcastEntityChange(entity, 'created', newRecord);
      return c.json(newRecord, 201);
    } catch (error: any) {
      console.error("POST Error:", error);
      return c.json({ error: error.message }, 500);
    }
  });

  // PUT /:id - update
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const user = c.get("jwtPayload") as any;

    const validCols = await getValidColumns(entity);
    if (validCols.size === 0) {
      return c.json({ error: "Entity not found" }, 404);
    }

    const filteredBody: Record<string, any> = {};
    for (const [k, v] of Object.entries(body)) {
      if (validCols.has(k) && k !== 'id' && k !== 'created_at' && k !== 'updated_at') {
        // Prevent normal clients from reassigning ownership
        if (k === 'client_id' && user.role !== 'admin' && user.role !== 'master_admin' && user.role !== 'reseller' && user.role !== 'master_reseller') {
          continue;
        }
        filteredBody[k] = v;
      }
    }

    if (validCols.has("client_id") && (user.role === 'reseller' || user.role === 'master_reseller') && filteredBody["client_id"]) {
        if (filteredBody["client_id"] !== user.client_id) {
          const check = await client.queryObject(`SELECT id FROM "client" WHERE id = $1 AND upline_id = $2`, [filteredBody["client_id"], user.client_id]);
          if (check.rows.length === 0) {
            // Cannot reassign to a client that isn't their downline
            return c.json({ error: "Unauthorized client_id assignment" }, 403);
          }
        }
    }

    if (Object.keys(filteredBody).length === 0) {
      try {
        const result = await client.queryObject(`SELECT * FROM "${entity}" WHERE id = $1`, [id]);
        return c.json(result.rows[0] || {});
      } catch (e) {
        return c.json({ error: "No data provided" }, 400);
      }
    }

    const setClauses = Object.keys(filteredBody).map((k, i) => `"${k}" = $${i + 2}`).join(", ");
    const values = [id, ...Object.values(filteredBody).map(v =>
      (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v
    )];

    let query = `UPDATE "${entity}" SET ${setClauses} WHERE id = $1`;

    if (validCols.has("client_id") && user.role !== 'admin' && user.role !== 'master_admin') {
      if (user.role === 'reseller' || user.role === 'master_reseller') {
        query += ` AND client_id::text IN (SELECT id::text FROM "client" WHERE id::text = $${values.length + 1} OR upline_id = $${values.length + 1})`;
      } else {
        query += ` AND client_id::text = $${values.length + 1}`;
      }
      values.push(user.client_id);
    }

    query += ` RETURNING *`;

    try {
      const result = await client.queryObject(query, values);
      if (result.rows.length === 0) {
        return c.json({ error: "Not found" }, 404);
      }
      const updatedRecord = result.rows[0];
      broadcastEntityChange(entity, 'updated', updatedRecord);
      return c.json(updatedRecord);
    } catch (error: any) {
      console.error("PUT Error:", error);
      return c.json({ error: error.message }, 500);
    }
  });

  // DELETE /:id - delete
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("jwtPayload") as any;

    const validCols = await getValidColumns(entity);

    try {
      let query = `DELETE FROM "${entity}" WHERE id = $1`;
      const args: any[] = [id];

      if (validCols.has("client_id") && user.role !== 'admin' && user.role !== 'master_admin') {
        if (user.role === 'reseller' || user.role === 'master_reseller') {
          query += ` AND client_id::text IN (SELECT id::text FROM "client" WHERE id::text = $2 OR upline_id = $2)`;
        } else {
          query += ` AND client_id::text = $2`;
        }
        args.push(user.client_id);
      }

      query += ` RETURNING id`;

      const result = await client.queryObject(query, args);
      if (result.rows.length === 0) {
        return c.json({ error: "Not found" }, 404);
      }
      broadcastEntityChange(entity, 'deleted', { id });
      return c.json({ success: true, deletedId: id });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  return router;
};

// Explicit mappings
v1Router.route("/leads", buildCrudRouter("lead"));
v1Router.route("/lead-groups", buildCrudRouter("leadgroup"));
v1Router.route("/whatsapp-templates", buildCrudRouter("whatsapptemplate"));
v1Router.route("/campaigns", buildCrudRouter("campaign"));
v1Router.route("/campaign-leads", buildCrudRouter("campaignlead"));
v1Router.route("/activities", buildCrudRouter("activity"));
v1Router.route("/agents", buildCrudRouter("agent"));
v1Router.route("/clients", buildCrudRouter("client"));
v1Router.route("/dids", buildCrudRouter("did"));
v1Router.route("/call-logs", buildCrudRouter("calllog"));
v1Router.route("/deals", buildCrudRouter("deal"));
v1Router.route("/crm-config", buildCrudRouter("crmconfig"));
v1Router.route("/email-sequences", buildCrudRouter("emailsequence"));
v1Router.route("/sequence-enrollments", buildCrudRouter("sequenceenrollment"));
v1Router.route("/client-integrations", buildCrudRouter("clientintegration"));
v1Router.route("/platform-announcements", buildCrudRouter("platformannouncement"));
const ALL_ENTITIES = [
  "Client",
  "Campaign",
  "Agent",
  "CallLog",
  "Lead",
  "ApiKey",
  "WebhookSetting",
  "User",
  "UserSetting",
  "Payment",
  "Subscription",
  "Invoice",
  "UsageLog",
  "Notification",
  "Template",
  "AuditLog",
  "Integration",
  "SystemSetting",
  "AdminAction",
  "SupportTicket",
  "FAQ",
  "KnowledgeBase",
  "PaymentApprovalRequest",
  "WebhookLog",
  "Partner",
  "PartnerPayout",
  "PlatformMessagingConfig",
  "PartnerAgreement",
  "DataErasureRequest",
  "CampaignLead",
  "CRMConfig",
  "Referral",
  "DID",
  "ClientAgreementTemplate",
  "KYCDocument",
  "Meeting",
  "Note",
  "Deal",
  "Task",
  "Contact",
  "OutreachLog",
  "DomainMapping",
  "CommissionLedger",
  "Ticket",
  "TicketMessage"
];
v1Router.route("/client-lifecycle-events", buildCrudRouter("clientlifecycleevent"));
v1Router.route("/subscriptions", buildCrudRouter("subscription"));
v1Router.route("/voicemail-messages", buildCrudRouter("voicemailmessage"));
v1Router.route("/outreach-logs", buildCrudRouter("outreachlog"));
v1Router.route("/client-agreements", buildCrudRouter("clientagreement"));
v1Router.route("/client-agreement-templates", buildCrudRouter("clientagreementtemplate"));
v1Router.route("/agreement-templates", buildCrudRouter("agreementtemplate"));
v1Router.route("/partner-agreements", buildCrudRouter("partneragreement"));
v1Router.route("/brand-settings", buildCrudRouter("brandsettings"));
v1Router.route("/audit-logs", buildCrudRouter("auditlog"));
v1Router.route("/calendar-integrations", buildCrudRouter("calendarintegration"));
v1Router.route("/call-decisions", buildCrudRouter("calldecision"));
v1Router.route("/client-messaging-configs", buildCrudRouter("clientmessagingconfig"));
v1Router.route("/complaint-logs", buildCrudRouter("complaintlog"));
v1Router.route("/consent-logs", buildCrudRouter("consentlog"));
v1Router.route("/contacts", buildCrudRouter("contact"));
v1Router.route("/crm-integrations", buildCrudRouter("crmintegration"));
v1Router.route("/data-erasure-requests", buildCrudRouter("dataerasurerequest"));
v1Router.route("/industry-templates", buildCrudRouter("industrytemplate"));
v1Router.route("/knowledge-bases", buildCrudRouter("knowledgebase"));
v1Router.route("/kyc-documents", buildCrudRouter("kycdocument"));
v1Router.route("/marketplace-integrations", buildCrudRouter("marketplaceintegration"));
v1Router.route("/owner-statuses", buildCrudRouter("ownerstatus"));
v1Router.route("/partners", buildCrudRouter("partner"));
v1Router.route("/partner-payouts", buildCrudRouter("partnerpayout"));
v1Router.route("/payments", buildCrudRouter("payment"));
v1Router.route("/payment-approval-requests", buildCrudRouter("paymentapprovalrequest"));
v1Router.route("/platform-messaging-configs", buildCrudRouter("platformmessagingconfig"));
v1Router.route("/referrals", buildCrudRouter("referral"));
v1Router.route("/retention-configs", buildCrudRouter("retentionconfig"));
v1Router.route("/smartflo-auths", buildCrudRouter("smartfloauth"));
v1Router.route("/social-media-posts", buildCrudRouter("socialmediapost"));
v1Router.route("/trusted-clients", buildCrudRouter("trustedclient"));
v1Router.route("/trusted-contacts", buildCrudRouter("trustedcontact"));
v1Router.route("/usage-logs", buildCrudRouter("usagelog"));
v1Router.route("/users", buildCrudRouter("user"));

