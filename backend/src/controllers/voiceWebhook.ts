import { Hono } from "hono";
import { client } from "../db/index.ts";

export const voiceWebhookRouter = new Hono();

// Helper to get the app base URL for internal self-calls
const getAppBaseUrl = () => Deno.env.get('APP_BASE_URL_INTERNAL') || `http://localhost:${Deno.env.get('PORT') || '8000'}`;

voiceWebhookRouter.post("/", async (c) => {
  try {
    const expectedSecret = Deno.env.get("SMARTFLO_WEBHOOK_SECRET");
    const webhookSecret = c.req.query("secret");
    if (expectedSecret && webhookSecret !== expectedSecret) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const rawBody = await c.req.text();
    
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
                 const params = new URLSearchParams(rawBody);
                 for (const [key, value] of params.entries()) {
                     payload[key] = value;
                 }
            }
        }
    } else {
        payload = c.req.query();
        if (Object.keys(payload).length <= 1) {
             console.log("[smartfloWebhook] Empty body and no query parameters. Returning 200.");
             return c.json({ success: true, message: "Empty body received" });
        }
    }

    console.log("[smartfloWebhook] Received payload:", JSON.stringify(payload));

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
      const allDIDsRes = await client.queryObject(`SELECT * FROM "did"`);
      const allDIDs = allDIDsRes.rows as any[];
      const resolvedDID = allDIDs.find((d: any) => d.number && d.number.replace(/\D/g, "").slice(-10) === cleanDID);
      
      if (resolvedDID) {
        const agentRes = await client.queryObject(`SELECT * FROM "agent" WHERE id = $1 LIMIT 1`, [resolvedDID.agent_id]);
        const clientRes = await client.queryObject(`SELECT * FROM "client" WHERE id = $1 LIMIT 1`, [resolvedDID.client_id]);
        const resolvedAgent = (agentRes.rows[0] as any) || null;
        const resolvedClient = (clientRes.rows[0] as any) || null;
        
        if (resolvedAgent && resolvedClient) {
          const inboundLogRes = await client.queryObject(
            `INSERT INTO "calllog" (client_id, agent_id, call_sid, caller_id, callee_number, direction, status, call_start_time)
             VALUES ($1, $2, $3, $4, $5, 'inbound', 'ringing', NOW()) RETURNING *`,
            [resolvedClient.id, resolvedAgent.id, call_id, incomingNumber, calledDID]
          );
          const inboundLog = inboundLogRes.rows[0] as any;
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
      try {
        const res = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1 LIMIT 1`, [customIdentifier]);
        directLog = (res.rows[0] as any) || null;
      } catch(e) {}
      if (directLog && directLog.call_sid !== call_id) {
         await client.queryObject(`UPDATE "calllog" SET call_sid = $1 WHERE id = $2`, [call_id, directLog.id]);
      }
    }

    if (!directLog) {
       const logsRes = await client.queryObject(`SELECT * FROM "calllog" WHERE call_sid = $1 LIMIT 1`, [call_id]);
       directLog = (logsRes.rows[0] as any) || null;
    }

    if (directLog) {
      const setClauses: string[] = [];
      const vals: any[] = [];
      let idx = 1;

      if (directLog.status !== effectiveStatus) {
         setClauses.push(`status = $${idx++}`); vals.push(effectiveStatus);
         if (effectiveStatus === "answered") {
            setClauses.push(`call_start_time = $${idx++}`); vals.push(directLog.call_start_time || new Date().toISOString());
         }
         if (effectiveStatus === "completed" || effectiveStatus === "failed" || effectiveStatus === "no_answer") {
            setClauses.push(`call_end_time = $${idx++}`); vals.push(new Date().toISOString());
         }
      }

      if (duration) { setClauses.push(`duration = $${idx++}`); vals.push(parseInt(duration)); }
      if (recording_url) { setClauses.push(`recording_url = $${idx++}`); vals.push(recording_url); }

      if (setClauses.length > 0) {
         vals.push(directLog.id);
         await client.queryObject(
           `UPDATE "calllog" SET ${setClauses.join(', ')} WHERE id = $${idx}`,
           vals
         );
         console.log(`[smartfloWebhook] Updated CallLog ${directLog.id}: status=${effectiveStatus}`);
      }

      // Post-processing for terminal statuses
      const terminalStatuses = ['completed', 'failed', 'no_answer'];
      const isTerminal = terminalStatuses.includes(effectiveStatus);

      if (isTerminal || recording_url) {
        const baseUrl = getAppBaseUrl();
        // Check for campaign lead
        const campaignLeadsRes = await client.queryObject(
          `SELECT * FROM "campaignlead" WHERE call_log_id = $1 LIMIT 1`,
          [directLog.id]
        );
        if (campaignLeadsRes.rows.length > 0) {
          const cl = campaignLeadsRes.rows[0] as any;
          fetch(`${baseUrl}/api/functions/campaignPostCall`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ call_log_id: directLog.id, campaign_id: cl.campaign_id })
          }).catch(e => console.error('Error triggering campaignPostCall:', e));
        } else if (effectiveStatus === 'completed') {
           fetch(`${baseUrl}/api/functions/processTranscript`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ call_log_id: directLog.id, recording_url: recording_url || directLog.recording_url })
           }).catch(e => console.error('Error triggering processTranscript:', e));
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
