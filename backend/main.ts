import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { connectDB } from "./src/db/index.ts";
import { entityRouter } from "./src/controllers/entity.ts";
import { authRouter } from "./src/controllers/auth.ts";
import { voiceRouter } from "./src/controllers/voice.ts";
import { integrationRouter } from "./src/controllers/integration.ts";
import { campaignRouter } from "./src/controllers/campaign.ts";
import { crmRouter } from "./src/controllers/crm.ts";
import { voiceWebhookRouter } from "./src/controllers/voiceWebhook.ts";
import { whatsappRouter } from "./src/controllers/whatsapp.ts";
import { telegramRouter } from "./src/controllers/telegram.ts";
import { billingRouter } from "./src/controllers/billing.ts";
import { agentsRouter } from "./src/controllers/agents.ts";
import { functionsRouter } from "./src/controllers/functions.ts";
import { initCampaignPoller } from "./src/cron/campaignPoller.ts";
import { initCrmPoller } from "./src/cron/crmPoller.ts";
import { initTrialExpiryCheck } from "./src/cron/trialExpiryCheck.ts";
import { initBillingSweeper } from "./src/cron/billingSweeper.ts";
import { initDailyDigest } from "./src/cron/dailyDigest.ts";

const app = new Hono();

app.get('/api/realtime', (c) => {
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("Expected WebSocket", 400);
  }
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  handleWebSocket(socket as any);
  return response as any;
});

import { streamHandler } from "./src/controllers/voice.ts";

const wssUrlHandler = async (c: any) => {
  // Priority: 1) APP_BASE_URL env (set in Azure), 2) x-forwarded-host (set by reverse proxy), 3) host header
  // Never fallback to 'localhost' — if none available, fail clearly
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
  } else if (c.req.method === 'GET') {
    cid = c.req.query('call_log_id') || c.req.query('custom_identifier') || '';
  }
  const wssUrl = `wss://${host}/api/voice/stream${cid ? '?call_log_id=' + encodeURIComponent(cid) : ''}`;
  console.log(`[WSS] Responding with wss_url: ${wssUrl}`);
  return c.json({
    success: true,
    wss_url: wssUrl
  }, 200);
};

app.post("/api/voice/stream", wssUrlHandler);
app.post("/api/voice/incoming", wssUrlHandler);
app.get("/api/voice/incoming", wssUrlHandler);
// Note: GET /api/voice/stream is handled by streamHandler for WS upgrade, but if not WS, it will be handled there.
app.get("/api/voice/stream", streamHandler);

app.use("*", async (c, next) => {
  return logger()(c, next);
});

app.use("*", async (c, next) => {
  return cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })(c, next);
});

app.use('/assets/*', serveStatic({ root: './dist' }));

app.get('/api/health', (c) => {
  return c.text('OK');
});

import { handleWebSocket } from "./src/services/realtime.ts";

app.route("/api/auth", authRouter);
app.route("/api/entities", entityRouter);
app.route("/api/voice", voiceRouter);
app.route("/api/webhook", voiceWebhookRouter);
app.route("/api/campaign", campaignRouter);
app.route("/api/crm", crmRouter);
app.route("/api/whatsapp", whatsappRouter);
app.route("/api/telegram", telegramRouter);
app.route("/api/billing", billingRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/functions", functionsRouter);

app.route("/api/functions", functionsRouter);

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

// Initialize background scheduled tasks
initCampaignPoller();
initCrmPoller();
initTrialExpiryCheck();
initBillingSweeper();
initDailyDigest();

app.onError((err, c) => {
  console.error(`${err}`);
  return c.json({ error: err.message }, 500);
});

// Start DB connection
connectDB().catch(console.error);

const port = Number(Deno.env.get("PORT")) || 8000;
Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);

