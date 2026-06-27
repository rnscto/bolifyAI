import { Context, Hono } from "hono";
import { jwt } from "hono/jwt";
import { base44ORM as base44 } from "../db/orm.ts";
import { distributeCommission } from "../utils/commissionDistributor.ts";
import { PDFDocument, rgb, StandardFonts } from "npm:pdf-lib";

export const billingRouter = new Hono();

const JWT_SECRET = (() => {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) console.warn("[SECURITY WARNING] JWT_SECRET env var not set in billing.ts!");
  return secret || "super_secret_bolifyai_key_CHANGE_IN_PRODUCTION";
})();
const CEO_EMAIL = "yadavnand886@gmail.com";
const CASHFREE_APP_ID = Deno.env.get("CASHFREE_APP_ID");
const CASHFREE_SECRET_KEY = Deno.env.get("CASHFREE_SECRET_KEY");
const CASHFREE_ENV = Deno.env.get("CASHFREE_ENVIRONMENT") || "sandbox";
const CASHFREE_BASE_URL = CASHFREE_ENV === "production" ? "https://api.cashfree.com" : "https://sandbox.cashfree.com";

// POST /api/billing/create-payment-order
billingRouter.post("/create-payment-order", jwt({ secret: JWT_SECRET, alg: "HS256" }), async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const { channels, plan_type, include_crm } = await c.req.json();

    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (!clients.length) return c.json({ error: "Client not found" }, 404);
    const client = clients[0];

    // Use client's actual rate (set by reseller or admin). Default: ₹6500/channel.
    const ratePerChannel = Number(client.monthly_rate_per_channel || 6500);
    const crmRate = include_crm ? (Number(client.crm_monthly_rate || 1999)) : 0;
    const months = plan_type === "quarterly" ? 3 : 1;
    const totalAmount = ((channels || 1) * ratePerChannel * months) + (crmRate * months);

    const orderId = `order_${client.id}_${Date.now()}`;
    const cfResponse = await fetch(`${CASHFREE_BASE_URL}/pg/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": CASHFREE_APP_ID || "",
        "x-client-secret": CASHFREE_SECRET_KEY || "",
        "x-api-version": "2023-08-01",
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: totalAmount,
        order_currency: "INR",
        customer_details: {
          customer_id: client.id,
          customer_name: user.full_name || client.company_name,
          customer_email: client.email,
          customer_phone: client.phone || "9999999999",
        },
        order_meta: {
          return_url: `${c.req.header("origin") || "https://app.base44.com"}/ClientSubscription?order_id=${orderId}&status={order_status}`,
        },
        order_note: `VaaniAI - ${channels} channel(s) ${plan_type}${include_crm ? " + CRM" : ""}`,
      }),
    });

    const cfData = await cfResponse.json();
    if (!cfResponse.ok) return c.json({ error: "Failed to create payment order", details: cfData }, 500);

    const payment = await base44.entities.Payment.create({
      client_id: client.id,
      cashfree_order_id: orderId,
      amount: totalAmount,
      currency: "INR",
      status: "pending",
      payment_session_id: cfData.payment_session_id,
      description: JSON.stringify({ channels: channels || 1, include_crm: !!include_crm, rate_per_channel: ratePerChannel, crm_rate: crmRate, months }),
    });

    return c.json({ order_id: orderId, payment_session_id: cfData.payment_session_id, payment_id: payment.id, amount: totalAmount, environment: CASHFREE_ENV });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/billing/verify-payment
billingRouter.post("/verify-payment", jwt({ secret: JWT_SECRET, alg: "HS256" }), async (c) => {
  try {
    const { order_id } = await c.req.json();
    if (!order_id) return c.json({ error: "order_id is required" }, 400);

    const cfResponse = await fetch(`${CASHFREE_BASE_URL}/pg/orders/${order_id}`, {
      headers: {
        "x-client-id": CASHFREE_APP_ID || "",
        "x-client-secret": CASHFREE_SECRET_KEY || "",
        "x-api-version": "2023-08-01",
      },
    });

    const cfData = await cfResponse.json();
    if (!cfResponse.ok) return c.json({ error: "Failed to verify order", details: cfData }, 500);

    const payments = await base44.entities.Payment.filter({ cashfree_order_id: order_id });
    if (!payments.length) return c.json({ error: "Payment record not found" }, 404);
    const payment = payments[0];

    const isPaid = cfData.order_status === "PAID";

    if (isPaid) {
      await base44.entities.Payment.update(payment.id, {
        status: "paid", cashfree_payment_id: cfData.cf_order_id?.toString(), paid_at: new Date().toISOString(),
      });

      let planDetails: any = {};
      try { planDetails = JSON.parse(payment.description); } catch (e) { }

      if (planDetails.type === "wallet_topup") {
        const topupAmount = planDetails.amount || payment.amount;
        const client = await base44.entities.Client.get(payment.client_id);
        const newBalance = (client?.wallet_balance || 0) + topupAmount;

        await base44.entities.Client.update(payment.client_id, { wallet_balance: newBalance });
        await base44.entities.UsageLog.create({
          client_id: payment.client_id, type: "topup", direction: "credit", amount: topupAmount,
          balance_before: client?.wallet_balance || 0, balance_after: newBalance, description: `Wallet top-up ₹${topupAmount}`, payment_id: payment.id,
        });

        console.log(`[Verify Payment] Processed Topup for ${payment.client_id}: ₹${topupAmount}`);
        await distributeCommission(payment.id, payment.client_id, Number(topupAmount), 1, true);

        return c.json({ status: "paid", type: "wallet_topup", order_status: cfData.order_status, amount: topupAmount, new_balance: newBalance });
      }

      let subscribedChannels = planDetails.channels || 1;
      let includeCRM = planDetails.include_crm || false;
      const now = new Date();
      const billingEnd = new Date(now);
      billingEnd.setMonth(billingEnd.getMonth() + (planDetails.months || 3));

      await base44.entities.Client.update(payment.client_id, {
        account_status: "active", status: "active", billing_type: "unlimited",
        total_channels: subscribedChannels, monthly_rate_per_channel: 6500, has_custom_crm: includeCRM,
        next_billing_date: billingEnd.toISOString().split("T")[0],
      });

      const subs = await base44.entities.Subscription.filter({ client_id: payment.client_id });
      const subData = {
        client_id: payment.client_id, channels: subscribedChannels, rate_per_channel: 6500, total_amount: payment.amount,
        billing_start_date: now.toISOString().split("T")[0], billing_end_date: billingEnd.toISOString().split("T")[0],
        next_billing_date: billingEnd.toISOString().split("T")[0], status: "active", payment_status: "paid", payment_id: payment.id,
      };

      if (subs.length) await base44.entities.Subscription.update(subs[0].id, subData);
      else await base44.entities.Subscription.create(subData);

      console.log(`[Verify Payment] Processed Subscription for ${payment.client_id}`);
      await distributeCommission(payment.id, payment.client_id, Number(payment.amount), subscribedChannels, false);

      return c.json({ status: "paid", order_status: cfData.order_status, amount: payment.amount });
    } else {
      const newStatus = cfData.order_status === "EXPIRED" ? "failed" : "pending";
      await base44.entities.Payment.update(payment.id, { status: newStatus });
      return c.json({ status: newStatus, order_status: cfData.order_status });
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/billing/webhook
billingRouter.post("/webhook", async (c) => {
  try {
    const signature = c.req.header("x-webhook-signature");
    const timestamp = c.req.header("x-webhook-timestamp");
    const rawBody = await c.req.text();

    if (!signature || !timestamp) return c.json({ error: "Missing signature headers" }, 400);

    // Verify Cashfree Webhook Signature (requires Deno crypto/hmac)
    const encoder = new TextEncoder();
    const keyData = encoder.encode(CASHFREE_SECRET_KEY || "");
    const messageData = encoder.encode(timestamp + rawBody);

    const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, messageData);
    const generatedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    if (generatedSignature !== signature) {
      console.error("[Cashfree Webhook] Invalid signature");
      return c.json({ error: "Invalid signature" }, 401);
    }

    const payload = JSON.parse(rawBody);

    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
      const order_id = payload.data.order.order_id;
      const cashfree_payment_id = payload.data.payment.cf_payment_id?.toString();

      const payments = await base44.entities.Payment.filter({ cashfree_order_id: order_id });
      if (!payments.length) return c.json({ error: "Payment not found" }, 404);
      const payment = payments[0];

      if (payment.status === "paid") return c.json({ success: true, message: "Already processed" });

      await base44.entities.Payment.update(payment.id, {
        status: "paid", cashfree_payment_id: cashfree_payment_id, paid_at: new Date().toISOString(),
      });

      let planDetails: any = {};
      try { planDetails = JSON.parse(payment.description); } catch (e) { }

      if (planDetails.type === "wallet_topup") {
        const topupAmount = planDetails.amount || payment.amount;
        const client = await base44.entities.Client.get(payment.client_id);
        const newBalance = (Number(client?.wallet_balance) || 0) + Number(topupAmount);

        await base44.entities.Client.update(payment.client_id, { wallet_balance: newBalance });
        await base44.entities.UsageLog.create({
          client_id: payment.client_id, type: "topup", direction: "credit", amount: topupAmount,
          balance_before: Number(client?.wallet_balance) || 0, balance_after: newBalance, description: `Wallet top-up ₹${topupAmount}`, payment_id: payment.id,
        });

        console.log(`[Cashfree Webhook] Processed Topup for ${payment.client_id}: ₹${topupAmount}`);
        await distributeCommission(payment.id, payment.client_id, Number(topupAmount), 1, true);
        return c.json({ success: true });
      }

      let subscribedChannels = planDetails.channels || 1;
      let includeCRM = planDetails.include_crm || false;
      const now = new Date();
      const billingEnd = new Date(now);
      billingEnd.setMonth(billingEnd.getMonth() + (planDetails.months || 3));

      await base44.entities.Client.update(payment.client_id, {
        account_status: "active", status: "active", billing_type: "unlimited",
        total_channels: subscribedChannels, monthly_rate_per_channel: 6500, has_custom_crm: includeCRM,
        next_billing_date: billingEnd.toISOString().split("T")[0],
      });

      const subs = await base44.entities.Subscription.filter({ client_id: payment.client_id });
      const subData = {
        client_id: payment.client_id, channels: subscribedChannels, rate_per_channel: 6500, total_amount: payment.amount,
        billing_start_date: now.toISOString().split("T")[0], billing_end_date: billingEnd.toISOString().split("T")[0],
        next_billing_date: billingEnd.toISOString().split("T")[0], status: "active", payment_status: "paid", payment_id: payment.id,
      };

      if (subs.length) await base44.entities.Subscription.update(subs[0].id, subData);
      else await base44.entities.Subscription.create(subData);

      console.log(`[Cashfree Webhook] Processed Subscription for ${payment.client_id}`);
      await distributeCommission(payment.id, payment.client_id, Number(payment.amount), subscribedChannels, false);
      return c.json({ success: true });
    }

    return c.json({ success: true, message: "Ignored event type" });
  } catch (err: any) {
    console.error("[Cashfree Webhook] Error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/billing/submit-payment-approval
billingRouter.post("/submit-payment-approval", jwt({ secret: JWT_SECRET, alg: "HS256" }), async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    if ((user.role !== "admin" && user.role !== "master_admin") || (user.email || "").toLowerCase() !== CEO_EMAIL) {
      return c.json({ error: "Only the CEO admin may raise payment approval requests." }, 403);
    }

    const { request_type, client_id, amount, transaction_number, payment_method = "bank_transfer", payment_date, screenshot_url, request_notes = "", request_metadata = {} } = await c.req.json();
    if (!request_type || !client_id || !amount || !transaction_number) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    const client = await base44.entities.Client.get(client_id);
    if (!client) return c.json({ error: "Client not found" }, 404);

    const reqRec = await base44.entities.PaymentApprovalRequest.create({
      request_type, client_id, client_name: client.company_name, client_email: client.email, amount: Number(amount),
      transaction_number, payment_method, payment_date: payment_date || new Date().toISOString().split("T")[0],
      screenshot_url: screenshot_url || "", requested_by: user.email, request_notes, request_metadata, status: "pending", applied: false
    });

    if (request_type === "client_activation" && client.account_status !== "active") {
      await base44.entities.Client.update(client_id, { account_status: "activation_pending" }).catch(() => { });
    }

    return c.json({ success: true, id: reqRec.id, request: reqRec });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/billing/generate-invoice
billingRouter.post("/generate-invoice", jwt({ secret: JWT_SECRET, alg: "HS256" }), async (c) => {
  try {
    const { payment_id } = await c.req.json();
    if (!payment_id) return c.json({ error: "payment_id required" }, 400);

    const payments = await base44.entities.Payment.filter({ id: payment_id });
    if (!payments.length) return c.json({ error: "Payment not found" }, 404);
    const payment = payments[0];

    const clients = await base44.entities.Client.filter({ id: payment.client_id });
    const client = clients.length > 0 ? clients[0] : null;

    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]); // A4
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    
    page.drawRectangle({
      x: 0, y: 842 - 45,
      width: 595, height: 45,
      color: rgb(26/255, 54/255, 93/255)
    });

    page.drawText('VaaniAI', { x: 20, y: 842 - 25, size: 24, font: boldFont, color: rgb(1,1,1) });
    page.drawText('AI-Powered Voice & Sales Platform', { x: 20, y: 842 - 35, size: 10, font, color: rgb(1,1,1) });

    page.drawText('INVOICE', { x: 595 - 20 - 75, y: 842 - 25, size: 14, font, color: rgb(1,1,1) });
    page.drawText(`#INV-${payment.id.slice(-8).toUpperCase()}`, { x: 595 - 20 - 85, y: 842 - 35, size: 9, font, color: rgb(1,1,1) });
    
    const colorBlack = rgb(0,0,0);
    let y = 842 - 60;
    
    page.drawText('From:', { x: 20, y, size: 10, font: boldFont, color: colorBlack });
    page.drawText('Vaani AI Pvt Ltd', { x: 20, y: y - 12, size: 10, font, color: colorBlack });
    page.drawText('Ahmedabad, Gujarat, India', { x: 20, y: y - 24, size: 10, font, color: colorBlack });
    page.drawText('CIN: U62099GJ2025PTC161822', { x: 20, y: y - 36, size: 10, font, color: colorBlack });

    page.drawText('Bill To:', { x: 595 - 180, y, size: 10, font: boldFont, color: colorBlack });
    page.drawText(client?.company_name || 'N/A', { x: 595 - 180, y: y - 12, size: 10, font, color: colorBlack });
    page.drawText(client?.email || 'N/A', { x: 595 - 180, y: y - 24, size: 10, font, color: colorBlack });
    if (client?.phone) page.drawText(client.phone, { x: 595 - 180, y: y - 36, size: 10, font, color: colorBlack });

    y -= 60;
    page.drawLine({
      start: { x: 20, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });
    
    y -= 20;
    page.drawText(`Invoice Date: ${new Date(payment.created_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, { x: 20, y, size: 9, font, color: colorBlack });
    page.drawText(`Payment ID: ${payment.cashfree_payment_id || payment.cashfree_order_id || '-'}`, { x: 595 - 180, y, size: 9, font, color: colorBlack });
    
    y -= 12;
    page.drawText(`Status: ${(payment.status || '').toUpperCase()}`, { x: 20, y, size: 9, font, color: colorBlack });
    if (payment.paid_at) {
      page.drawText(`Paid On: ${new Date(payment.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, { x: 595 - 180, y, size: 9, font, color: colorBlack });
    }

    y -= 20;
    page.drawRectangle({
      x: 20, y: y - 5,
      width: 595 - 40, height: 15,
      color: rgb(245/255, 245/255, 245/255)
    });
    
    page.drawText('Description', { x: 25, y, size: 9, font: boldFont, color: colorBlack });
    page.drawText('Amount', { x: 595 - 60, y, size: 9, font: boldFont, color: colorBlack });
    
    y -= 20;
    page.drawText(payment.description || 'VaaniAI Subscription', { x: 25, y, size: 9, font, color: colorBlack });
    page.drawText(`Rs ${Number(payment.amount || 0).toLocaleString('en-IN')}`, { x: 595 - 60, y, size: 9, font, color: colorBlack });
    
    y -= 30;
    page.drawLine({
      start: { x: 595 - 120, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });
    
    y -= 20;
    page.drawText('Total:', { x: 595 - 120, y, size: 11, font: boldFont, color: colorBlack });
    page.drawText(`Rs ${Number(payment.amount || 0).toLocaleString('en-IN')}`, { x: 595 - 80, y, size: 11, font: boldFont, color: colorBlack });

    // Footer
    y = 50;
    page.drawLine({
      start: { x: 20, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });
    
    y -= 15;
    page.drawText('This is a computer-generated invoice and does not require a signature.', { x: 595/2 - 120, y, size: 8, font, color: rgb(120/255, 120/255, 120/255) });
    page.drawText('For queries, contact support@vaaniai.in', { x: 595/2 - 70, y: y - 10, size: 8, font, color: rgb(120/255, 120/255, 120/255) });

    const pdfBytes = await doc.save();

    return c.body(pdfBytes as any, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename=VaaniAI-Invoice-${payment.id.slice(-8)}.pdf`,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
