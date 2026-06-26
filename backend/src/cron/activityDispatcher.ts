import { client } from "../db/index.ts";
import { sendWhatsAppMessage } from "../integrations/whatsapp.ts";
import { sendEmail } from "../integrations/email.ts";
import { sendSMS } from "../integrations/sms.ts";
import { sendCalendarInvite } from "../integrations/calendar.ts";

export async function runActivityDispatcher() {
  try {
    // Find scheduled activities that are due to be sent now
    // We target whatsapp, email, sms types that haven't been completed yet
    const query = `
      SELECT a.*, l.phone as lead_phone, l.email as lead_email, l.first_name, l.last_name, c.client_id
      FROM activity a
      JOIN lead l ON a.lead_id = l.id::text
      JOIN campaign c ON l.campaign_id = c.id::text
      WHERE a.status = 'scheduled' 
        AND a.scheduled_date <= NOW() 
        AND a.type IN ('whatsapp', 'email', 'sms', 'calendar_invite')
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

        if (success) {
          await client.queryObject(
            `UPDATE activity SET status = 'completed', updated_date = NOW() WHERE id = $1`,
            [activity.id]
          );
          
          // Log it to outreach log
          await client.queryObject(
            `INSERT INTO outreachlog (lead_id, campaign_id, type, direction, status, notes)
             VALUES ($1, $2, $3, 'outbound', 'delivered', $4)`,
            [activity.lead_id, activity.campaign_id, activity.type, `Automated dispatch successful: ${activity.title}`]
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
