import { client } from "../db/index.ts";
import { sendWhatsAppMessage } from "../integrations/whatsapp.ts";
import { sendEmail } from "../integrations/email.ts";
import { sendSMS } from "../integrations/sms.ts";
import { sendCalendarInvite } from "../integrations/calendar.ts";
import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

export async function runActivityDispatcher() {
  try {
    // Find scheduled activities that are due now.
    // FIX: Use explicit UUID cast on lead.id to match text lead_id in activity.
    // FIX: Also handle case where scheduled_date could be a valid ISO string stored as TEXT.
    const query = `
      SELECT a.*, l.phone as lead_phone, l.email as lead_email, l.name as lead_name
      FROM activity a
      JOIN lead l ON l.id::text = a.lead_id
      WHERE a.status = 'scheduled' 
        AND a.scheduled_date IS NOT NULL 
        AND a.scheduled_date != ''
        AND a.scheduled_date::timestamp with time zone <= NOW() 
        AND a.type IN ('whatsapp', 'email', 'sms', 'calendar_invite', 'call', 'followup')
      LIMIT 50
    `;
    const res = await client.queryObject(query);
    const activities = res.rows as any[];

    if (activities.length > 0) {
      console.log(`[ActivityDispatcher] Found ${activities.length} activities due for dispatch.`);
    }

    for (const activity of activities) {
      console.log(`[ActivityDispatcher] Dispatching ${activity.type} for Lead ${activity.lead_id} (Activity ${activity.id})`);

      let success = false;
      let errorMsg = "";

      try {
        if (activity.type === 'whatsapp') {
          if (!activity.lead_phone) throw new Error("Lead missing phone number");
          let templateName = 'follow_up_details';
          const tplQuery = `SELECT name FROM whatsapptemplate WHERE client_id = $1 AND status = 'APPROVED' ORDER BY created_at DESC LIMIT 1`;
          const tplRes = await client.queryObject(tplQuery, [activity.client_id]);
          if (tplRes.rows.length > 0) {
            templateName = (tplRes.rows[0] as any).name;
          }
          success = await sendWhatsAppMessage(activity.lead_phone, templateName, [activity.lead_name || 'Customer'], activity.client_id);
        }
        else if (activity.type === 'email') {
          if (!activity.lead_email) throw new Error("Lead missing email address");
          const subject = activity.title || "Follow up from our call";
          const body = activity.description || "Thank you for speaking with us. Here are the details requested.";
          success = await sendEmail(activity.lead_email, subject, body, undefined, activity.client_id);
        }
        else if (activity.type === 'sms') {
          if (!activity.lead_phone) throw new Error("Lead missing phone number");
          const body = activity.description || "Thank you for speaking with us. We will follow up soon.";
          success = await sendSMS(activity.lead_phone, body, activity.client_id);
        }
        else if (activity.type === 'calendar_invite') {
          if (!activity.lead_email) throw new Error("Lead missing email address");
          const subject = activity.title || "Meeting Invitation from BolifyAI";
          const body = activity.description || "Please find the calendar invite attached.";
          success = await sendCalendarInvite(activity.lead_email, subject, body, activity.scheduled_date, activity.client_id);
        }
        else if (activity.type === 'call' || activity.type === 'followup') {
          if (!activity.lead_phone) throw new Error("Lead missing phone number");

          let agentId = activity.assigned_to;
          let agentQuery = `SELECT id, assigned_did, assigned_dids, smartflo_api_token, client_id FROM "agent" WHERE status = 'active' `;
          const agentParams: any[] = [];
          
          if (agentId) {
             agentQuery += `AND id = $1 LIMIT 1`;
             agentParams.push(agentId);
          } else {
             agentQuery += `AND client_id = $1 LIMIT 1`;
             agentParams.push(activity.client_id);
          }

          const agentRes = await client.queryObject(agentQuery, agentParams);
          if (agentRes.rows.length === 0) throw new Error("No active agent found to place the call");
          
          const agent = agentRes.rows[0] as any;
          const smartfloApiKey = agent.smartflo_api_token || Deno.env.get("SMARTFLO_API_KEY");
          if (!smartfloApiKey) throw new Error("No Smartflo API Key configured");
          
          let callerDID = agent.assigned_did;
          if (!callerDID && typeof agent.assigned_dids === 'string') {
              try { const arr = JSON.parse(agent.assigned_dids); if (arr.length > 0) callerDID = arr[0]; } catch(_) {}
          } else if (!callerDID && Array.isArray(agent.assigned_dids) && agent.assigned_dids.length > 0) {
              callerDID = agent.assigned_dids[0];
          }
          if (!callerDID) throw new Error("Agent has no assigned DID to dial out");
          
          // Create a new calllog for this automated follow-up call
          const callLogRes = await client.queryObject(`
            INSERT INTO "calllog" (client_id, agent_id, lead_id, caller_id, callee_number, direction, status, call_start_time)
            VALUES ($1, $2, $3, $4, $5, 'outbound', 'initiated', NOW())
            RETURNING id
          `, [agent.client_id, agent.id, activity.lead_id, callerDID, activity.lead_phone]);
          
          const callLogId = (callLogRes.rows[0] as any).id;

          const callResult = await triggerSmartfloOutboundCall({
            smartfloApiKey,
            calleeNumber: activity.lead_phone,
            callerId: callerDID,
            callLogId: callLogId
          });

          if (callResult.success) {
             success = true;
          } else {
             throw new Error(callResult.message || "Smartflo API rejected the call");
          }
        }

        if (success) {
          // FIX: Use updated_at (not updated_date) — matches the activity table schema
          await client.queryObject(
            `UPDATE "activity" SET status = 'completed', updated_at = NOW() WHERE id = $1`,
            [activity.id]
          );

          // FIX: outreachlog has no 'notes' column — use 'body' for the message content
          await client.queryObject(
            `INSERT INTO outreachlog (client_id, lead_id, channel, direction, status, body)
             VALUES ($1, $2, $3, 'outbound', 'delivered', $4)`,
            [activity.client_id, activity.lead_id, activity.type, `Automated dispatch successful: ${activity.title}`]
          );
          console.log(`[ActivityDispatcher] ✅ Dispatched ${activity.type} for activity ${activity.id}`);
        } else {
          throw new Error("Provider returned false");
        }

      } catch (dispatchErr: any) {
        const errMsg = dispatchErr.message || String(dispatchErr);
        console.error(`[ActivityDispatcher] ❌ Failed to dispatch ${activity.type} ${activity.id}: ${errMsg}`);
        // FIX: Use updated_at (not updated_date) — matches the activity table schema
        await client.queryObject(
          `UPDATE activity SET status = 'failed', updated_at = NOW(), notes = $2 WHERE id = $1`,
          [activity.id, `Failed to dispatch: ${errMsg}`]
        );
      }
    }
  } catch (err) {
    console.error(`[ActivityDispatcher] Error polling activities:`, err);
  }
}

export function initActivityDispatcher() {
  console.log("[ActivityDispatcher] Initializing polling (every 60s)...");
  setInterval(() => {
    runActivityDispatcher().catch(console.error);
  }, 60 * 1000);

  // Run once immediately on startup
  setTimeout(() => runActivityDispatcher(), 5000);
}
