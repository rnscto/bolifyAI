import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";
import { broadcastEntityChange } from "../services/realtime.ts";

export const v1Router = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

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
    if (user.role !== 'admin') {
      if (validCols.has("client_id")) {
        conditions.push(`"client_id" = $${paramIndex}`);
        args.push(user.client_id);
        paramIndex++;
      } else if (entity === "client") {
        // If querying the client table, user can only query their own client
        conditions.push(`"id" = $${paramIndex}`);
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
      if (user.role !== 'admin') {
        if (validCols.has("client_id")) {
          query += ` AND client_id = $2`;
          args.push(user.client_id);
        } else if (entity === "client") {
          query += ` AND id = $2`;
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

    if (validCols.has("client_id") && user.role !== 'admin') {
      filteredBody["client_id"] = user.client_id;
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
      if (validCols.has(k) && k !== 'id' && k !== 'created_at' && k !== 'updated_at' && k !== 'client_id') {
        filteredBody[k] = v;
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

    if (validCols.has("client_id") && user.role !== 'admin') {
      query += ` AND client_id = $${values.length + 1}`;
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

      if (validCols.has("client_id") && user.role !== 'admin') {
        query += ` AND client_id = $2`;
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
v1Router.route("/client-lifecycle-events", buildCrudRouter("clientlifecycleevent"));
v1Router.route("/subscriptions", buildCrudRouter("subscription"));
v1Router.route("/voicemail-messages", buildCrudRouter("voicemailmessage"));
v1Router.route("/outreach-logs", buildCrudRouter("outreachlog"));
