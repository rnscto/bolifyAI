import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { client } from "../db/index.ts";
import { sendEmail } from "../integrations/email.ts";

export const authRouter = new Hono();

const JWT_SECRET = (() => {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) console.warn("[SECURITY WARNING] JWT_SECRET env var not set in auth.ts!");
  return secret || "super_secret_bolifyai_key_CHANGE_IN_PRODUCTION";
})();
const RESET_SECRET = Deno.env.get("JWT_RESET_SECRET") || JWT_SECRET + "_reset";

// Simple password hashing using Web Crypto API
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

authRouter.post("/signup", async (c) => {
  const { email, password, full_name, upline_id } = await c.req.json();
  
  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  try {
    const hashed = await hashPassword(password);
    
    // Create Client first
    const clientResult = await client.queryObject(
       `INSERT INTO "client" (company_name, email, upline_id) VALUES ($1, $2, $3) RETURNING id`,
       [full_name || email, email, upline_id || null]
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
    
    // Fetch full user details from DB
    const userResult = await client.queryObject(`
      SELECT id, display_name, role, client_id, email
      FROM "user"
      WHERE id = $1
      LIMIT 1
    `, [payload.id]);

    if (userResult.rows.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json(userResult.rows[0]);
  } catch (e) {
    return c.json({ error: "Invalid token" }, 401);
  }
});

authRouter.put("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = await verify(token, JWT_SECRET, "HS256");
    const { display_name } = await c.req.json();

    if (display_name) {
      await client.queryObject(
        `UPDATE "user" SET display_name = $1 WHERE id = $2`,
        [display_name, payload.id]
      );
    }

    return c.json({ success: true, display_name });
  } catch (e: any) {
    return c.json({ error: "Invalid token" }, 401);
  }
});

// POST /api/auth/invite
authRouter.post("/invite", async (c) => {
  try {
    const { email } = await c.req.json();
    const user = c.get("jwtPayload") as any;

    if (!email) return c.json({ error: "Email is required" }, 400);

    const isReseller = ["reseller", "master_reseller"].includes(user.role);
    if (!isReseller) {
      return c.json({ error: "Only resellers can invite users" }, 403);
    }

    const inviteToken = await sign({ 
      email, 
      upline_id: user.client_id, 
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 // 7 days valid
    }, JWT_SECRET, "HS256");

    // In a real scenario, this would generate a link for the frontend
    const inviteLink = `https://${c.req.header("host") || "bolify.ai"}/register?invite=${inviteToken}`;
    
    // In dev mode, we'll log it
    console.log(`[INVITE LINK] ${inviteLink}`);

    await sendEmail({
      to: email,
      subject: "You have been invited to Bolify.ai",
      text: `You have been invited to join Bolify.ai. Please register using this link: ${inviteLink}`,
      html: `<p>You have been invited to join Bolify.ai.</p><p><a href="${inviteLink}">Click here to register</a></p>`
    });

    return c.json({ success: true, message: "Invite sent successfully" });
  } catch (err: any) {
    console.error("Invite error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/auth/validate-invite
authRouter.post("/validate-invite", async (c) => {
  try {
    const { token } = await c.req.json();
    if (!token) return c.json({ error: "Token is required" }, 400);

    const payload = await verify(token, JWT_SECRET, "HS256");
    return c.json({ success: true, payload });
  } catch (e) {
    return c.json({ error: "Invalid or expired invite token" }, 400);
  }
});

// POST /api/auth/forgot-password
authRouter.post("/forgot-password", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ error: "Email is required" }, 400);

    const userResult = await client.queryObject(
      `SELECT id, display_name FROM "user" WHERE email = $1 LIMIT 1`, [email]
    );

    // Always return success (do not reveal if email exists — security best practice)
    if (userResult.rows.length === 0) {
      return c.json({ success: true, message: "If that email exists, you will receive a reset link." });
    }

    const user = userResult.rows[0] as any;

    // Create a short-lived reset token (15 minutes)
    const resetToken = await sign(
      { id: user.id, email, purpose: 'password_reset', exp: Math.floor(Date.now() / 1000) + 15 * 60 },
      RESET_SECRET, "HS256"
    );

    const appUrl = Deno.env.get('APP_BASE_URL') || 'https://app.bolifyai.com';
    const resetLink = `${appUrl}/reset-password?token=${resetToken}`;

    await sendEmail(
      email,
      "Reset Your BolifyAI Password",
      `Hi ${user.display_name || email},\n\nYou requested a password reset. Click the link below to set a new password. This link expires in 15 minutes.\n\n${resetLink}\n\nIf you did not request this, ignore this email.\n\nBolifyAI Security Team`
    );

    return c.json({ success: true, message: "If that email exists, you will receive a reset link." });
  } catch (err: any) {
    console.error("[auth/forgot-password] Error:", err);
    return c.json({ error: "Failed to process request" }, 500);
  }
});

