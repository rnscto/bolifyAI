import { Context, Hono } from "hono";
import { jwt } from "hono/jwt";
import { base44ORM as base44 } from "../db/orm.ts";

export const resellerRouter = new Hono();
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

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

import { bindCustomDomain } from "../services/azureContainerService";

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
    return c.json({ error: err.message || "Failed to bind custom domain" }, 500);
  }
});