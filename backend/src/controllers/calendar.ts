/**
 * ─── Calendar Integration Controller ─────────────────────────────────────────
 *
 * Handles OAuth 2.0 authorization code exchange for Google Calendar.
 * Credentials are stored encrypted (access_token, refresh_token) in the
 * `calendarintegration` table after a successful exchange.
 *
 * Required .env vars:
 *   GOOGLE_OAUTH_CLIENT_ID     - OAuth 2.0 Client ID from Google Cloud Console
 *   GOOGLE_OAUTH_CLIENT_SECRET - OAuth 2.0 Client Secret
 *   GOOGLE_OAUTH_REDIRECT_URI  - Authorized redirect URI (e.g. https://portal.bolifyai.com/ClientIntegrations)
 */

import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";

export const calendarRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

calendarRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

// ── GET /status ───────────────────────────────────────────────────────────────
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

// ── GET /oauth-url ────────────────────────────────────────────────────────────
// Returns the Google OAuth authorization URL so the frontend can redirect.
calendarRouter.get("/oauth-url", async (c) => {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const redirectUri = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI");

  if (!clientId || !redirectUri) {
    return c.json({ error: "Google OAuth not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI." }, 503);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "openid",
      "email",
      "profile",
    ].join(" "),
    access_type: "offline",  // Required to get refresh_token
    prompt: "consent",        // Forces refresh_token on every grant
  });

  return c.json({
    success: true,
    auth_url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  });
});

// ── POST /connect ─────────────────────────────────────────────────────────────
// Exchanges the OAuth authorization code for tokens and saves them.
calendarRouter.post("/connect", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    const { provider = "google", auth_code } = await c.req.json();

    if (!auth_code) return c.json({ error: "Missing auth_code" }, 400);

    if (provider !== "google") {
      return c.json({ error: `Provider '${provider}' is not yet supported. Only 'google' is available.` }, 400);
    }

    const googleClientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
    const googleClientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    const redirectUri = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI");

    if (!googleClientId || !googleClientSecret || !redirectUri) {
      return c.json({ error: "Google OAuth credentials not configured on server." }, 503);
    }

    // ── Exchange authorization code for tokens ──────────────────────────────
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: auth_code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("[Calendar] OAuth token exchange failed:", tokenData);
      return c.json({
        error: tokenData.error_description || tokenData.error || "OAuth token exchange failed",
      }, 400);
    }

    const { access_token, refresh_token, expires_in } = tokenData;

    // ── Fetch user email from Google tokeninfo ──────────────────────────────
    let accountEmail = "unknown@google.com";
    try {
      const infoRes = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        accountEmail = info.email || accountEmail;
      }
    } catch (_) { /* non-fatal */ }

    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

    // ── Upsert into calendarintegration ────────────────────────────────────
    await client.queryObject(`
      INSERT INTO calendarintegration (client_id, provider, access_token, refresh_token, account_email, status, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'active', $6)
      ON CONFLICT (client_id, provider) DO UPDATE SET
        access_token  = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, calendarintegration.refresh_token),
        account_email = EXCLUDED.account_email,
        status        = 'active',
        expires_at    = EXCLUDED.expires_at,
        updated_at    = now()
    `, [clientId, provider, access_token, refresh_token || null, accountEmail, expiresAt]);

    console.log(`[Calendar] Connected Google Calendar for client ${clientId} (${accountEmail})`);
    return c.json({ success: true, message: "Google Calendar connected successfully", account_email: accountEmail });
  } catch (err: any) {
    console.error("[Calendar] /connect error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── DELETE /disconnect/:id ────────────────────────────────────────────────────
calendarRouter.delete("/disconnect/:id", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    const id = c.req.param("id");

    // Revoke the Google token before deleting
    const existing = await client.queryObject(
      `SELECT access_token FROM calendarintegration WHERE id = $1 AND client_id = $2`,
      [id, clientId]
    );
    const row = (existing.rows[0] as any);
    if (row?.access_token) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${row.access_token}`, { method: "POST" })
        .catch(() => {});  // Best-effort revocation
    }

    await client.queryObject(
      `DELETE FROM calendarintegration WHERE id = $1 AND client_id = $2`,
      [id, clientId]
    );

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
