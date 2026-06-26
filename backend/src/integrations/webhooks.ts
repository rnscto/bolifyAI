import { client } from "../db/index.ts";
import * as crypto from "node:crypto";

export async function sendWebhookEvent(clientId: string, eventType: string, payload: any) {
  try {
    // Find active webhooks for this client
    const res = await client.queryObject(
      `SELECT webhook_url, api_key FROM crmintegration 
       WHERE client_id = $1 AND status = 'active' AND (crm_type = 'webhook' OR crm_type = 'zapier' OR crm_type = 'make')`,
      [clientId]
    );

    const integrations = res.rows as any[];
    if (integrations.length === 0) {
      return false;
    }

    const eventPayload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      data: payload
    };

    const payloadString = JSON.stringify(eventPayload);

    for (const integration of integrations) {
      if (!integration.webhook_url) continue;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "BolifyAI-Webhook-Dispatcher/1.0",
      };

      // Add HMAC signature if an API secret/key is provided
      if (integration.api_key) {
        const signature = crypto
          .createHmac("sha256", integration.api_key)
          .update(payloadString)
          .digest("hex");
        headers["x-bolify-signature"] = signature;
      }

      try {
        console.log(`[Webhook] Dispatching event ${eventType} to ${integration.webhook_url}`);
        const response = await fetch(integration.webhook_url, {
          method: "POST",
          headers,
          body: payloadString,
        });

        if (!response.ok) {
          console.error(`[Webhook] Failed to send to ${integration.webhook_url}: HTTP ${response.status}`);
        } else {
          console.log(`[Webhook] Successfully sent to ${integration.webhook_url}`);
        }
      } catch (err: any) {
        console.error(`[Webhook] Error sending to ${integration.webhook_url}:`, err.message);
      }
    }

    return true;
  } catch (error) {
    console.error("[Webhook] Dispatcher Error:", error);
    return false;
  }
}
