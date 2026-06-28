import { Context, Hono } from "hono";
import { bindCustomDomain, unbindCustomDomain } from "../services/azureContainerService.ts";
import { base44ORM as base44 } from "../db/orm.ts";

export const daprRouter = new Hono();

// Dapr calls this endpoint on startup to know which topics we are listening to
daprRouter.get("/subscribe", (c) => {
  return c.json([
    {
      pubsubname: "pubsub", // Name of the Dapr pubsub component
      topic: "domain-tasks", // The topic we want to subscribe to
      route: "/api/dapr/domain-tasks", // Our webhook endpoint
    },
  ]);
});

// The webhook that receives events from Dapr
daprRouter.post("/domain-tasks", async (c) => {
  try {
    // Dapr wraps the original message inside a CloudEvent JSON structure.
    // The actual payload we published is in the `data` field.
    const cloudEvent = await c.req.json();
    const data = cloudEvent.data;

    console.log(`[Dapr] Received domain task:`, data);

    if (!data || !data.action || !data.domain) {
      console.error("[Dapr] Invalid message payload", data);
      return c.json({ status: "success" }); // Return 200 so Dapr drops the invalid message
    }

    const { action, domain } = data;

    if (action === "bind") {
      try {
        await bindCustomDomain(domain);
        console.log(`[Dapr] Successfully bound domain: ${domain}`);
        // Find mapping and update status to active
        const mappings = await base44.entities.DomainMapping.filter({ custom_domain: domain });
        if (mappings.length > 0) {
          await base44.entities.DomainMapping.update(mappings[0].id, { ssl_status: 'active', ssl_error: null }).catch(() => {});
        }
      } catch (bindErr: any) {
        console.error(`[Dapr] Failed to bind domain ${domain}:`, bindErr);
        const errMsg = bindErr.message || String(bindErr);
        const friendly = errMsg.includes("CustomDomainVerificationFailed") || errMsg.includes("DNS")
          ? "DNS verification failed. Ensure TXT and CNAME records are correct and DNS has propagated."
          : errMsg;
        const mappings = await base44.entities.DomainMapping.filter({ custom_domain: domain });
        if (mappings.length > 0) {
          await base44.entities.DomainMapping.update(mappings[0].id, { ssl_status: 'error', ssl_error: friendly }).catch(() => {});
        }
        // Throw so Dapr retries it (unless it's a fatal DNS error which shouldn't be retried indefinitely, 
        // but for simplicity we let Dapr handle the retry policy).
        throw bindErr;
      }
    } else if (action === "unbind") {
      await unbindCustomDomain(domain);
      console.log(`[Dapr] Successfully unbound domain: ${domain}`);
    } else {
      console.warn(`[Dapr] Unknown action: ${action}`);
    }

    // Always return 200 OK so Dapr knows we processed it successfully.
    // If we throw an error or return 500, Dapr will retry the message later.
    return c.json({ status: "success" });
  } catch (err: any) {
    console.error("[Dapr] Error processing domain task:", err);
    // Returning 500 tells Dapr to retry the message.
    return c.json({ status: "error", message: err.message }, 500);
  }
});
