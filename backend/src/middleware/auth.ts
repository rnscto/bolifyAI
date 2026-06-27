import { Context, Next } from "hono";
import { verify } from "hono/jwt";
import { client } from "../db/index.ts";

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

export async function universalAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  const authKey = c.req.header("x-auth-key");
  const apiKey = c.req.header("x-api-key");

  let userOrClient: any = null;

  try {
    if (authKey) {
      // Platform auth key logic (Check Hash first for Enterprise Security)
      const dataToHash = new TextEncoder().encode(authKey);
      const hashBuffer = await crypto.subtle.digest("SHA-256", dataToHash);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashedAuthKey = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      let res = await client.queryObject(`SELECT id FROM "client" WHERE api_auth_key = $1 LIMIT 1`, [hashedAuthKey]);
      
      // Backward compatibility: If no match, check raw (for clients who haven't regenerated yet)
      if (res.rows.length === 0) {
         res = await client.queryObject(`SELECT id FROM "client" WHERE api_auth_key = $1 LIMIT 1`, [authKey]);
      }

      if (res.rows.length === 0) {
        return c.json({ success: false, error: "Invalid x-auth-key" }, 403);
      }
      userOrClient = { client_id: (res.rows[0] as any).id, role: "service_role" };
    } else if (apiKey) {
      // CRM integration auth logic
      const res = await client.queryObject(`SELECT client_id FROM "crmintegration" WHERE api_key = $1 AND status = 'active' LIMIT 1`, [apiKey]);
      if (res.rows.length === 0) {
        return c.json({ success: false, error: "Invalid x-api-key or inactive integration" }, 403);
      }
      userOrClient = { client_id: (res.rows[0] as any).client_id, role: "service_role" };
    } else if (authHeader && authHeader.startsWith("Bearer ")) {
      // Standard JWT Auth
      const token = authHeader.split(" ")[1];
      userOrClient = await verify(token, JWT_SECRET, "HS256");
    } else {
      return c.json({ success: false, error: "Unauthorized. Provide x-auth-key, x-api-key, or Bearer token." }, 401);
    }
  } catch (err) {
    return c.json({ success: false, error: "Authentication failed", details: String(err) }, 401);
  }

  c.set("jwtPayload", userOrClient);
  await next();
}