// POST /api/auth/reset-password
authRouter.post("/reset-password", async (c) => {
  try {
    const { token, new_password } = await c.req.json();
    if (!token || !new_password) return c.json({ error: "Token and new_password required" }, 400);
    if (new_password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

    let payload: any;
    try {
      payload = await verify(token, RESET_SECRET, "HS256");
    } catch {
      return c.json({ error: "Invalid or expired reset link. Please request a new one." }, 400);
    }

    if (payload.purpose !== 'password_reset') {
      return c.json({ error: "Invalid token type" }, 400);
    }

    const hashed = await hashPassword(new_password);
    const result = await client.queryObject(
      `UPDATE "user" SET password_hash = $1 WHERE id = $2 AND email = $3 RETURNING id`,
      [hashed, payload.id, payload.email]
    );

    if (result.rows.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    console.log(`[auth/reset-password] Password reset for user ${payload.id}`);
    return c.json({ success: true, message: "Password updated successfully. Please log in." });
  } catch (err: any) {
    console.error("[auth/reset-password] Error:", err);
    return c.json({ error: "Failed to reset password" }, 500);
  }
});

// POST /api/auth/impersonate
authRouter.post("/impersonate", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = await verify(token, JWT_SECRET, "HS256");
    
    // Security Check: Only Master Admin can impersonate
    if (payload.role !== "master_admin") {
      return c.json({ error: "Only Master Admin can impersonate users" }, 403);
    }

    const { target_user_id } = await c.req.json();
    if (!target_user_id) {
      return c.json({ error: "target_user_id is required" }, 400);
    }

    if (payload.id === target_user_id) {
      return c.json({ error: "Cannot impersonate yourself" }, 400);
    }

    // Fetch target user details
    const targetResult = await client.queryObject(`
      SELECT id, display_name, role, client_id, email
      FROM "user"
      WHERE id = $1
      LIMIT 1
    `, [target_user_id]);

    if (targetResult.rows.length === 0) {
      return c.json({ error: "Target user not found" }, 404);
    }

    const targetUser = targetResult.rows[0] as any;

    if (targetUser.role === "master_admin") {
      return c.json({ error: "Cannot impersonate another Master Admin" }, 403);
    }

    // Generate new token with target identity but keep impersonator_id for audit logs
    const newToken = await sign({ 
      id: targetUser.id, 
      email: targetUser.email, 
      client_id: targetUser.client_id, 
      role: targetUser.role, 
      impersonator_id: payload.id, // Audit trail
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 2 // 2-hour impersonation session
    }, JWT_SECRET, "HS256");

    return c.json({ 
      token: newToken, 
      user: { 
        id: targetUser.id, 
        email: targetUser.email, 
        client_id: targetUser.client_id, 
        role: targetUser.role,
        is_impersonating: true
      } 
    });

  } catch (e: any) {
    console.error("[auth/impersonate] Error:", e);
    return c.json({ error: "Invalid token or server error" }, 401);
  }
});
