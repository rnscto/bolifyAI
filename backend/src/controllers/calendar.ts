import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";

export const calendarRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

calendarRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

calendarRouter.get("/status", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    if (!clientId) return c.json({ error: "Missing client_id" }, 400);

    const res = await client.queryObject(
      `SELECT id, provider, account_email, status, updated_at FROM calendarintegration WHERE client_id = $1`,
      [clientId]
    );
    return c.json({ success: true, integrations: res.rows });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

calendarRouter.post("/connect", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    const { provider, auth_code } = await c.req.json();

    if (!provider || !auth_code) {
      return c.json({ error: "Missing provider or auth_code" }, 400);
    }

    // In a real production scenario, you would exchange the auth_code for an access_token
    // using the provider's OAuth token endpoint (e.g., https://oauth2.googleapis.com/token)

    // For now, this is a placeholder that saves the credentials
    const mockEmail = `user@${provider}.com`;
    const mockAccessToken = `mock_access_token_${Date.now()}`;
    const mockRefreshToken = `mock_refresh_token_${Date.now()}`;

    await client.queryObject(`
      INSERT INTO calendarintegration (client_id, provider, access_token, refresh_token, account_email, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
    `, [clientId, provider, mockAccessToken, mockRefreshToken, mockEmail]);

    return c.json({ success: true, message: "Connected successfully" });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

calendarRouter.delete("/disconnect/:id", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    const id = c.req.param("id");

    await client.queryObject(
      `DELETE FROM calendarintegration WHERE id = $1 AND client_id = $2`,
      [id, clientId]
    );

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
