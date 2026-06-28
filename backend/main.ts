import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { connectDB } from "./src/db/index.ts";
import { v1Router } from "./src/controllers/v1.ts";
import { resellerRouter } from "./src/controllers/reseller.ts";
import { authRouter } from "./src/controllers/auth.ts";
import { voiceRouter } from "./src/controllers/voice.ts";
import { integrationRouter } from "./src/controllers/integration.ts";
import { calendarRouter } from "./src/controllers/calendar.ts";
import { campaignRouter } from "./src/controllers/campaign.ts";
import { crmRouter } from "./src/controllers/crm.ts";
import { voiceWebhookRouter } from "./src/controllers/voiceWebhook.ts";
import { whatsappRouter } from "./src/controllers/whatsapp.ts";
import { telegramRouter } from "./src/controllers/telegram.ts";
import { billingRouter } from "./src/controllers/billing.ts";
import { agentsRouter } from "./src/controllers/agents.ts";
import { functionsRouter } from "./src/controllers/functions.ts";
import { analyticsRouter } from "./src/controllers/analytics.ts";
import { initCampaignPoller } from "./src/cron/campaignPoller.ts";
import { initCrmPoller } from "./src/cron/crmPoller.ts";
import { initBillingSweeper } from "./src/cron/billingSweeper.ts";
import { initDailyDigest } from "./src/cron/dailyDigest.ts";
import { initActivityDispatcher } from "./src/cron/activityDispatcher.ts";
import { initTicketAutoResponder } from "./src/cron/ticketAutoResponder.ts";
import { initDpdpErasure } from "./src/cron/dpdpErasure.ts";
import { handleWebSocket } from "./src/services/realtime.ts";
import { initStreamSession } from "./src/controllers/voice.ts";
import { daprRouter } from "./src/controllers/dapr.ts";

const app = new Hono();

// ─── WSS URL Helper ────────────────────────────────────────────────────────────
const wssUrlHandler = async (c: any) => {
  const appBaseUrl = Deno.env.get('APP_BASE_URL'); // e.g. "edvice.in"
  const xForwardedHost = c.req.header('x-forwarded-host');
  const hostHeader = c.req.header('host');
  const host = appBaseUrl || xForwardedHost || hostHeader || '';

  if (!host || host.includes('localhost') || host.includes('127.0.0.1')) {
    console.warn(`[WSS] WARNING: host resolved to "${host}" — APP_BASE_URL env var may not be set!`);
  }

  let cid = '';
  if (c.req.method === 'POST') {
    try {
      const bd = await c.req.json();
      cid = bd.call_log_id || bd.custom_identifier || bd.callLogId || bd.customData || '';
    } catch (_) {}
  } else {
    cid = c.req.query('call_log_id') || c.req.query('custom_identifier') || '';
  }
  const wssUrl = `wss://${host}/api/voice/stream${cid ? '?call_log_id=' + encodeURIComponent(cid) : ''}`;
  console.log(`[WSS] Responding with wss_url: ${wssUrl}`);
  return c.json({ success: true, wss_url: wssUrl }, 200);
};

// ─── HTTP routes (non-WebSocket) ───────────────────────────────────────────────
app.post("/api/voice/stream", wssUrlHandler);
app.post("/api/voice/incoming", wssUrlHandler);
app.get("/api/voice/incoming", wssUrlHandler);

// GET /api/voice/stream → returns WSS URL info (WebSocket upgrade handled at Deno.serve level)
app.get("/api/voice/stream", wssUrlHandler);

app.use('*', async (c, next) => {
  return logger()(c, next);
});

app.use("*", async (c, next) => {
  return cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })(c, next);
});

// ─── Rate Limiting ─────────────────────────────────────────────────────────────
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: any, next: any) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
                c.req.header('x-real-ip') || 'unknown';
    const key = `${c.req.path}:${ip}`;
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > maxRequests) {
        return c.json({ success: false, error: 'Too many requests. Please wait before trying again.' }, 429);
      }
    }
    return next();
  };
}

// Auth: 10 attempts per 15 minutes
app.use('/api/auth/login', rateLimit(10, 15 * 60 * 1000));
app.use('/api/auth/signup', rateLimit(5, 60 * 60 * 1000));
app.use('/api/auth/forgot-password', rateLimit(5, 60 * 60 * 1000));
// Outbound calls: 60 per minute per IP
app.use('/api/campaign/initiate-call', rateLimit(60, 60 * 1000));
// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitStore) {
    if (now > val.resetAt) rateLimitStore.delete(key);
  }
}, 3600 * 1000);

