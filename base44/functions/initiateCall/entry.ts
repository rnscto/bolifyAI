import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { lead_id, agent_id, phone_number } = await req.json();

    if (!lead_id || !agent_id || !phone_number) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get agent and lead details
    const [agent, lead] = await Promise.all([
      base44.asServiceRole.entities.Agent.get(agent_id),
      base44.asServiceRole.entities.Lead.get(lead_id)
    ]);

    if (!agent) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }

    if (!lead) {
      return Response.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Ownership validation: ensure the user owns this client's agent and lead
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    const userClientIds = clients.map(c => c.id);
    
    if (!userClientIds.includes(agent.client_id)) {
      return Response.json({ error: 'Forbidden: Agent does not belong to your account' }, { status: 403 });
    }
    if (!userClientIds.includes(lead.client_id)) {
      return Response.json({ error: 'Forbidden: Lead does not belong to your account' }, { status: 403 });
    }

    // Support multiple DIDs - pick first available
    const allDIDs = (agent.assigned_dids && agent.assigned_dids.length > 0)
      ? agent.assigned_dids
      : (agent.assigned_did ? [agent.assigned_did] : []);
    if (allDIDs.length === 0) {
      return Response.json({ 
        success: false,
        error: 'No DID assigned to agent. Please assign a DID to the agent before making calls.' 
      }, { status: 400 });
    }

    // Check if this is a demo agent (client is trial/onboarding and DID is from demo pool)
    const clientData = clients[0];
    const isDemoAgent = clientData.account_status === 'trial' || clientData.account_status === 'onboarding';

    // ── BALANCE CHECK for per-minute billing ──
    if (clientData.billing_type !== 'unlimited') {
      const freeMin = clientData.free_minutes_remaining || 0;
      const walletBal = clientData.wallet_balance || 0;
      const minBalance = 100;

      if (freeMin <= 0 && walletBal < minBalance) {
        return Response.json({
          success: false,
          error: 'insufficient_balance',
          message: `Insufficient balance. Minimum ₹${minBalance} required to make calls. Current balance: ₹${walletBal}. Please top up your wallet.`,
          wallet_balance: walletBal,
          free_minutes_remaining: freeMin
        }, { status: 402 });
      }
    }

    // Use primary DID for single calls
    const callerDID = allDIDs[0];

    // Pre-fetch knowledge base content for agent config cache
    let kbContent = '';
    if (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
      const kbDocs = [];
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.asServiceRole.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) kbDocs.push({ title: doc.title, content: doc.content });
        } catch (e) {
          console.log(`KB doc ${kbId} fetch failed: ${e.message}`);
        }
      }
      if (kbDocs.length > 0) {
        kbContent = kbDocs.map(doc => `[${doc.title}]\n${doc.content}`).join('\n\n---\n\n');
      }
    }

    // Build lead context DIRECTLY (inline, no cross-function call to avoid auth issues)
    let leadContext = '';
    try {
      // Fetch last 3 call logs for this lead
      const callLogs = await base44.asServiceRole.entities.CallLog.filter(
        { lead_id: lead.id }, '-created_date', 3
      );

      const sections = [];
      sections.push(`CUSTOMER PROFILE:`);
      sections.push(`- Name: ${lead.name || 'Unknown'}`);
      if (lead.phone) sections.push(`- Phone: ${lead.phone}`);
      if (lead.email) sections.push(`- Email: ${lead.email}`);
      if (lead.company) sections.push(`- Company: ${lead.company}`);
      if (lead.source) sections.push(`- Lead Source: ${lead.source}`);
      if (lead.status) sections.push(`- Current Status: ${lead.status}`);

      if (lead.score || lead.sentiment || lead.qualification_tier) {
        sections.push(`\nLEAD INTELLIGENCE:`);
        if (lead.score) sections.push(`- Lead Score: ${lead.score}/100`);
        if (lead.sentiment) sections.push(`- Sentiment: ${lead.sentiment.replace(/_/g, ' ')}`);
        if (lead.qualification_tier) sections.push(`- Qualification: ${lead.qualification_tier.toUpperCase()}`);
        if (lead.intent_signals?.length > 0) sections.push(`- Intent Signals: ${lead.intent_signals.join(', ')}`);
      }

      if (lead.tags?.length > 0) sections.push(`- Tags: ${lead.tags.join(', ')}`);
      if (lead.notes) sections.push(`\nAGENT NOTES:\n${lead.notes}`);

      if (callLogs.length > 0) {
        sections.push(`\nPREVIOUS CALL HISTORY (last ${callLogs.length}):`);
        callLogs.forEach((cl, i) => {
          const date = cl.call_start_time ? new Date(cl.call_start_time).toLocaleDateString('en-IN') : 'Unknown';
          sections.push(`Call ${i + 1} — ${date} (${cl.duration ? Math.round(cl.duration) + 's' : 'N/A'}, ${cl.status}):`);
          if (cl.conversation_summary) sections.push(`  Summary: ${cl.conversation_summary.substring(0, 300)}`);
          if (cl.lead_status_updated) sections.push(`  Outcome: ${cl.lead_status_updated}`);
        });
      } else {
        sections.push(`\nPREVIOUS CALLS: None — this is the first interaction.`);
      }

      sections.push(`\nCRITICAL PERSONALIZATION RULES:`);
      sections.push(`- You MUST address the customer by their name "${lead.name || ''}" in the conversation.`);
      sections.push(`- Example: "Kya main ${lead.name || 'Sir/Madam'} se baat kar rahi hu?"`);
      if (lead.email) sections.push(`- If confirming email, use: "${lead.email}"`);
      if (lead.company) sections.push(`- Reference their company "${lead.company}" naturally.`);
      if (callLogs.length > 0) {
        sections.push(`- Reference your previous conversation (e.g., "Jaise humne pichli baar baat ki thi...")`);
      }

      leadContext = sections.join('\n');
      console.log(`Lead context built: ${leadContext.length} chars for lead ${lead.name}`);
    } catch (e) {
      console.log('Lead context build failed:', e.message);
      // Minimal fallback context with just the lead name
      leadContext = `CUSTOMER PROFILE:\n- Name: ${lead.name || 'Unknown'}\n- Phone: ${lead.phone || phone_number}\n${lead.email ? '- Email: ' + lead.email + '\n' : ''}\nCRITICAL: Address the customer by name "${lead.name || 'Sir/Madam'}" during the call.`;
    }

    // Inject current IST date/time so the agent is time-aware
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeContext = `\n\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time).\nUse this to calculate relative times when the customer says things like "call me after 30 minutes" or "call me tomorrow morning". Always confirm callback times in IST.`;

    // Check for Shopify marketplace integration
    let shopifyContext = '';
    try {
      const shopifyIntegrations = await base44.asServiceRole.entities.MarketplaceIntegration.filter({
        client_id: agent.client_id,
        platform: 'shopify',
        status: 'active'
      });
      if (shopifyIntegrations.length > 0) {
        shopifyContext = `\n\n--- SHOPIFY STORE INTEGRATION (ACTIVE) ---
You have a LIVE connection to the client's Shopify store. You can look up real-time data using the shopify_lookup tool.

WHEN TO USE:
- Customer asks about order status → use lookup_type "order_by_number" with the order number
- Customer gives phone/email but no order # → use "order_by_phone" or "order_by_email"
- Customer asks about product availability → use "product_search"
- Customer asks about refund → use "refund_status" with the Shopify order ID
- Customer asks about delivery/tracking → use "tracking" with the Shopify order ID

IMPORTANT RULES:
1. Ask the customer for their order number, phone, or email to look up their order
2. ALWAYS use the tool to get real data — NEVER make up order statuses
3. After getting the result, communicate it clearly and helpfully
4. If no results found, ask for alternative info (try phone if order# fails, etc.)
5. For tracking, share the tracking number and carrier name
`;
        console.log('Shopify integration detected — tool context injected');
      }
    } catch (e) {
      console.log('Shopify check failed:', e.message);
    }

    // Combine agent system prompt with lead personalization
    const personalizedPrompt = [
      agent.system_prompt || '',
      timeContext,
      shopifyContext,
      `\n\n--- LEAD CONTEXT (YOU MUST USE THIS DATA IN THE CONVERSATION) ---\n${leadContext}`
    ].filter(Boolean).join('\n');

    // Create call log with cached agent config (so streamAudio WebSocket can read it without cross-function calls)
    const callLog = await base44.asServiceRole.entities.CallLog.create({
      client_id: agent.client_id,
      agent_id: agent_id,
      lead_id: lead_id,
      call_sid: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      caller_id: callerDID,
      callee_number: phone_number,
      direction: 'outbound',
      status: 'initiated',
      call_start_time: new Date().toISOString(),
      conversation_summary: '',
      agent_config_cache: {
        agent_name: agent.name,
        system_prompt: personalizedPrompt,
        persona: agent.persona || {},
        knowledge_base_content: kbContent,
        lead_context: leadContext,
        greeting_message: agent.greeting_message || '',
        human_transfer_number: agent.human_transfer_number || '',
        enable_auto_transfer: agent.enable_auto_transfer !== false
      }
    });

    // Clean phone number for Smartflo API
    // Smartflo expects caller_id WITHOUT "+" prefix — keep full digits (e.g., 918065489180)
    // If that fails, some Smartflo channels need just the 10-digit number
    let cleanCallerID = callerDID.replace(/[^0-9]/g, '');
    // If stored as just 10 digits, prepend 91
    if (cleanCallerID.length === 10) {
      cleanCallerID = '91' + cleanCallerID;
    }
    const cleanPhoneNumber = phone_number.replace(/[^0-9]/g, '');
    console.log(`Cleaned caller_id: ${cleanCallerID}, callee: ${cleanPhoneNumber}`);

    // Demo agents always use the global/base API key; production agents use their own token
    const smartfloApiKey = isDemoAgent 
      ? Deno.env.get('SMARTFLO_API_KEY') 
      : (agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY'));
    console.log(`Call mode: ${isDemoAgent ? 'DEMO (shared key)' : 'PRODUCTION (agent token)'}, DID: ${callerDID}`);
    if (!smartfloApiKey) {
      return Response.json({ 
        success: false, 
        error: 'No Smartflo API token configured for this agent. Please set the Click to Call API Token in agent settings.' 
      }, { status: 400 });
    }

    // Initiate call via Smartflo Click-to-Call Support API
    const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: smartfloApiKey,
        customer_number: cleanPhoneNumber,
        caller_id: cleanCallerID,
        async: 1
      })
    });

    const smartfloData = await smartfloResponse.json();
    console.log('Smartflo response:', JSON.stringify(smartfloData));

    if (!smartfloResponse.ok || smartfloData.success === false || smartfloData.caller_id) {
      // Smartflo returns {caller_id: "Provide a vaild caller_id."} when the DID is not mapped to the API token's channel
      const errorMsg = smartfloData.caller_id 
        ? `Invalid caller_id: DID ${callerDID} is not mapped to this API token's Smartflo channel. Please verify the DID is assigned to this token in Smartflo dashboard.`
        : (smartfloData.message || smartfloData.error || JSON.stringify(smartfloData));
      console.error('Smartflo API error:', errorMsg);
      
      await base44.asServiceRole.entities.CallLog.update(callLog.id, {
        status: 'failed'
      });
      
      return Response.json({ 
        success: false, 
        error: `Failed to initiate call: ${errorMsg}` 
      }, { status: 400 });
    }

    // Update call log with Smartflo response
    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      call_sid: smartfloData.call_id || smartfloData.call_sid || callLog.call_sid,
      status: 'ringing'
    });

    // Update lead status
    await base44.asServiceRole.entities.Lead.update(lead_id, {
      status: 'contacted',
      last_call_date: new Date().toISOString()
    });

    return Response.json({
      success: true,
      call_id: callLog.id,
      call_sid: smartfloData.call_id || smartfloData.call_sid,
      message: 'Call initiated successfully'
    });

  } catch (error) {
    console.error('Error initiating call:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});