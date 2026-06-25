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

    const rawBody = await c.req.text();
    console.log(`[smartfloWebhook] POST ${c.req.url}`);
    console.log(`[smartfloWebhook] Headers:`, JSON.stringify(c.req.header()));
    console.log(`[smartfloWebhook] Query:`, JSON.stringify(c.req.query()));
    console.log(`[smartfloWebhook] Body:`, rawBody);
    
    let payload: any = {};
    const contentType = c.req.header("content-type") || "";
    
    if (rawBody && rawBody.trim() !== "") {
        if (contentType.includes("application/x-www-form-urlencoded")) {
            const params = new URLSearchParams(rawBody);
            for (const [key, value] of params.entries()) {
                payload[key] = value;
            }
        } else if (contentType.includes("application/json")) {
            try {
                payload = JSON.parse(rawBody);
            } catch (e) {
                console.error("[smartfloWebhook] JSON Parse Error on body:", rawBody);
                return c.json({ error: "Invalid JSON body" }, 400);
            }
        } else {
            // fallback attempt to parse JSON
            try {
                payload = JSON.parse(rawBody);
            } catch (e) {
                // If it fails, maybe it's URL params in the body anyway
                 const params = new URLSearchParams(rawBody);
                 for (const [key, value] of params.entries()) {
                     payload[key] = value;
                 }
            }
        }
    } else {
        // Body is empty, maybe they sent parameters in query?
        payload = c.req.query();
        if (Object.keys(payload).length <= 1) { // only secret
             console.log("[smartfloWebhook] Empty body and no query parameters. Returning 200.");
             return c.json({ success: true, message: "Empty body received" });
        }
    }
    
    console.log("[smartfloWebhook] Parsed Payload:", JSON.stringify(payload));

    const dataObj = payload.data || payload;
    const call_id = dataObj.call_id || dataObj.uuid || payload.call_id || payload.uuid;
    const status = dataObj.call_status || dataObj.status || payload.call_status || payload.status;
    const duration = dataObj.duration || dataObj.billsec || payload.duration || payload.billsec;
    const recording_url = dataObj.recording_url || dataObj.record_url || dataObj.recording || payload.recording_url || payload.record_url || payload.recording;
    const direction = dataObj.direction || payload.direction;
    const caller_number = dataObj.caller_id_number || dataObj.caller_number || dataObj.from || payload.caller_id_number || payload.caller_number || payload.from;
    const called_number = dataObj.call_to_number || dataObj.called_number || dataObj.to || payload.call_to_number || payload.called_number || payload.to;
    const hangup_cause = dataObj.hangup_cause_description || dataObj.reason_key || payload.hangup_cause_description || payload.reason_key || '';

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
      status === "answered" || status === "up" || status === "Answered" ? "answered" :
      status === "ringing" || status === "early" ? "ringing" :
      status === "completed" || status === "normal_clearing" || status === "hangup" || status === "Success" || status === "Completed" ? "completed" :
      status === "no_answer" || status === "user_busy" || status === "cancel" || status === "NOANSWER" || status === "Missed" || status === "not_connected" ? "no_answer" :
      status === "failed" || status === "busy" || status === "FAILED" || status === "Cancelled" ? "failed" :
      "initiated";

    let effectiveStatus = mappedStatus;
    if (mappedStatus === 'answered' && hangup_cause && parseInt(duration) > 0) {
      console.log(`[smartfloWebhook] Detected "answered" with hangup_cause="${hangup_cause}" + duration=${duration} — treating as COMPLETED`);
      effectiveStatus = 'completed';
    }

    const customIdentifier = dataObj.custom_identifier || dataObj.customIdentifier || payload.custom_identifier || payload.customIdentifier || "";
    let directLog: any = null;
    
    if (customIdentifier) {
      try { directLog = await base44.entities.CallLog.get(customIdentifier); } catch(e) {}
      if (directLog && directLog.call_sid !== call_id) {
         await base44.entities.CallLog.update(directLog.id, { call_sid: call_id });
      }
    }

    if (!directLog) {
       const logs = await base44.entities.CallLog.filter({ call_sid: call_id });
       if (logs.length > 0) directLog = logs[0];
    }

    if (directLog) {
      const updateData: any = {};
      if (directLog.status !== effectiveStatus) {
         updateData.status = effectiveStatus;
         if (effectiveStatus === "answered") {
            updateData.call_start_time = directLog.call_start_time || new Date().toISOString();
         }
         if (effectiveStatus === "completed" || effectiveStatus === "failed" || effectiveStatus === "no_answer") {
            updateData.call_end_time = new Date().toISOString();
         }
      }

      if (duration) updateData.duration = parseInt(duration);
      if (recording_url) updateData.recording_url = recording_url;

      if (Object.keys(updateData).length > 0) {
         await base44.entities.CallLog.update(directLog.id, updateData);
         console.log(`[smartfloWebhook] Updated CallLog ${directLog.id}: ${JSON.stringify(updateData)}`);
      }

      // Check if call reached terminal status and needs post-processing
      const terminalStatuses = ['completed', 'failed', 'no_answer'];
      const justBecameTerminal = !terminalStatuses.includes(directLog.status) && terminalStatuses.includes(effectiveStatus);
      const isTerminal = terminalStatuses.includes(effectiveStatus);

      if (isTerminal || recording_url) {
        // Check for campaign
        const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: directLog.id });
         if (campaignLeads.length > 0) {
           const cl = campaignLeads[0];
           // Trigger campaignPostCall
           try {
             fetch(`http://localhost:8000/api/functions/campaignPostCall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ call_log_id: directLog.id, campaign_id: cl.campaign_id })
             }).catch(e => console.error('Error triggering campaignPostCall:', e));
           } catch(e) {}
        } else if (effectiveStatus === 'completed') {
           // Not a campaign call, trigger processTranscript
           try {
              fetch(`http://localhost:8000/api/functions/processTranscript`, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ call_log_id: directLog.id, recording_url: recording_url || directLog.recording_url })
              }).catch(e => console.error('Error triggering processTranscript:', e));
           } catch(e) {}
        }
      }

      return c.json({ success: true, updated: true });
    }

    return c.json({ success: true, message: "No match" });
  } catch (error: any) {
    console.error("[smartfloWebhook] Error:", error);
    return c.json({ error: error.message }, 500);
  }
});
