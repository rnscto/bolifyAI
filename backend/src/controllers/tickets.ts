import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";

export const ticketRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key_CHANGE_IN_PRODUCTION";

ticketRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

const getRbacCondition = (user: any, startIndex: number) => {
  if (user.role === 'admin' || user.role === 'master_admin') {
    return { clause: "1=1", args: [] };
  }
  if (user.role === 'reseller' || user.role === 'master_reseller') {
    return { 
      clause: `("created_by" = $${startIndex} OR "created_by" IN (SELECT "user_id" FROM "client" WHERE "upline_id" = $${startIndex}))`, 
      args: [user.id] 
    };
  }
  return { clause: `"created_by" = $${startIndex}`, args: [user.id] };
};

// GET /api/support/tickets
ticketRouter.get("/tickets", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const { clause, args } = getRbacCondition(user, 1);
    
    // Support filtering by status
    const status = c.req.query("status");
    let query = `SELECT * FROM "ticket" WHERE ${clause}`;
    let paramIndex = args.length + 1;
    
    if (status) {
      query += ` AND "status" = $${paramIndex}`;
      args.push(status);
      paramIndex++;
    }
    
    query += ` ORDER BY "created_at" DESC`;
    
    const result = await client.queryObject(query, args);
    return c.json(result.rows);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/support/tickets
ticketRouter.post("/tickets", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const body = await c.req.json();
    
    const { subject, category, priority, description, attachment_data, attachment_type } = body;
    if (!subject) return c.json({ error: "Subject is required" }, 400);

    const query = `
      INSERT INTO "ticket" ("created_by", "subject", "category", "status", "priority", "description")
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const result = await client.queryObject(query, [
      user.id,
      subject,
      category || 'other',
      'open',
      priority || 'medium',
      description || ''
    ]);
    
    const ticket = result.rows[0] as any;

    // If description or attachment is provided, insert it as the first message
    if (description || attachment_data) {
      await client.queryObject(
        `INSERT INTO "ticketmessage" ("ticket_id", "sender_id", "sender_role", "message", "attachment_data", "attachment_type")
         VALUES ($1, $2, 'client', $3, $4, $5)`,
        [ticket.id, user.id, description || '', attachment_data || null, attachment_type || null]
      );
    }
    
    return c.json(ticket);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT /api/support/tickets/:id
ticketRouter.put("/tickets/:id", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const id = c.req.param("id");
    const body = await c.req.json();
    
    const { clause, args } = getRbacCondition(user, 2);
    
    // Check if ticket exists and user has access
    const check = await client.queryObject(`SELECT id FROM "ticket" WHERE "id" = $1 AND ${clause}`, [id, ...args]);
    if (check.rows.length === 0) return c.json({ error: "Not found or forbidden" }, 404);
    
    if (body.status) {
      const result = await client.queryObject(
        `UPDATE "ticket" SET "status" = $1, "updated_at" = NOW() WHERE "id" = $2 RETURNING *`,
        [body.status, id]
      );
      return c.json(result.rows[0]);
    }
    
    return c.json(check.rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/support/tickets/:id/messages
ticketRouter.get("/tickets/:id/messages", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const id = c.req.param("id");
    
    const { clause, args } = getRbacCondition(user, 2);
    
    // Verify ticket ownership
    const check = await client.queryObject(`SELECT id FROM "ticket" WHERE "id" = $1 AND ${clause}`, [id, ...args]);
    if (check.rows.length === 0) return c.json({ error: "Not found or forbidden" }, 404);
    
    const result = await client.queryObject(
      `SELECT * FROM "ticketmessage" WHERE "ticket_id" = $1 ORDER BY "created_at" ASC`,
      [id]
    );
    return c.json(result.rows);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/support/tickets/:id/messages
ticketRouter.post("/tickets/:id/messages", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const id = c.req.param("id");
    const body = await c.req.json();
    
    const { message, attachment_data, attachment_type } = body;
    if (!message && !attachment_data) return c.json({ error: "Message or attachment is required" }, 400);

    const { clause, args } = getRbacCondition(user, 2);
    
    // Verify ticket ownership
    const check = await client.queryObject(`SELECT id, status FROM "ticket" WHERE "id" = $1 AND ${clause}`, [id, ...args]);
    if (check.rows.length === 0) return c.json({ error: "Not found or forbidden" }, 404);
    
    const senderRole = user.role.includes('admin') ? 'admin' : (user.role.includes('reseller') ? 'reseller' : 'client');
    
    const result = await client.queryObject(
      `INSERT INTO "ticketmessage" ("ticket_id", "sender_id", "sender_role", "message", "attachment_data", "attachment_type")
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, user.id, senderRole, message || '', attachment_data || null, attachment_type || null]
    );
    
    // Update ticket timestamp
    await client.queryObject(`UPDATE "ticket" SET "updated_at" = NOW() WHERE "id" = $1`, [id]);
    
    return c.json(result.rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/support/tickets/:id/reopen
ticketRouter.post("/tickets/:id/reopen", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const id = c.req.param("id");
    
    const { clause, args } = getRbacCondition(user, 2);
    
    // Verify ticket ownership
    const check = await client.queryObject(`SELECT id FROM "ticket" WHERE "id" = $1 AND ${clause}`, [id, ...args]);
    if (check.rows.length === 0) return c.json({ error: "Not found or forbidden" }, 404);
    
    // Set status back to 'open' and escalate it so humans deal with it
    const result = await client.queryObject(
      `UPDATE "ticket" SET "status" = 'open', "escalated_to_admin" = true, "updated_at" = NOW() WHERE "id" = $1 RETURNING *`,
      [id]
    );
    
    // Add an automated system message indicating it was reopened
    await client.queryObject(
      `INSERT INTO "ticketmessage" ("ticket_id", "sender_id", "sender_role", "message")
       VALUES ($1, $2, 'client', 'System: Ticket re-opened and escalated to admin by user.')`,
      [id, user.id]
    );
    
    return c.json(result.rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
