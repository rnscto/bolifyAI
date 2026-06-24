import { Hono } from "hono";
import { base44ORM as base44 } from "../db/orm.ts";

export const voiceWebhookRouter = new Hono();

voiceWebhookRouter.post("/", async (c) => {
  try {
    const expectedSecret = Deno.env.get("SMARTFLO_WEBHOOK_SECRET");
    const webhookSecret = c.req.query("secret");
    if (expectedSecret && webhookSecret !== expectedSecret) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const payloadText = await c.req.text();
    if (!payloadText || payloadText.trim() === "") {
      return c.json({ success: true, message: "Empty body received" });
    }
    
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (e) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const call_id = payload.call_id || payload.uuid;
    const status = payload.call_status || payload.status;
    const direction = payload.direction;
    const caller_number = payload.caller_id_number || payload.caller_number || payload.from;
    const called_number = payload.call_to_number || payload.called_number || payload.to;

    // INBOUND CALL HANDLING
    if (direction === "inbound" || payload.type === "inbound") {
      const incomingNumber = caller_number || payload.from || payload.caller_id;
      const calledDID = called_number || payload.to || payload.called_number || "";
      console.log(`[smartfloWebhook] Incoming call from: ${incomingNumber}, to DID: ${calledDID}`);
      
      const cleanDID = calledDID.replace(/\D/g, "").slice(-10);
      const allDIDs = await base44.entities.DID.filter({});
      const resolvedDID = allDIDs.find((d: any) => d.number && d.number.replace(/\D/g, "").slice(-10) === cleanDID);
      
      if (resolvedDID) {
        const resolvedAgent = await base44.entities.Agent.get(resolvedDID.agent_id);
        const resolvedClient = await base44.entities.Client.get(resolvedDID.client_id);
        
        if (resolvedAgent && resolvedClient) {
          const inboundLog = await base44.entities.CallLog.create({
            client_id: resolvedClient.id,
            agent_id: resolvedAgent.id,
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: calledDID,
            direction: "inbound",
            status: "ringing",
            call_start_time: new Date().toISOString()
          });
          return c.json({ success: true, type: "inbound", call_log_id: inboundLog.id });
        }
      }
      return c.json({ success: true, message: "Unmatched inbound call" });
    }

    // OUTBOUND & STATUS UPDATES
    const mappedStatus =
      status === "answered" || status === "up" ? "answered" :
      status === "ringing" || status === "early" ? "ringing" :
      status === "completed" || status === "normal_clearing" || status === "hangup" || status === "Success" ? "completed" :
      status === "no_answer" || status === "user_busy" || status === "cancel" || status === "NOANSWER" ? "no_answer" :
      status === "failed" || status === "busy" || status === "FAILED" ? "failed" :
      "initiated";

    const customIdentifier = payload.custom_identifier || payload.customIdentifier || "";
    let directLog = null;
    
    if (customIdentifier) {
      directLog = await base44.entities.CallLog.get(customIdentifier);
      if (directLog && directLog.call_sid !== call_id) {
         await base44.entities.CallLog.update(directLog.id, { call_sid: call_id });
      }
    }

    if (!directLog) {
       const logs = await base44.entities.CallLog.filter({ call_sid: call_id });
       if (logs.length > 0) directLog = logs[0];
    }

    if (directLog) {
      if (directLog.status !== mappedStatus) {
         const updateData: any = { status: mappedStatus };
         if (mappedStatus === "answered") {
            updateData.call_start_time = updateData.call_start_time || new Date().toISOString();
         }
         if (mappedStatus === "completed" || mappedStatus === "failed" || mappedStatus === "no_answer") {
            updateData.call_end_time = new Date().toISOString();
         }
         await base44.entities.CallLog.update(directLog.id, updateData);
         console.log(`[smartfloWebhook] Updated CallLog ${directLog.id} to ${mappedStatus}`);
      }
      return c.json({ success: true, updated: true });
    }

    return c.json({ success: true, message: "No match" });
  } catch (error: any) {
    console.error("[smartfloWebhook] Error:", error);
    return c.json({ error: error.message }, 500);
  }
});
