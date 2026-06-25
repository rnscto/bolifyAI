import { client } from "../db/index.ts";
import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

export default async function executeCampaign(c: any) {
  try {
    const payload = await c.req.json();
    const { campaign_id, action, _internal } = payload;
    
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const campRes = await client.queryObject(`SELECT * FROM "campaign" WHERE id = $1 LIMIT 1`, [campaign_id]);
    const campaign = campRes.rows[0] as any;
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    if (action === 'pause') {
      await client.queryObject(`UPDATE "campaign" SET status = 'paused' WHERE id = $1`, [campaign_id]);
      return c.json({ data: { success: true, status: 'paused' } });
    }
    if (action === 'cancel') {
      await client.queryObject(`UPDATE "campaign" SET status = 'cancelled' WHERE id = $1`, [campaign_id]);
      return c.json({ data: { success: true, status: 'cancelled' } });
    }

    // TRAI Window (9 AM to 9 PM IST)
    const istMs = Date.now() + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    const istHour = istDate.getUTCHours();
    if (istHour < 9 || istHour >= 21) {
      await client.queryObject(`UPDATE "campaign" SET status = 'paused' WHERE id = $1`, [campaign_id]);
      return c.json({ data: { error: 'trai_window_closed', message: "Calling allowed only between 9 AM and 9 PM IST. Campaign auto-paused." } });
    }

    if (['completed', 'cancelled'].includes(campaign.status)) {
      return c.json({ data: { success: true, skipped: `campaign_${campaign.status}` } });
    }

    // Billing Check
    const clientDataRes = await client.queryObject(`SELECT billing_type, free_minutes_remaining, wallet_balance FROM "client" WHERE id = $1 LIMIT 1`, [campaign.client_id]);
    const clientData = clientDataRes.rows[0] as any;
    if (clientData && clientData.billing_type !== 'unlimited') {
      const freeMinutes = Number(clientData.free_minutes_remaining) || 0;
      const walletBalance = Number(clientData.wallet_balance) || 0;
      if (freeMinutes <= 0 && walletBalance < 100) {
        return c.json({ data: { error: 'insufficient_balance', message: 'Insufficient balance. Minimum ₹100 required.' } });
      }
    }

    await client.queryObject(`UPDATE "campaign" SET status = 'running', started_at = COALESCE(started_at, $2) WHERE id = $1`, [campaign_id, new Date().toISOString()]);

    const agentRes = await client.queryObject(`SELECT * FROM "agent" WHERE id = $1 LIMIT 1`, [campaign.agent_id]);
    const agentResult = agentRes.rows[0] as any;
    if (!agentResult) {
      await client.queryObject(`UPDATE "campaign" SET status = 'draft' WHERE id = $1`, [campaign_id]);
      return c.json({ data: { error: 'Agent not found' } });
    }

    const callerId = (agentResult.assigned_dids?.length > 0) ? agentResult.assigned_dids[0] : agentResult.assigned_did;
    if (!callerId) {
      return c.json({ data: { error: 'Agent has no assigned DID' } });
    }

    const smartfloApiKey = agentResult.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    if (!smartfloApiKey) {
      return c.json({ data: { error: 'No SMARTFLO_API_KEY configured' } });
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;
    
    const currentlyCallingRes = await client.queryObject(`SELECT id FROM "campaignlead" WHERE campaign_id = $1 AND status = 'calling' LIMIT $2`, [campaign_id, maxConcurrent]);
    const currentlyCalling = currentlyCallingRes.rows;
    const slotsAvailable = Math.max(0, maxConcurrent - currentlyCalling.length);

    if (slotsAvailable === 0) {
      return c.json({ data: { success: true, message: 'All slots occupied', currently_calling: currentlyCalling.length } });
    }

    const pendingLeadsRes = await client.queryObject(`SELECT * FROM "campaignlead" WHERE campaign_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT $2`, [campaign_id, slotsAvailable]);
    const pendingLeads = pendingLeadsRes.rows as any[];
    
    if (pendingLeads.length === 0) {
      // Check if campaign is completely done
      if (currentlyCalling.length === 0) {
         await client.queryObject(`UPDATE "campaign" SET status = 'completed', completed_at = $2 WHERE id = $1`, [campaign_id, new Date().toISOString()]);
         return c.json({ data: { success: true, status: 'completed' } });
      }
      return c.json({ data: { success: true, message: 'No ready leads' } });
    }

    let kbContent = '';
    let kbContentUrl = '';
    if (agentResult.knowledge_base_id) {
        try {
            const kbRes = await client.queryObject(`SELECT content, content_url FROM "knowledgebase" WHERE id = $1 LIMIT 1`, [agentResult.knowledge_base_id]);
            if (kbRes.rows.length > 0) {
                kbContent = (kbRes.rows[0] as any).content || '';
                kbContentUrl = (kbRes.rows[0] as any).content_url || '';
                if (kbContent.length > 2000) {
                    kbContent = kbContent.substring(0, 2000) + '\n\n[TRUNCATED - Content too large]';
                }
            }
        } catch (err) {}
    }

    const results = { initiated: 0, failed: 0, errors: [] as any[] };

    for (const cl of pendingLeads) {
      try {
        const callee10 = (cl.lead_phone || '').replace(/[^0-9]/g, '').slice(-10);
        if (!/^[6-9]\d{9}$/.test(callee10)) {
           await client.queryObject(`UPDATE "campaignlead" SET status = 'completed', outcome = 'do_not_call', conversation_summary = 'Invalid phone' WHERE id = $1`, [cl.id]);
           continue;
        }

        await client.queryObject(`UPDATE "campaignlead" SET status = 'calling', attempt_count = COALESCE(attempt_count, 0) + 1 WHERE id = $1`, [cl.id]);

        let leadContext = '';
        try {
            const leadRes = await client.queryObject(`SELECT * FROM "lead" WHERE id = $1 LIMIT 1`, [cl.lead_id]);
            const leadResult = (leadRes.rows[0] as any) || {};

            const callLogsRes = await client.queryObject(`SELECT * FROM "calllog" WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 3`, [cl.lead_id]);
            const sortedLogs = callLogsRes.rows as any[];
            
            const sections = [];
            sections.push(`CUSTOMER PROFILE:`);
            sections.push(`- Name: ${leadResult.name || cl.lead_name || 'Unknown'}`);
            if (callee10) sections.push(`- Phone: ${callee10}`);
            if (leadResult.email) sections.push(`- Email: ${leadResult.email}`);
            if (leadResult.company) sections.push(`- Company: ${leadResult.company}`);
            if (leadResult.source) sections.push(`- Lead Source: ${leadResult.source}`);
            if (leadResult.status) sections.push(`- Current Status: ${leadResult.status}`);

            if (leadResult.score || leadResult.sentiment || leadResult.qualification_tier) {
                sections.push(`\nLEAD INTELLIGENCE:`);
                if (leadResult.score) sections.push(`- Lead Score: ${leadResult.score}/100`);
                if (leadResult.sentiment) sections.push(`- Sentiment: ${leadResult.sentiment.replace(/_/g, ' ')}`);
                if (leadResult.qualification_tier) sections.push(`- Qualification: ${leadResult.qualification_tier.toUpperCase()}`);
            }

            if (sortedLogs.length > 0) {
                sections.push(`\nPREVIOUS CALL HISTORY (last ${sortedLogs.length}):`);
                sortedLogs.forEach((log: any, i: number) => {
                const date = log.call_start_time ? new Date(log.call_start_time).toLocaleDateString('en-IN') : 'Unknown';
                sections.push(`Call ${i + 1} — ${date} (${log.duration ? Math.round(log.duration) + 's' : 'N/A'}, ${log.status}):`);
                if (log.conversation_summary) sections.push(`  Summary: ${log.conversation_summary.substring(0, 300)}`);
                if (log.lead_status_updated) sections.push(`  Outcome: ${log.lead_status_updated}`);
                });
            } else {
                sections.push(`\nPREVIOUS CALLS: None — this is the first interaction.`);
            }

            sections.push(`\nCRITICAL PERSONALIZATION RULES:`);
            sections.push(`- You MUST address the customer by their name "${leadResult.name || cl.lead_name || ''}" in the conversation.`);
            sections.push(`- Example: "Kya main ${leadResult.name || cl.lead_name || 'Sir/Madam'} se baat kar rahi hu?"`);
            
            leadContext = sections.join('\n');
        } catch (e) {
            leadContext = `CUSTOMER PROFILE:\n- Name: ${cl.lead_name || 'Unknown'}\n- Phone: ${callee10}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}" during the call.`;
        }

        const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const timeContext = `\n\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time).`;

        const personalizedPrompt = [
            agentResult.system_prompt || '',
            timeContext,
            `\n\n--- LEAD CONTEXT (YOU MUST USE THIS DATA IN THE CONVERSATION) ---\n${leadContext}`
        ].filter(Boolean).join('\n');

        const agentConfigCache = {
            agent_name: agentResult.name,
            system_prompt: personalizedPrompt,
            persona: agentResult.persona || {},
            knowledge_base_content: kbContent,
            knowledge_base_url: kbContentUrl,
            kb_file_uri: agentResult.kb_file_uri || '',
            lead_context: leadContext,
            greeting_message: agentResult.greeting_message || '',
            human_transfer_number: agentResult.human_transfer_number || '',
            enable_auto_transfer: agentResult.enable_auto_transfer !== false
        };

        const callLogId = crypto.randomUUID();
        const callSid = `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const nowIso = new Date().toISOString();

        await client.queryObject(`
          INSERT INTO "calllog"
            (id, client_id, agent_id, lead_id, call_sid, caller_id, callee_number,
             direction, status, agent_config_cache, call_start_time, created_at, updated_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, 'outbound', 'initiated', $8::jsonb, $9, $10, $11)
        `, [
          callLogId, campaign.client_id, campaign.agent_id, cl.lead_id, callSid,
          callerId, callee10, JSON.stringify(agentConfigCache), nowIso, nowIso, nowIso
        ]);

        await client.queryObject(`UPDATE "campaignlead" SET call_log_id = $1 WHERE id = $2`, [callLogId, cl.id]);

        const smartfloResp = await triggerSmartfloOutboundCall({
          smartfloApiKey,
          calleeNumber: '91' + callee10,
          callerId: callerId,
          callLogId: callLogId
        });

        if (!smartfloResp.success) {
           await client.queryObject(`UPDATE "calllog" SET status = 'failed' WHERE id = $1`, [callLogId]);
           await client.queryObject(`UPDATE "campaignlead" SET status = 'completed', outcome = 'not_answered', conversation_summary = $1 WHERE id = $2`, [smartfloResp.message, cl.id]);
           results.failed++;
           results.errors.push({ lead: cl.lead_phone, error: smartfloResp.message });
        } else {
           await client.queryObject(`UPDATE "calllog" SET call_sid = $1, status = 'ringing' WHERE id = $2`, [smartfloResp.call_sid, callLogId]);
           results.initiated++;
        }
      } catch (err: any) {
        results.failed++;
        results.errors.push({ lead: cl.lead_phone, error: err.message });
      }
    }

    return c.json({ data: { success: true, ...results } });

  } catch (error: any) {
    return c.json({ data: { error: error.message } }, 500);
  }
}

