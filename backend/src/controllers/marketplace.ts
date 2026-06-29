import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { base44ORM as base44 } from "../db/orm.ts";

export const marketplaceRouter = new Hono();

// Auth Middleware
marketplaceRouter.use("*", async (c, next) => {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) return c.json({ error: "Server config error" }, 500);
  const jwtMiddleware = jwt({ secret });
  return await jwtMiddleware(c, next);
});

marketplaceRouter.post("/request", async (c) => {
  try {
    const user = c.get("jwtPayload");
    const { service_id, billing_cycle } = await c.req.json();

    if (!service_id || !billing_cycle) {
      return c.json({ data: { error: "service_id and billing_cycle required" } }, 400);
    }

    const service = await base44.entities.MarketplaceService.get(service_id);
    if (!service) {
      return c.json({ data: { error: "Service not found" } }, 404);
    }

    const amountKey = `pricing_${billing_cycle}`;
    const amount = service[amountKey];

    if (amount === undefined) {
      return c.json({ data: { error: `Invalid billing cycle or missing pricing for ${billing_cycle}` } }, 400);
    }

    const subscription = await base44.entities.ClientAddonSubscription.create({
      client_id: user.client_id,
      service_id,
      billing_cycle,
      amount,
      status: "pending_approval",
      start_date: new Date().toISOString()
    });

    return c.json({ data: { success: true, subscription } }, 201);
  } catch (error: any) {
    return c.json({ data: { error: error.message } }, 500);
  }
});

marketplaceRouter.post("/approve", async (c) => {
  try {
    const user = c.get("jwtPayload");
    const { subscription_id } = await c.req.json();

    if (user.role !== "master_admin" && user.role !== "admin") {
      return c.json({ data: { error: "Unauthorized" } }, 403);
    }

    const subscription = await base44.entities.ClientAddonSubscription.get(subscription_id);
    if (!subscription) {
      return c.json({ data: { error: "Subscription not found" } }, 404);
    }

    if (subscription.status !== "pending_approval") {
      return c.json({ data: { error: "Subscription is not pending approval" } }, 400);
    }

    const client = await base44.entities.Client.get(subscription.client_id);
    if (!client) {
      return c.json({ data: { error: "Client not found" } }, 404);
    }

    const amount = subscription.amount;

    if (client.wallet_balance < amount) {
      return c.json({ data: { error: "Client has insufficient wallet balance" } }, 400);
    }

    // Deduct from wallet
    const newBalance = client.wallet_balance - amount;
    await base44.entities.Client.update(client.id, { wallet_balance: newBalance });

    // Log the usage
    const service = await base44.entities.MarketplaceService.get(subscription.service_id);
    await base44.entities.UsageLog.create({
      client_id: client.id,
      type: "addon_subscription",
      description: `Marketplace Add-on: ${service?.name || "Unknown Service"} (${subscription.billing_cycle})`,
      amount_inr: amount,
      timestamp: new Date().toISOString()
    });

    // Calculate next billing date
    const now = new Date();
    let nextBillingDate = new Date();
    if (subscription.billing_cycle === "monthly") {
      nextBillingDate.setMonth(now.getMonth() + 1);
    } else if (subscription.billing_cycle === "quarterly") {
      nextBillingDate.setMonth(now.getMonth() + 3);
    } else if (subscription.billing_cycle === "semi_annual") {
      nextBillingDate.setMonth(now.getMonth() + 6);
    } else if (subscription.billing_cycle === "yearly") {
      nextBillingDate.setFullYear(now.getFullYear() + 1);
    } else if (subscription.billing_cycle === "one_time") {
      // For one-time, we set next_billing_date far into the future or leave it null (we'll set 100 years for now to avoid cron picking it up)
      nextBillingDate.setFullYear(now.getFullYear() + 100);
    }

    const updatedSub = await base44.entities.ClientAddonSubscription.update(subscription.id, {
      status: "active",
      approved_by: user.id,
      start_date: now.toISOString(),
      next_billing_date: nextBillingDate.toISOString()
    });

    return c.json({ data: { success: true, subscription: updatedSub, new_balance: newBalance } }, 200);
  } catch (error: any) {
    return c.json({ data: { error: error.message } }, 500);
  }
});
