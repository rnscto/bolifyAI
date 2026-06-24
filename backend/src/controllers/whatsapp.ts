import { Context, Hono } from "hono";
import { jwt } from "hono/jwt";
import { base44ORM as base44 } from "../db/orm.ts";

export const whatsappRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

whatsappRouter.use("*", async (c, next) => {
  // Allow internal service bypass
  if (c.req.header("X-Internal-Secret") === Deno.env.get("CRON_API_KEY")) {
    c.set("jwtPayload", { role: "admin", client_id: "PLATFORM", id: "internal" });
    return next();
  }
  const jwtMiddleware = jwt({ secret: JWT_SECRET, alg: "HS256" });
  return jwtMiddleware(c, next);
});

// Helper to normalize phone
const normalizePhone = (p: string) => {
  let n = String(p || "").replace(/[^0-9]/g, "");
  if (n.length === 10) n = "91" + n;
  else if (n.length === 11 && n.startsWith("0")) n = "91" + n.slice(1);
  return n;
};

whatsappRouter.post("/send-template", async (c) => {
  try {
    const { template_id, recipient, variables, lead_id, call_log_id, outreach_type, internal_service } = await c.req.json();
    if (!template_id || !recipient) return c.json({ error: "template_id and recipient required" }, 400);

    const user = c.get("jwtPayload") as any;
    const template = await base44.entities.WhatsAppTemplate.get(template_id);
    if (!template) return c.json({ error: "Template not found" }, 404);

    if (!internal_service && user.role !== "admin" && user.client_id !== template.client_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (template.status !== "APPROVED") return c.json({ error: `Template is ${template.status}` }, 400);

    const configs = await base44.entities.ClientMessagingConfig.filter({ client_id: template.client_id });
    if (configs.length === 0) return c.json({ error: "No messaging config" }, 404);
    const cfg = configs[0];

    let lead: any = null;
    if (lead_id) {
      try { lead = await base44.entities.Lead.get(lead_id); } catch (_) {}
    }

    const interpolate = (val: any) => {
      if (!lead) return String(val);
      return String(val)
        .replace(/\{\{name\}\}/gi, lead.name || "")
        .replace(/\{\{company\}\}/gi, lead.company || "")
        .replace(/\{\{phone\}\}/gi, lead.phone || "")
        .replace(/\{\{email\}\}/gi, lead.email || "");
    };

    const apiKeyRaw = String(cfg.whatsapp_api_key || "").trim().replace(/^(Bearer|Basic)\s+/i, "");

    if (cfg.whatsapp_provider === "interakt") {
      let baseHost = String(cfg.whatsapp_api_endpoint || "").trim().replace(/\/+$/, "") || "https://api.interakt.ai";
      const url = `${baseHost}/v1/public/message/`;
      let digits = normalizePhone(recipient);
      if (digits.length < 11 || digits.length > 15) return c.json({ error: "Invalid phone" }, 400);
      
      const countryCode = "+" + digits.slice(0, digits.length - 10);
      const phoneNumber = digits.slice(-10);
      const bodyValues = (variables || []).map((v: any) => interpolate(v));
      const tmpl: any = { name: template.name, languageCode: template.language || "en" };
      if (bodyValues.length > 0) tmpl.bodyValues = bodyValues;

      const interaktBasicCredential = (rawKey: string) => {
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(rawKey) && rawKey.length % 4 === 0) {
          try {
            const decoded = atob(rawKey);
            return decoded.includes(":") ? rawKey : btoa(rawKey + ":");
          } catch (_) { return btoa(rawKey + ":"); }
        }
        return btoa(rawKey + ":");
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Basic ${interaktBasicCredential(apiKeyRaw)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ countryCode, phoneNumber, type: "Template", callbackData: call_log_id || lead_id || "", template: tmpl })
      });
      const data = await res.json();
      return c.json({ success: res.ok, message_id: data.id, details: data });
    }

    // Meta or RCS Digital
    const cleanRecipient = normalizePhone(recipient);
    const phoneNumberId = String(cfg.whatsapp_phone_number_id || "").trim();
    if (!phoneNumberId) return c.json({ error: "Phone Number ID is not configured" }, 400);

    const components: any[] = [];
    const vars = variables || [];
    if (vars.length > 0) {
      components.push({
        type: "body",
        parameters: vars.map((v: any) => ({ type: "text", text: interpolate(v) }))
      });
    }

    const rawEndpoint = String(cfg.whatsapp_api_endpoint || "").trim().replace(/\/+$/, "");
    const rcsHost = cfg.whatsapp_provider === "rcs_digital" && rawEndpoint ? (new URL(rawEndpoint).origin || rawEndpoint.replace(/\/v\d+\.\d+\/.*$/i, "")) : rawEndpoint;
    const baseUrl = cfg.whatsapp_provider === "rcs_digital"
      ? `${rcsHost || "https://rcsdigital.in"}/v23.0/${phoneNumberId}/messages`
      : `${rawEndpoint || "https://graph.facebook.com/v20.0"}/${phoneNumberId}/messages`.replace("/v20.0//", "/v20.0/");

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKeyRaw}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to: cleanRecipient, type: "template",
        template: { name: template.name, language: { code: template.language || "en" }, ...(components.length > 0 ? { components } : {}) }
      })
    });
    
    const data = await res.json();
    
    // Log outbound message asynchronously
    try {
      await base44.entities.OutreachLog.create({
        client_id: template.client_id, lead_id: lead_id || null, channel: "whatsapp", direction: "outbound", vendor: cfg.whatsapp_provider,
        status: res.ok ? "sent" : "failed", error_message: res.ok ? "" : JSON.stringify(data)
      });
    } catch (_) {}

    if (!res.ok) return c.json({ error: data.error?.message || "Send failed", details: data }, 400);

    return c.json({ success: true, message_id: data.messages?.[0]?.id, details: data });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

