import { Context } from "hono";
import { client } from "../db/index.ts";
import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

export async function executeCampaignHandler(c: Context) {
  const campaign_id = c.req.param("id");
  const user = c.get("jwtPayload") as any;

  try {
    const body = await c.req.json().catch(() => ({}));
    const action = body.action;

    const campaignRes = await (client as any).queryObject('SELECT * FROM campaign WHERE id = $1', [campaign_id]);
    const campaign = campaignRes.rows[0];
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    if (user.role !== "admin" && campaign.client_id !== user.client_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (action === "pause") {
      await (client as any).queryObject('UPDATE campaign SET status = $2, updated_date = NOW() WHERE id = $1', [campaign_id, "paused"]);
      return c.json({ success: true, status: "paused" });
    }
    if (action === "cancel") {
      await (client as any).queryObject('UPDATE campaign SET status = $2, updated_date = NOW() WHERE id = $1', [campaign_id, "cancelled"]);
      return c.json({ success: true, status: "cancelled" });
    }

    // TRAI Window Check (9 AM - 9 PM IST)
    const istMs = Date.now() + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    const istHour = istDate.getUTCHours();
    const istString = `${String(istHour).padStart(2, "0")}:${String(istDate.getUTCMinutes()).padStart(2, "0")} IST`;
    if (istHour < 9 || istHour >= 21) {
      await (client as any).queryObject(`
        UPDATE campaign 
        SET status = $2, notes = $3, updated_date = NOW() 
        WHERE id = $1
      `, [campaign_id, "paused", `${campaign.notes || ""}\n[${new Date().toISOString()}] Auto-paused: outside TRAI 9AM-9PM window.`.trim()]);
      return c.json({ error: "trai_window_closed", message: `Allowed 9 AM - 9 PM IST. Paused.`, current_ist: istString }, 423);
    }

    await (client as any).queryObject('UPDATE campaign SET status = $2, updated_date = NOW() WHERE id = $1', [campaign_id, "running"]);

    const agentRes = await (client as any).queryObject('SELECT * FROM agent WHERE id = $1', [campaign.agent_id]);
    const agent = agentRes.rows[0];
    const agentAssignedDIDs = typeof agent?.assigned_dids === 'string' ? JSON.parse(agent.assigned_dids) : (agent?.assigned_dids || []);
    const agentDIDs = agentAssignedDIDs?.length > 0 ? agentAssignedDIDs : agent?.assigned_did ? [agent.assigned_did] : [];
    if (!agent || agentDIDs.length === 0) {
      await (client as any).queryObject('UPDATE campaign SET status = $2, updated_date = NOW() WHERE id = $1', [campaign_id, "draft"]);
      return c.json({ error: "Agent has no assigned DID" }, 400);
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;

    const currentlyCallingRes = await (client as any).queryObject(`SELECT id FROM campaignlead WHERE campaign_id = $1 AND status = 'calling'`, [campaign_id]);
    const slotsAvailable = Math.max(0, maxConcurrent - currentlyCallingRes.rows.length);

    if (slotsAvailable === 0) {
      return c.json({ success: true, message: "All slots occupied", currently_calling: currentlyCallingRes.rows.length });
    }

    const pendingLeadsRes = await (client as any).queryObject(`
      SELECT * FROM campaignlead 
      WHERE campaign_id = $1 AND status = 'pending' 
      ORDER BY created_at DESC 
      LIMIT 200
    `, [campaign_id]);
    const pendingLeadsRaw = pendingLeadsRes.rows;
    
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
        const freshLeadRes = await (client as any).queryObject('SELECT status FROM campaignlead WHERE id = $1', [cl.id]);
        const freshLead = freshLeadRes.rows[0];
        if (freshLead?.status !== "pending") continue;

        const selectedDID = agentDIDs[didIndex % agentDIDs.length];
        didIndex++;

        const callee10 = (cl.lead_phone || "").replace(/[^0-9]/g, "").slice(-10);
        if (!/^[6-9]\d{9}$/.test(callee10)) {
          await (client as any).queryObject(`
            UPDATE campaignlead 
            SET status = 'completed', outcome = 'do_not_call', call_status = 'not_answered', conversation_summary = 'Invalid phone number.', updated_date = NOW()
            WHERE id = $1
          `, [cl.id]);
          continue;
        }

        await (client as any).queryObject(`
          UPDATE campaignlead 
          SET status = 'calling', attempt_count = COALESCE(attempt_count, 0) + 1, updated_date = NOW()
          WHERE id = $1
        `, [cl.id]);
        
        const callLogRes = await (client as any).queryObject(`
          INSERT INTO calllog (id, created_at, client_id, agent_id, lead_id, caller_id, callee_number, direction, status, call_start_time)
          VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `, [campaign.client_id, campaign.agent_id, cl.lead_id, selectedDID, cl.lead_phone, "outbound", "initiated", new Date().toISOString()]);
        
        const callLogId = callLogRes.rows[0].id;
        await (client as any).queryObject('UPDATE campaignlead SET call_log_id = $2, updated_date = NOW() WHERE id = $1', [cl.id, callLogId]);

        const smartfloRes = await triggerSmartfloOutboundCall({
          smartfloApiKey, calleeNumber: cl.lead_phone, callerId: selectedDID, callLogId: callLogId
        });

        if (smartfloRes.success) {
          results.initiated++;
        } else {
          await (client as any).queryObject(`
            UPDATE campaignlead 
            SET status = 'completed', outcome = 'not_answered', call_status = 'not_answered', conversation_summary = $2, updated_date = NOW()
            WHERE id = $1
          `, [cl.id, `Smartflo Error: ${smartfloRes.message}`]);
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
