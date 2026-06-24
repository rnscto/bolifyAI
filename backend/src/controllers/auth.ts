import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { client } from "../db/index.ts";

export const authRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

// Simple password hashing using Web Crypto API
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

authRouter.post("/signup", async (c) => {
  const { email, password, full_name } = await c.req.json();
  
  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  try {
    const hashed = await hashPassword(password);
    
    // Create Client first
    const clientResult = await client.queryObject(
       `INSERT INTO "client" (company_name, email) VALUES ($1, $2) RETURNING id`,
       [full_name || email, email]
    );
    const clientId = (clientResult.rows[0] as any).id;

    // Create User linked to Client
    const userResult = await client.queryObject(
       `INSERT INTO "user" (client_id, display_name, role, email, password_hash) VALUES ($1, $2, 'user', $3, $4) RETURNING id, role`,
       [clientId, full_name || email, email, hashed]
    );
    const userRow = userResult.rows[0] as any;

    const token = await sign({ id: userRow.id, email, client_id: clientId, role: userRow.role, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 }, JWT_SECRET, "HS256");
    
    return c.json({ token, user: { id: userRow.id, email, client_id: clientId, role: userRow.role } });
  } catch (error: any) {
    console.error("Signup error:", error);
    return c.json({ error: error.message }, 500);
  }
});

authRouter.post("/login", async (c) => {
  const { email, password } = await c.req.json();
  
  try {
    const hashed = await hashPassword(password);
    const userResult = await client.queryObject(`
      SELECT id, display_name, role, client_id, password_hash 
      FROM "user" 
      WHERE email = $1 
      LIMIT 1
    `, [email]);

    if (userResult.rows.length === 0) {
      return c.json({ error: "Invalid credentials" }, 401);
    }
    const user = userResult.rows[0] as any;

    if (user.password_hash !== hashed) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const token = await sign({ id: user.id, email, client_id: user.client_id, role: user.role, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 }, JWT_SECRET, "HS256");
    return c.json({ token, user: { id: user.id, email, client_id: user.client_id, role: user.role } });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

authRouter.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = await verify(token, JWT_SECRET, "HS256");
    
    // Fetch full user and client details if needed, but returning payload is enough
    return c.json(payload);
  } catch (e) {
    return c.json({ error: "Invalid token" }, 401);
  }
});