whatsappRouter.post("/list-templates", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const { client_id } = await c.req.json();
    if (!client_id) return c.json({ error: "client_id required" }, 400);
    if (user.role !== "admin" && user.client_id !== client_id) return c.json({ error: "Forbidden" }, 403);

    const configs = await base44.entities.ClientMessagingConfig.filter({ client_id });
    if (configs.length === 0) return c.json({ error: "No messaging config" }, 404);
    const cfg = configs[0];

    if (cfg.whatsapp_provider === "interakt") return c.json({ error: "Interakt does not support template listing API." }, 400);
    if (!["meta_cloud", "rcs_digital"].includes(cfg.whatsapp_provider)) return c.json({ error: "Unsupported provider" }, 400);

    const apiKey = String(cfg.whatsapp_api_key).trim().replace(/^Bearer\s+/i, "");
    const businessId = String(cfg.whatsapp_business_id).trim();

    const baseHost = cfg.whatsapp_provider === "rcs_digital" ? "https://rcsdigital.in/v23.0" : "https://graph.facebook.com/v20.0";
    const url = `${baseHost}/${businessId}/message_templates?limit=200`;

    const res = await fetch(url, { headers: { "Authorization": `Bearer ${apiKey}` } });
    const data = await res.json();
    if (!res.ok) return c.json({ error: "API rejected", details: data }, 400);

    // Sync to DB logic simplified
    let synced = 0;
    for (const t of (data.data || [])) {
       const key = `${t.name}_${t.language}`;
       const existing = await base44.entities.WhatsAppTemplate.filter({ client_id, name: t.name, language: t.language });
       if (existing.length === 0) {
           await base44.entities.WhatsAppTemplate.create({
             client_id, vendor: cfg.whatsapp_provider, meta_template_id: t.id, name: t.name, language: t.language,
             category: t.category, status: t.status
           });
           synced++;
       }
    }

    return c.json({ success: true, synced, total_meta: (data.data || []).length });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

whatsappRouter.post("/create-template", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const body = await c.req.json();
    const { client_id, name, language, category, body_text } = body;
    if (!client_id || !name || !category || !body_text) return c.json({ error: "Missing fields" }, 400);
    if (user.role !== "admin" && user.client_id !== client_id) return c.json({ error: "Forbidden" }, 403);

    const configs = await base44.entities.ClientMessagingConfig.filter({ client_id });
    if (configs.length === 0) return c.json({ error: "No messaging config" }, 404);
    const cfg = configs[0];

    const apiKey = String(cfg.whatsapp_api_key).trim().replace(/^Bearer\s+/i, "");
    const businessId = String(cfg.whatsapp_business_id).trim();
    const baseHost = cfg.whatsapp_provider === "rcs_digital" ? "https://rcsdigital.in/v23.0" : "https://graph.facebook.com/v20.0";
    
    const components = [{ type: "BODY", text: body_text }];

    const res = await fetch(`${baseHost}/${businessId}/message_templates`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9_]/g, "_"), language: language || "en", category, components })
    });
    
    const data = await res.json();
    if (!res.ok) return c.json({ error: "API rejected", details: data }, 400);

    const created = await base44.entities.WhatsAppTemplate.create({
      client_id, vendor: cfg.whatsapp_provider, meta_template_id: data.id, name: data.name, language: data.language,
      category, status: data.status || "PENDING", body_text
    });

    return c.json({ success: true, template: created });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
