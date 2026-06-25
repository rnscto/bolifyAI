import { base44ORM as base44 } from "../db/orm.ts";
import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

export default async function initiateCall(c: any) {
  try {
    const payload = await c.req.json();
    const { lead_id, agent_id, phone_number, agent_did } = payload;
    
    if (!phone_number) {
      return c.json({ data: { success: false, error: "phone_number is required" } }, 400);
    }
    if (!agent_id && !agent_did) {
      return c.json({ data: { success: false, error: "Provide agent_id or agent_did" } }, 400);
    }

    let agentResult: any = null;
    if (agent_id) {
      agentResult = await base44.entities.Agent.get(agent_id);
    } else {
      const cleanDid = agent_did.replace(/[^0-9]/g, '');
      const allAgents = await base44.entities.Agent.filter({});
      agentResult = allAgents.find((a: any) => {
        const dids = [...(a.assigned_dids || []), a.assigned_did].filter(Boolean);
        return dids.some(d => d.replace(/[^0-9]/g, '') === cleanDid || d.replace(/[^0-9]/g, '').endsWith(cleanDid) || cleanDid.endsWith(d.replace(/[^0-9]/g, '')));
      });
    }

    if (!agentResult) {
      return c.json({ data: { success: false, error: "Agent not found" } }, 404);
    }

    let leadResult: any = null;
    if (lead_id) {
      leadResult = await base44.entities.Lead.get(lead_id);
    } else {
      const cleanPhone = phone_number.replace(/[^0-9]/g, '');
      const matchedLeads = await base44.entities.Lead.filter({ phone: phone_number });
      if (matchedLeads.length > 0) {
        leadResult = matchedLeads[0];
      } else {
        const allLeads = await base44.entities.Lead.filter({});
        leadResult = allLeads.find((l: any) => l.phone && l.phone.replace(/[^0-9]/g, '').slice(-10) === cleanPhone.slice(-10));
      }
    }

    if (!leadResult) {
      leadResult = await base44.entities.Lead.create({
        client_id: agentResult.client_id,
        phone: phone_number,
        name: phone_number,
        status: 'new',
        source: 'api'
      });
    }

    if (!leadResult) {
      return c.json({ data: { success: false, error: "Lead not found" } }, 404);
    }

    const allDIDs = (agentResult.assigned_dids && agentResult.assigned_dids.length > 0)
      ? agentResult.assigned_dids
      : (agentResult.assigned_did ? [agentResult.assigned_did] : []);
    
    if (allDIDs.length === 0) {
      return c.json({ data: { success: false, error: "No DID assigned to agent." } }, 400);
    }

    // Client verification
    const clientData = await base44.entities.Client.get(agentResult.client_id);
    if (!clientData) {
        return c.json({ data: { success: false, error: "Client not found." } }, 404);
    }

    const blockedStatuses = ['expired', 'suspended', 'activation_pending', 'cancelled'];
    if (blockedStatuses.includes(clientData.account_status)) {
      return c.json({ data: { success: false, error: "account_not_active", message: `Account is ${clientData.account_status}` } }, 402);
    }

    if (clientData.billing_type !== 'unlimited') {
      const freeMin = clientData.free_minutes_remaining || 0;
      const walletBal = clientData.wallet_balance || 0;
      if (freeMin <= 0 && walletBal < 100) {
        return c.json({ data: { success: false, error: "insufficient_balance", message: "Insufficient balance." } }, 402);
      }
    }

    const callerDID = allDIDs[0];

    let kbContent = '';
    let kbContentUrl = '';
    if (agentResult.knowledge_base_ids && agentResult.knowledge_base_ids.length > 0) {
      const kbDocs = [];
      for (const kbId of agentResult.knowledge_base_ids) {
        try {
          const doc = await base44.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) kbDocs.push({ title: doc.title, content: doc.content });
        } catch (e) {}
      }
      if (kbDocs.length > 0) {
        kbContent = kbDocs.map(doc => `[${doc.title}]\n${doc.content}`).join('\n\n---\n\n');
        if (kbContent.length > 2000) {
            // Upload to Blob
            try {
                const url = "http://localhost:8000/api/azureBlobUpload";
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        fileName: `kb_${Date.now()}.txt`,
                        content: kbContent,
                        contentType: 'text/plain'
                    })
                });
                if (response.ok) {
                    const uploadResult = await response.json();
                    kbContentUrl = uploadResult.data?.fileUrl || '';
                    kbContent = ''; // clear
                } else {
                    kbContent = kbContent.substring(0, 2000) + '\n\n[TRUNCATED - Content too large]';
                }
            } catch (err) {
                kbContent = kbContent.substring(0, 2000) + '\n\n[TRUNCATED - Content too large]';
            }
        }
      }
    }

    let leadContext = '';
    try {
      const callLogs = await base44.entities.CallLog.filter({ lead_id: leadResult.id });
      const sortedLogs = callLogs.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 3);
      
      const sections = [];
      sections.push(`CUSTOMER PROFILE:`);
      sections.push(`- Name: ${leadResult.name || 'Unknown'}`);
      if (leadResult.phone) sections.push(`- Phone: ${leadResult.phone}`);
      if (leadResult.email) sections.push(`- Email: ${leadResult.email}`);
      if (leadResult.company) sections.push(`- Company: ${leadResult.company}`);
      if (leadResult.source) sections.push(`- Lead Source: ${leadResult.source}`);
      if (leadResult.status) sections.push(`- Current Status: ${leadResult.status}`);

      if (leadResult.score || leadResult.sentiment || leadResult.qualification_tier) {
        sections.push(`\nLEAD INTELLIGENCE:`);
        if (leadResult.score) sections.push(`- Lead Score: ${leadResult.score}/100`);
        if (leadResult.sentiment) sections.push(`- Sentiment: ${leadResult.sentiment.replace(/_/g, ' ')}`);
        if (leadResult.qualification_tier) sections.push(`- Qualification: ${leadResult.qualification_tier.toUpperCase()}`);
        if (leadResult.intent_signals?.length > 0) sections.push(`- Intent Signals: ${leadResult.intent_signals.join(', ')}`);
      }

      if (leadResult.tags?.length > 0) sections.push(`- Tags: ${leadResult.tags.join(', ')}`);
      if (leadResult.notes) sections.push(`\nAGENT NOTES:\n${leadResult.notes}`);

      if (sortedLogs.length > 0) {
        sections.push(`\nPREVIOUS CALL HISTORY (last ${sortedLogs.length}):`);
        sortedLogs.forEach((cl: any, i: number) => {
          const date = cl.call_start_time ? new Date(cl.call_start_time).toLocaleDateString('en-IN') : 'Unknown';
          sections.push(`Call ${i + 1} — ${date} (${cl.duration ? Math.round(cl.duration) + 's' : 'N/A'}, ${cl.status}):`);
          if (cl.conversation_summary) sections.push(`  Summary: ${cl.conversation_summary.substring(0, 300)}`);
          if (cl.lead_status_updated) sections.push(`  Outcome: ${cl.lead_status_updated}`);
        });
      } else {
        sections.push(`\nPREVIOUS CALLS: None — this is the first interaction.`);
      }

      sections.push(`\nCRITICAL PERSONALIZATION RULES:`);
      sections.push(`- You MUST address the customer by their name "${leadResult.name || ''}" in the conversation.`);
      sections.push(`- Example: "Kya main ${leadResult.name || 'Sir/Madam'} se baat kar rahi hu?"`);
      if (leadResult.email) sections.push(`- If confirming email, use: "${leadResult.email}"`);
      if (leadResult.company) sections.push(`- Reference their company "${leadResult.company}" naturally.`);
      if (sortedLogs.length > 0) {
        sections.push(`- Reference your previous conversation (e.g., "Jaise humne pichli baar baat ki thi...")`);
      }

      leadContext = sections.join('\n');
    } catch (e) {
      leadContext = `CUSTOMER PROFILE:\n- Name: ${leadResult.name || 'Unknown'}\n- Phone: ${leadResult.phone || phone_number}\n${leadResult.email ? '- Email: ' + leadResult.email + '\n' : ''}\nCRITICAL: Address the customer by name "${leadResult.name || 'Sir/Madam'}" during the call.`;
    }

    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeContext = `\n\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time).\nUse this to calculate relative times when the customer says things like "call me after 30 minutes" or "call me tomorrow morning". Always confirm callback times in IST.`;

    const personalizedPrompt = [
      agentResult.system_prompt || '',
      timeContext,
      `\n\n--- LEAD CONTEXT (YOU MUST USE THIS DATA IN THE CONVERSATION) ---\n${leadContext}`
    ].filter(Boolean).join('\n');

    const callSid = `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    const callLog = await base44.entities.CallLog.create({
      client_id: agentResult.client_id,
      lead_id: leadResult.id,
      agent_id: agentResult.id,
      status: "initiated",
      duration: 0,
      caller_id: callerDID,
      callee_number: phone_number,
      call_sid: callSid,
      direction: 'outbound',
      call_start_time: new Date().toISOString(),
      agent_config_cache: {
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
      }
    });

    const smartfloApiKey = agentResult.smartflo_api_token || Deno.env.get("SMARTFLO_API_KEY");

    if (!smartfloApiKey) {
      return c.json({ data: { success: false, error: "SMARTFLO_API_KEY not set" } }, 400);
    }

    const callee10 = phone_number.replace(/[^0-9]/g, '').slice(-10);
    const validIndianMobile = /^[6-9]\d{9}$/.test(callee10);
    if (!validIndianMobile) {
      await base44.entities.CallLog.update(callLog.id, {
        status: 'failed',
        conversation_summary: `Invalid phone number "${phone_number}" — not a valid 10-digit Indian mobile. Call not placed.`,
        lead_status_updated: 'do_not_call'
      });
      return c.json({ data: { success: false, error: `Invalid phone number. Must be a valid 10-digit Indian mobile.` } }, 400);
    }

    let cleanCallerID = callerDID.replace(/[^0-9]/g, '');
    if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;

    const dialNumber = '91' + callee10;

    const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: smartfloApiKey,
        customer_number: dialNumber,
        caller_id: cleanCallerID,
        custom_identifier: callLog.id,
        async: 1
      })
    });

    const smartfloData = await smartfloResponse.json();
    const callerIdError = smartfloData.caller_id && !/^\d+$/.test(String(smartfloData.caller_id).replace(/[^0-9]/g, '')) ? true : (typeof smartfloData.caller_id === 'string' && /[a-zA-Z]/.test(smartfloData.caller_id));

    if (!smartfloResponse.ok || smartfloData.success === false || callerIdError) {
        const errorMsg = callerIdError 
        ? `Invalid caller_id: DID ${callerDID} is not mapped to this API token's Smartflo channel. Please verify the DID is assigned to this token in Smartflo dashboard.`
        : (smartfloData.message || smartfloData.error || JSON.stringify(smartfloData));
        
        await base44.entities.CallLog.update(callLog.id, { status: 'failed' });
        return c.json({ data: { success: false, error: errorMsg } }, 400);
    }

    await base44.entities.CallLog.update(callLog.id, {
        call_sid: smartfloData.call_id || smartfloData.ref_id || smartfloData.call_sid || callLog.call_sid,
        status: 'ringing'
    });

    await base44.entities.Lead.update(leadResult.id, {
        status: 'contacted',
        last_call_date: new Date().toISOString()
    });

    return c.json({ data: { success: true, call_id: callLog.id, message: "Call initiated successfully" } });
  } catch (err: any) {
    return c.json({ data: { success: false, error: err.message } }, 500);
  }
}