app.use('/assets/*', serveStatic({ root: './dist' }));

app.get('/api/health', (c) => {
  return c.text('OK');
});

app.get('/api/realtime', (c) => {
  // Handled at Deno.serve level — this fallback should never be hit
  return c.text("WebSocket upgrade required", 400);
});

app.route("/api/auth", authRouter);
app.route("/api/v1", v1Router);
app.route("/api/reseller", resellerRouter);
app.route("/api/voice", voiceRouter);
app.route("/api/webhook", voiceWebhookRouter);
app.route("/api/campaign", campaignRouter);
app.route("/api/crm", crmRouter);
app.route("/api/v1/integrations", integrationRouter);
app.route("/api/v1/calendar", calendarRouter);
app.route("/api/v1/analytics", analyticsRouter);
app.route("/api/whatsapp", whatsappRouter);
app.route("/api/telegram", telegramRouter);
app.route("/api/billing", billingRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/functions", functionsRouter);
app.route("/api/dapr", daprRouter);
app.route("/dapr", daprRouter); // Dapr sidecar natively calls GET /dapr/subscribe

app.get('*', async (c, next) => {
  if (c.req.path.startsWith('/api/')) {
    return await next();
  }
  try {
    if (c.req.path !== '/' && c.req.path !== '') {
      try {
        const fileInfo = await Deno.stat(`./dist${c.req.path}`);
        if (fileInfo.isFile) {
          return await serveStatic({ root: './dist' })(c, next);
        }
      } catch { /* file not found, fallback to index.html */ }
    }
    const content = await Deno.readTextFile('./dist/index.html');
    return c.html(content);
  } catch (e) {
    return c.text("BolifyAI API is running. Frontend dist/ not found.");
  }
});

app.onError((err, c) => {
  // Hono's jwt() middleware throws HTTPException with the correct status code (e.g. 401).
  // We must pass that through instead of always returning 500.
  const status = (err as any).status;
  if (status && status >= 400 && status < 600) {
    return c.json({ error: err.message }, status);
  }
  console.error(`[Server Error] ${err}`);
  return c.json({ error: err.message }, 500);
});

// Initialize background scheduled tasks
initCampaignPoller();
initCrmPoller();
initBillingSweeper(); // Handles trial expiry + subscription sweeping (trialExpiryCheck merged here)
initDailyDigest();
initActivityDispatcher();
initTicketAutoResponder();
initDpdpErasure(); // DPDP Act 2023 automated PII erasure

// Start DB connection
connectDB().catch(console.error);

const port = Number(Deno.env.get("PORT")) || 8000;

// ─── WebSocket upgrade handled at Deno.serve level (BEFORE Hono) ──────────────
// This is the only reliable way to handle WebSocket upgrades with Deno.
// Hono cannot pass through the raw WebSocket Response object.
Deno.serve({ port, hostname: "0.0.0.0" }, async (req: Request) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  // Handle /api/voice/stream WebSocket upgrade
  // CRITICAL: Deno.upgradeWebSocket MUST be called synchronously — no await before it.
  // Wrapping in an async function (even without await) defers execution to a microtask,
  // causing Deno to reject the upgrade with 503.
  if (url.pathname === "/api/voice/stream" && upgradeHeader.toLowerCase() === "websocket") {
    console.log(`[WS] Upgrade: /api/voice/stream from ${req.headers.get("x-forwarded-for") || "unknown"}`);
    const { socket, response } = Deno.upgradeWebSocket(req);
    // initStreamSession is async — runs AFTER the response is returned to the client
    initStreamSession(socket, url).catch(e => console.error("[WS] Session init error:", e));
    return response;
  }

  // Handle /api/realtime WebSocket upgrade
  if (url.pathname === "/api/realtime" && upgradeHeader.toLowerCase() === "websocket") {
    try {
      const { socket, response } = Deno.upgradeWebSocket(req);
      handleWebSocket(socket as any);
      return response;
    } catch (e: any) {
      console.error("[WS] Realtime upgrade error:", e.message);
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  // All other requests → Hono
  return app.fetch(req);
});
