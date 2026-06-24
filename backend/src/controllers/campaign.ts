import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";

export const campaignRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

// Secure all routes
campaignRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

import { executeCampaignHandler } from "./campaignExecute.ts";

// POST /api/campaigns/:id/execute
// Starts a campaign, selects the first batch of leads, and initiates calls
campaignRouter.post("/:id/execute", executeCampaignHandler);

// POST /api/campaigns/initiate-call
// Single click-to-call trigger
campaignRouter.post("/initiate-call", async (c) => {
  const { phone_number, agent_id } = await c.req.json();
  const user = c.get("jwtPayload");

  try {
     // Trigger Smartflo Click-to-Call API
     const SMARTFLO_API_KEY = Deno.env.get("SMARTFLO_API_KEY");
     if (!SMARTFLO_API_KEY) {
        throw new Error("Smartflo API key is missing");
     }

     console.log(`[Smartflo] Initiating single call to ${phone_number} via agent ${agent_id}`);
     
     const payload = {
        agent_number: agent_id,
        destination_number: phone_number
     };
     
     await fetch("https://api.smartflo.tatateleservices.com/v1/click_to_call", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SMARTFLO_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
     });

     return c.json({ success: true, message: "Call initiated successfully" });
  } catch (error: any) {
     return c.json({ error: error.message }, 500);
  }
});
