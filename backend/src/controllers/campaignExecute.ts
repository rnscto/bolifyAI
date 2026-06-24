import { Context } from "hono";
import { base44ORM as base44 } from "../db/orm.ts";
import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

export async function executeCampaignHandler(c: Context) {
  const campaign_id = c.req.param("id");
  const user = c.get("jwtPayload") as any;

  try {
    const body = await c.req.json().catch(() => ({}));
    const action = body.action;

    const campaign = await base44.entities.Campaign.get(campaign_id);
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    if (user.role !== "admin" && campaign.client_id !== user.client_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (action === "pause") {
      await base44.entities.Campaign.update(campaign_id, { status: "paused" });
      return c.json({ success: true, status: "paused" });
    }
    if (action === "cancel") {
      await base44.entities.Campaign.update(campaign_id, { status: "cancelled" });
      return c.json({ success: true, status: "cancelled" });
    }

    // TRAI Window Check (9 AM - 9 PM IST)
    const istMs = Date.now() + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    const istHour = istDate.getUTCHours();
    const istString = `${String(istHour).padStart(2, "0")}:${String(istDate.getUTCMinutes()).padStart(2, "0")} IST`;
    if (istHour < 9 || istHour >= 21) {
      await base44.entities.Campaign.update(campaign_id, {
        status: "paused",
        notes: `${campaign.notes || ""}\n[${new Date().toISOString()}] Auto-paused: outside TRAI 9AM-9PM window.`.trim()
      });
      return c.json({ error: "trai_window_closed", message: `Allowed 9 AM - 9 PM IST. Paused.`, current_ist: istString }, 423);
    }

    await base44.entities.Campaign.update(campaign_id, { status: "running" });

    const agent = await base44.entities.Agent.get(campaign.agent_id);
    const agentDIDs = agent?.assigned_dids?.length > 0 ? agent.assigned_dids : agent?.assigned_did ? [agent.assigned_did] : [];
    if (!agent || agentDIDs.length === 0) {
      await base44.entities.Campaign.update(campaign_id, { status: "draft" });
      return c.json({ error: "Agent has no assigned DID" }, 400);
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;

    const currentlyCalling = await base44.entities.CampaignLead.filter({ campaign_id, status: "calling" });
    const slotsAvailable = Math.max(0, maxConcurrent - currentlyCalling.length);

    if (slotsAvailable === 0) {
      return c.json({ success: true, message: "All slots occupied", currently_calling: currentlyCalling.length });
    }

    const pendingLeadsRaw = await base44.entities.CampaignLead.filter({ campaign_id, status: "pending" }, "-created_at", 200);
    const now = new Date();
    const pendingLeads = pendingLeadsRaw.filter((l: any) => !l.followup_call_date || new Date(l.followup_call_date) <= now).slice(0, slotsAvailable);

    if (pendingLeads.length === 0) {
      return c.json({ success: true, message: "No ready leads" });
    }

    const smartfloApiKey = agent.smartflo_api_token || Deno.env.get("SMARTFLO_API_KEY");
    if (!smartfloApiKey) return c.json({ error: "No Smartflo API Key" }, 500);

    const results = { initiated: 0, failed: 0, errors: [] as any[] };
    let didIndex = 0;

    for (const cl of pendingLeads) {
      try {
        const freshLead = await base44.entities.CampaignLead.get(cl.id);
        if (freshLead.status !== "pending") continue;

        const selectedDID = agentDIDs[didIndex % agentDIDs.length];
        didIndex++;

        const callee10 = (cl.lead_phone || "").replace(/[^0-9]/g, "").slice(-10);
        if (!/^[6-9]\d{9}$/.test(callee10)) {
          await base44.entities.CampaignLead.update(cl.id, {
            status: "completed", outcome: "do_not_call", call_status: "not_answered",
            conversation_summary: "Invalid phone number."
          });
          continue;
        }

        await base44.entities.CampaignLead.update(cl.id, { status: "calling", attempt_count: (cl.attempt_count || 0) + 1 });
        
        const callLog = await base44.entities.CallLog.create({
          client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
          caller_id: selectedDID, callee_number: cl.lead_phone,
          direction: "outbound", status: "initiated", call_start_time: new Date().toISOString(),
        });
        await base44.entities.CampaignLead.update(cl.id, { call_log_id: callLog.id });

        const smartfloRes = await triggerSmartfloOutboundCall({
          smartfloApiKey, calleeNumber: cl.lead_phone, callerId: selectedDID, callLogId: callLog.id
        });

        if (smartfloRes.success) {
          results.initiated++;
        } else {
          await base44.entities.CampaignLead.update(cl.id, {
            status: "completed", outcome: "not_answered", call_status: "not_answered",
            conversation_summary: `Smartflo Error: ${smartfloRes.message}`
          });
          results.failed++;
          results.errors.push({ lead: cl.lead_phone, error: smartfloRes.message });
        }
        await new Promise(r => setTimeout(r, 1500));
      } catch (err: any) {
        results.failed++;
        results.errors.push({ lead: cl.lead_phone, error: err.message });
      }
    }

    return c.json({ success: true, ...results });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}
