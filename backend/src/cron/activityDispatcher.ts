import { client } from "../db/index.ts";
import { sendWhatsAppMessage } from "../integrations/whatsapp.ts";
import { sendEmail } from "../integrations/email.ts";
import { sendSMS } from "../integrations/sms.ts";
import { sendCalendarInvite } from "../integrations/calendar.ts";
import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

export async function runActivityDispatcher() {
  try {
    // Find scheduled activities that are due to be sent now
    // We target whatsapp, email, sms types that haven't been completed yet
    const query = `
      SELECT a.*, l.phone as lead_phone, l.email as lead_email, l.name as lead_name, a.client_id
      FROM activity a
      JOIN lead l ON a.lead_id = l.id::text
      WHERE a.status = 'scheduled' 
        AND a.scheduled_date IS NOT NULL 
        AND a.scheduled_date != ''
        AND CAST(a.scheduled_date AS timestamp with time zone) <= NOW() 
        AND a.type IN ('whatsapp', 'email', 'sms', 'calendar_invite', 'call', 'followup')
      LIMIT 50
    `;
    const res = await client.queryObject(query);
    const activities = res.rows as any[];

    for (const activity of activities) {
      console.log(`[ActivityDispatcher] Dispatching ${activity.type} for Lead ${activity.lead_id} (Activity ${activity.id})`);

      let success = false;
      let errorMsg = "";

      try {
        if (activity.type === 'whatsapp') {
          if (!activity.lead_phone) throw new Error("Lead missing phone number");
          // Extract template name from title/description or default to a generic one
          // E.g., title: "Whatsapp asked details" -> template could be 'follow_up_details'
          // We can parse the description if it contains JSON or variables, for now just use a default template or one specified in title
          let templateName = 'follow_up_details';

          // Try to get a template that matches "demo" or "followup", otherwise get the first approved template
          const tplQuery = `SELECT name FROM whatsapptemplate WHERE client_id = $1 AND status = 'APPROVED' ORDER BY created_at DESC LIMIT 1`;
          const tplRes = await client.queryObject(tplQuery, [activity.client_id]);
          if (tplRes.rows.length > 0) {
            templateName = (tplRes.rows[0] as any).name;
          }

          success = await sendWhatsAppMessage(activity.lead_phone, templateName, [activity.first_name || 'Customer'], activity.client_id);
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

          // We need an agent and smartflo token. Let's try assigned_to first, or default to client's primary agent
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
          
          // Create a new calllog for this follow-up
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
          await client.queryObject(
            `UPDATE activity SET status = 'completed', updated_date = NOW() WHERE id = $1`,
            [activity.id]
          );

          // Log it to outreach log
          await client.queryObject(
            `INSERT INTO outreachlog (client_id, lead_id, channel, direction, status, notes)
             VALUES ($1, $2, $3, 'outbound', 'delivered', $4)`,
            [activity.client_id, activity.lead_id, activity.type, `Automated dispatch successful: ${activity.title}`]
          );
        } else {
          throw new Error("Provider returned false");
        }

      } catch (dispatchErr: any) {
        console.error(`[ActivityDispatcher] Failed to dispatch ${activity.type} ${activity.id}:`, dispatchErr);
        await client.queryObject(
          `UPDATE activity SET status = 'failed', updated_date = NOW(), notes = $2 WHERE id = $1`,
          [activity.id, `Failed to dispatch: ${dispatchErr.message || dispatchErr}`]
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

  // Run once immediately
  setTimeout(() => runActivityDispatcher(), 5000);
}
