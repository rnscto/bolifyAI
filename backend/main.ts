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

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/voice/stream")) {
    return await next();
  }
  return logger()(c, next);
});

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/voice/stream")) {
    return await next();
  }
  return cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })(c, next);
});

app.use('/assets/*', serveStatic({ root: './dist' }));

app.get('/api/health', (c) => {
  return c.text('OK');
});

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
Deno.serve({ port, hostname: "0.0.0.0" }, (req: Request, info: any) => {
  console.log(`[RAW HTTP] ${req.method} ${req.url} from ${info?.remoteAddr?.hostname}`);
  return app.fetch(req, info);
});
