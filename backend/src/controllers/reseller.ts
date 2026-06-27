import { Context, Hono } from "hono";
import { jwt } from "hono/jwt";
import { base44ORM as base44 } from "../db/orm.ts";
import { writeAuditLog } from "../utils/auditLog.ts";

export const resellerRouter = new Hono();
const JWT_SECRET = (() => {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) console.warn("[SECURITY WARNING] JWT_SECRET not set in reseller.ts!");
  return secret || "super_secret_bolifyai_key_CHANGE_IN_PRODUCTION";
})();

// Use JWT middleware for all routes
resellerRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

// POST /api/reseller/downlines/:id/pricing
resellerRouter.post("/downlines/:id/pricing", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const downlineId = c.req.param("id");
    const { per_minute_rate, monthly_rate_per_channel } = await c.req.json();

    const resellerClient = await base44.entities.Client.get(user.client_id);
    const downlineClient = await base44.entities.Client.get(downlineId);

    if (!resellerClient || !downlineClient) return c.json({ error: "Client not found" }, 404);
    if (downlineClient.upline_id !== user.client_id) return c.json({ error: "Unauthorized. Not your downline." }, 403);

    // Validate pricing (Reseller cannot sell below their own buy rate)
    if (per_minute_rate < Number(resellerClient.per_minute_rate || 2.5)) {
      return c.json({ error: "Cannot set rate below your own cost rate." }, 400);
    }
    if (monthly_rate_per_channel < Number(resellerClient.monthly_rate_per_channel || 6500)) {
      return c.json({ error: "Cannot set monthly rate below your own cost rate." }, 400);
    }

    await base44.entities.Client.update(downlineId, {
      per_minute_rate,
      monthly_rate_per_channel
    });

    await writeAuditLog({
      client_id: downlineId,
      action_type: 'PRICING_UPDATE',
      entity_type: 'client',
      entity_id: downlineId,
      actor_email: user.email,
      actor_role: user.role || 'reseller',
      details: `Reseller ${user.client_id} updated pricing: ₹${per_minute_rate}/min, ₹${monthly_rate_per_channel}/ch/mo`,
    });

    return c.json({ success: true, message: "Pricing updated successfully" });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/reseller/topup-downline
resellerRouter.post("/topup-downline", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const { downline_id, amount } = await c.req.json();

    if (amount <= 0) return c.json({ error: "Amount must be greater than 0" }, 400);

    const resellerClient = await base44.entities.Client.get(user.client_id);
    if (!resellerClient) return c.json({ error: "Reseller not found" }, 404);

    const downlineClient = await base44.entities.Client.get(downline_id);
    if (!downlineClient || downlineClient.upline_id !== user.client_id) {
      return c.json({ error: "Downline not found or unauthorized" }, 403);
    }

    const currentCommBal = Number(resellerClient.commission_balance || 0);
    if (currentCommBal < amount) {
      return c.json({ error: "Insufficient commission balance" }, 400);
    }

    // Deduct from reseller
    await base44.entities.Client.update(user.client_id, {
      commission_balance: currentCommBal - amount
    });

    // Credit to downline
    const downlineBal = Number(downlineClient.wallet_balance || 0);
    await base44.entities.Client.update(downline_id, {
      wallet_balance: downlineBal + amount
    });

    // Record in ledger
    await base44.entities.CommissionLedger.create({
      transaction_id: `TOPUP-${Date.now()}`,
      from_client_id: user.client_id,
      to_reseller_id: downline_id,
      amount: amount,
      status: 'completed',
      type: 'topup_use'
    });

    // Create UsageLog for downline
    await base44.entities.UsageLog.create({
      client_id: downline_id,
      type: "topup",
      direction: "credit",
      amount: amount,
      balance_before: downlineBal,
      balance_after: downlineBal + amount,
      description: `Wallet top-up via Reseller Commission`
    });

    await writeAuditLog({
      client_id: downline_id,
      action_type: 'WALLET_TOPUP',
      entity_type: 'client',
      entity_id: downline_id,
      actor_email: user.email,
      actor_role: user.role || 'reseller',
      details: `Reseller ${user.client_id} topped up downline wallet by ₹${amount}`,
      metadata: { amount, reseller_id: user.client_id },
    });

    return c.json({ success: true, new_balance: currentCommBal - amount });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/reseller/commissions
resellerRouter.get("/commissions", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const client = await base44.entities.Client.get(user.client_id);
    if (!client) return c.json({ error: "Client not found" }, 404);

    const ledger = await base44.entities.CommissionLedger.filter({ to_reseller_id: user.client_id });

    return c.json({
      success: true,
      balance: client.commission_balance || 0,
      history: ledger
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/reseller/pricing-limits
resellerRouter.get("/pricing-limits", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const client = await base44.entities.Client.get(user.client_id);
    if (!client) return c.json({ error: "Client not found" }, 404);
    
    return c.json({
      success: true,
      min_per_minute_rate: Number(client.per_minute_rate || 2.5),
      min_monthly_rate_per_channel: Number(client.monthly_rate_per_channel || 6500)
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/reseller/admin/pay-commission
resellerRouter.post("/admin/pay-commission", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    if (user.role !== "admin" && user.role !== "master_admin") return c.json({ error: "Admin access required" }, 403);

    const { reseller_id, amount, payment_reference } = await c.req.json();
    if (!reseller_id || !amount) return c.json({ error: "Missing required fields" }, 400);

    const resellerClient = await base44.entities.Client.get(reseller_id);
    if (!resellerClient) return c.json({ error: "Reseller not found" }, 404);

    const currentCommBal = Number(resellerClient.commission_balance || 0);
    if (currentCommBal < amount) return c.json({ error: "Amount exceeds current balance" }, 400);

    // Deduct
    await base44.entities.Client.update(reseller_id, {
      commission_balance: currentCommBal - amount
    });

    // Log payout
    await base44.entities.CommissionLedger.create({
      transaction_id: payment_reference || `PAYOUT-${Date.now()}`,
      from_client_id: "ADMIN",
      to_reseller_id: reseller_id,
      amount: amount,
      status: 'paid',
      type: 'payout'
    });

    return c.json({ success: true, new_balance: currentCommBal - amount });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

import { bindCustomDomain, getAzureEnvironmentDetails } from "../services/azureContainerService.ts";

// GET /api/reseller/custom-domain-config
resellerRouter.get("/custom-domain-config", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    if (user.role !== "reseller" && user.role !== "master_reseller") {
      return c.json({ error: "Only resellers can manage custom domains" }, 403);
    }
    const config = await getAzureEnvironmentDetails();
    return c.json(config);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/reseller/custom-domain
resellerRouter.post("/custom-domain", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    if (user.role !== "reseller" && user.role !== "master_reseller") {
      return c.json({ error: "Only resellers can manage custom domains" }, 403);
    }

    const { custom_domain } = await c.req.json();
    if (!custom_domain) return c.json({ error: "Missing custom_domain" }, 400);

    // Call the Azure Container SDK to provision and bind the domain dynamically
    const result = await bindCustomDomain(custom_domain);

    // Once successfully bound in Azure, save it to our DomainMapping database
    const existingMappings = await base44.entities.DomainMapping.filter({ reseller_id: user.client_id });
    if (existingMappings.length > 0) {
      await base44.entities.DomainMapping.update(existingMappings[0].id, { custom_domain });
    } else {
      await base44.entities.DomainMapping.create({
        reseller_id: user.client_id,
        custom_domain,
        brand_name: "My Reseller Platform",
        theme_colors: {},
      });
    }

    return c.json(result);
  } catch (err: any) {
    console.error("[Custom Domain Binding Error]", err);
    let errorMsg = err.message || "Failed to bind custom domain";
    
    // Check if it's an Azure DNS validation error
    if (errorMsg.includes("CustomDomainVerificationFailed")) {
      errorMsg = "Domain verification failed. Please ensure you have added the required TXT and CNAME records and wait a few minutes for DNS to propagate.";
    }
    
    return c.json({ error: errorMsg }, 500);
  }
});// POST /api/reseller/admin/promote
resellerRouter.post("/admin/promote", async (c) => {
  try {
    const admin = c.get("jwtPayload") as any;
    if (admin.role !== "admin" && admin.role !== "master_admin") {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const { client_id, new_role } = await c.req.json();
    if (!client_id || !new_role) return c.json({ error: "Missing required fields" }, 400);
    if (!["reseller", "master_reseller"].includes(new_role)) return c.json({ error: "Invalid role" }, 400);

    const client = await base44.entities.Client.get(client_id);
    if (!client) return c.json({ error: "Client not found" }, 404);

    let user = null;
    if (client.user_id) {
      user = await base44.entities.User.get(client.user_id);
    } else {
      const users = await base44.entities.User.filter({ client_id: client.id });
      if (users.length > 0) user = users[0];
    }
    if (!user) return c.json({ error: "User not found" }, 404);

    // Update User role
    await base44.entities.User.update(user.id, { role: new_role });

    // Update Client account_type to business if not already
    if (client.account_type !== "business") {
      await base44.entities.Client.update(client.id, { account_type: "business" });
    }

    // Check if Partner record exists
    const partners = await base44.entities.Partner.filter({ user_id: user.id });
    if (partners.length === 0) {
      const code = 'BOLIFY-' + (user.name || 'PARTNER').split(' ')[0].toUpperCase().substring(0, 6) + Math.floor(1000 + Math.random() * 9000);
      await base44.entities.Partner.create({
        user_id: user.id,
        name: user.name || client.company_name || 'Reseller',
        email: user.email || client.email,
        phone: client.phone || user.phone || '',
        company_name: client.company_name || user.name || 'Reseller',
        status: "approved",
        commission_rate: new_role === "master_reseller" ? 30 : 20,
        referral_code: code,
        referral_link: `https://app.bolify.ai/?ref=${code}`
      });
    } else {
      // update commission rate if it's a promotion
      await base44.entities.Partner.update(partners[0].id, {
         commission_rate: new_role === "master_reseller" ? 30 : 20,
      });
    }

    return c.json({ success: true, message: `Successfully promoted to ${new_role.replace('_', ' ')}` });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/reseller/custom-domain
resellerRouter.get("/custom-domain", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    if (user.role !== "reseller" && user.role !== "master_reseller") {
      return c.json({ error: "Only resellers can view custom domains" }, 403);
    }
    const mappings = await base44.entities.DomainMapping.filter({ reseller_id: user.client_id });
    return c.json(mappings.length > 0 ? mappings[0] : null);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
