import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Scheduled automation — runs daily at 11 AM IST.
// No user session available. Uses service role directly.

export default async function retentionCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Support external cron: allow GET requests with shared secret or CRON_API_KEY
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronSecret = url.searchParams.get('cron_secret');
      const cronApiKey = url.searchParams.get('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
      console.log('[retentionCall] Triggered by external cron');
    }

    // Use createClientFromRequest for POST (manual trigger from admin UI), service role for GET (external cron)
    let base44;
    if (req.method === 'POST') {
      base44 = createClientFromRequest(req);
      // Verify admin
      const user = c.get('jwtPayload');
      if (user?.role !== 'admin') return c.json({ data: { error: 'Forbidden' } }, 403);
      // Switch to service role for all entity operations
      base44 = { entities: base44.asServiceRole.entities, functions: base44.asServiceRole.functions, integrations: base44.asServiceRole.integrations };
    } else {
      const appId = Deno.env.get('BASE44_APP_ID');
      base44 = createClient({ appId, asServiceRole: true });
    }

    // Load retention config
    const configs = await base44.entities.RetentionConfig.list('-created_date', 1);
    const config = configs[0] || {};

    if (config.is_active === false) {
      return c.json({ data: { success: true, message: 'Retention system is paused', skipped: true } });
    }

    // Parse request body for manual trigger flag (only for POST requests)
    let requestBody = {};
    if (req.method === 'POST') {
      try {
        requestBody = await c.req.json();
      } catch (_) {}
    }
    const forceRun = requestBody.force === true;
    // Live "Run Now" modes:
    //  - mode === 'list'        → return eligible clients only (no calls placed)
    //  - single_client_id set   → place a call to exactly ONE client, return its result
    const listMode = requestBody.mode === 'list';
    const singleClientId = requestBody.single_client_id || null;
    // For list/single modes from the live runner, treat as force (skip day/max gating)
    const effectiveForce = forceRun || listMode || !!singleClientId;

    const callDays = config.call_days_after_expiry || [2, 5, 7, 10, 14, 21, 30];
    const maxCallsPerClient = config.max_calls_per_client || 5;
    const results = { calls_initiated: [], emails_sent: [], errors: [], skipped: [], force_mode: forceRun };
    const now = new Date();

    // ── FAST PATH: single client (live runner) ──
    // The live runner already ran 'list' mode to determine eligibility, so for a
    // single call we skip the full expired-clients scan entirely (no 105-client
    // load, no stale-trial writes, no 500-call-log fetch). This is what makes
    // sequential one-by-one calls reliable instead of timing out / 500ing.
    let eligibleClients;
    let expiredClients = [];
    if (singleClientId) {
      const client = await base44.entities.Client.get(singleClientId).catch(() => null);
      if (!client || !client.trial_end_date || !client.phone) {
        return c.json({ data: { success: true, single_client_id: singleClientId, skipped_not_eligible: true, ...results } });
      }
      const trialEnd = new Date(client.trial_end_date);
      const daysSinceExpiry = Math.floor((now - trialEnd) / (1000 * 60 * 60 * 24));
      eligibleClients = [{ client, daysSinceExpiry }];
    } else {
      // Get all expired clients + trial clients whose trial has actually ended
      const [explicitlyExpired, trialClients] = await Promise.all([
        base44.entities.Client.filter({ account_status: 'expired' }),
        base44.entities.Client.filter({ account_status: 'trial' }),
      ]);

      const staleTrials = [];
      for (const tc of trialClients) {
        if (tc.trial_end_date && new Date(tc.trial_end_date) < now) {
          await base44.entities.Client.update(tc.id, { account_status: 'expired' });
          tc.account_status = 'expired';
          staleTrials.push(tc);
          console.log(`[retentionCall] Auto-expired stale trial: ${tc.company_name} (trial ended ${tc.trial_end_date})`);
        }
      }

      expiredClients = [...explicitlyExpired, ...staleTrials];
      console.log(`[retentionCall] Found ${expiredClients.length} expired clients (${explicitlyExpired.length} already expired + ${staleTrials.length} stale trials auto-expired), callDays=${callDays.join(',')}, force=${forceRun}`);

      // Filter eligible clients FIRST before making any Azure calls
      const allCallLogs = await base44.entities.CallLog.list('-created_date', 500);
      eligibleClients = [];

      for (const client of expiredClients) {
        if (!client.trial_end_date || !client.phone) continue;

        if (config.excluded_client_ids && config.excluded_client_ids.includes(client.id)) {
          results.skipped.push({ client_id: client.id, reason: 'excluded' });
          continue;
        }

        const trialEnd = new Date(client.trial_end_date);
        const daysSinceExpiry = Math.floor((now - trialEnd) / (1000 * 60 * 60 * 24));

        if (!effectiveForce && !callDays.includes(daysSinceExpiry)) continue;

        const clientRetentionCalls = allCallLogs.filter(l =>
          l.client_id === client.id && (l.call_sid?.startsWith('ret_') || l.conversation_summary?.includes('Retention'))
        );
        if (!effectiveForce && clientRetentionCalls.length >= maxCallsPerClient) {
          results.skipped.push({ client_id: client.id, reason: 'max_calls_reached', count: clientRetentionCalls.length });
          continue;
        }

        eligibleClients.push({ client, daysSinceExpiry });
      }

      console.log(`[retentionCall] ${eligibleClients.length} eligible clients to call`);
    }

    // ── LIST MODE: return the eligible client list for the live runner (no calls) ──
    if (listMode) {
      return c.json({ data: {
        success: true,
        mode: 'list',
        total_expired_clients: expiredClients.length,
        eligible_clients: eligibleClients.length,
        clients: eligibleClients.map(({ client, daysSinceExpiry }) => ({
          client_id: client.id,
          company: client.company_name,
          phone: client.phone,
          days_since_expiry: daysSinceExpiry,
        })),
      } });
    }

    if (eligibleClients.length === 0) {
      return c.json({ data: {
        success: true,
        total_expired_clients: expiredClients.length,
        eligible_clients: 0,
        ...results,
      } });
    }

    // ── SINGLE MODE: place a call to exactly ONE client (live runner) ──
    // BATCH MODE: limit to max 5 clients per run to avoid timeout
    const MAX_PER_RUN = 5;
    let clientsToProcess;
    if (singleClientId) {
      // Fast path already resolved the one eligible client above.
      clientsToProcess = eligibleClients;
    } else {
      clientsToProcess = eligibleClients.slice(0, MAX_PER_RUN);
      if (eligibleClients.length > MAX_PER_RUN) {
        results.skipped.push({ reason: `${eligibleClients.length - MAX_PER_RUN} clients deferred to next run (max ${MAX_PER_RUN} per run)` });
      }
    }

    // Find retention agent ONCE (not per-client)
    let retentionAgent = null;
    if (config.retention_agent_id) {
      const agents = await base44.entities.Agent.filter({ status: 'active' });
      retentionAgent = agents.find(a => a.id === config.retention_agent_id);
    }
    if (!retentionAgent) {
      const allAgents = await base44.entities.Agent.filter({ status: 'active' });
      retentionAgent = allAgents.find(a => {
        if (a.assigned_dids?.length > 0) return true;
        if (a.assigned_did && a.assigned_did.trim() !== '') return true;
        return false;
      });
    }

    if (!retentionAgent) {
      return c.json({ data: { success: false, error: 'No active agent with DID available for retention calls' } }, 400);
    }

    const agentDIDs = (retentionAgent.assigned_dids?.length > 0)
      ? retentionAgent.assigned_dids
      : (retentionAgent.assigned_did ? [retentionAgent.assigned_did] : []);
    const callerDID = config.retention_did || agentDIDs[0];

    if (!callerDID) {
      return c.json({ data: { success: false, error: 'No DID available for retention calls' } }, 400);
    }

    // Pre-fetch knowledge base content ONCE
    let kbContent = '';
    if (retentionAgent.knowledge_base_ids?.length > 0) {
      for (const kbId of retentionAgent.knowledge_base_ids) {
        try {
          const doc = await base44.entities.KnowledgeBase.get(kbId);
          if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
        } catch (_) {}
      }
    }

    // Normalize Azure endpoint (strip /openai/ and /api/projects/ suffixes)
    let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const openaiIdx = baseUrl.indexOf('/openai/');
    if (openaiIdx > 0) baseUrl = baseUrl.substring(0, openaiIdx);
    const apiProjIdx = baseUrl.indexOf('/api/projects');
    if (apiProjIdx > 0) baseUrl = baseUrl.substring(0, apiProjIdx);
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

    if (!baseUrl || !deployment || !apiKey) {
      return c.json({ data: { success: false, error: 'Missing Azure OpenAI secrets' } }, 500);
    }

    // Phase 2/3: route engine-specific retention calls through dedicated outgoing channels.
    const isGeminiRetention = retentionAgent.persona?.voice_engine === 'gemini_live';
    const isRealtimeRetention = retentionAgent.persona?.voice_engine === 'realtime' || retentionAgent.persona?.voice_engine === 'azure_speech';
    // Optional dedicated outgoing channels — read defensively so the function
    // never hard-requires these secrets (they're optional; fallback token works).
    const optEnv = (name) => { try { return Deno.env.get(name); } catch (_) { return undefined; } };
    const geminiOutgoingToken = optEnv('SMARTFLO_C2C_GEMINI_OUTGOING');
    const realtimeOutgoingToken = optEnv('SMARTFLO_C2C_REALTIME_OUTGOING');
    const baseRetentionToken = retentionAgent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    let smartfloApiKey = baseRetentionToken;
    if (isGeminiRetention && geminiOutgoingToken) {
      smartfloApiKey = geminiOutgoingToken;
      console.log('[retentionCall] 🔀 Routing via Gemini-Outgoing channel');
    } else if (isRealtimeRetention && realtimeOutgoingToken) {
      smartfloApiKey = realtimeOutgoingToken;
      console.log('[retentionCall] 🔀 Routing via Realtime-Outgoing channel');
    }
    if (!smartfloApiKey) {
      return c.json({ data: { success: false, error: 'No Smartflo API token configured for retention agent' } }, 400);
    }

    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

    // Process each eligible client
    for (const { client, daysSinceExpiry } of clientsToProcess) {
      try {
        // Generate script via Azure OpenAI
        const promptParts = [];
        promptParts.push(`Generate a short, warm, professional retention phone call script for a VaaniAI sales agent calling a customer whose free trial has expired.`);
        promptParts.push(`\nCustomer details:\n- Company: ${client.company_name}\n- Industry: ${client.industry || 'General'}\n- Trial expired: ${daysSinceExpiry} days ago\n- Has CRM: ${client.has_custom_crm ? 'Yes' : 'No'}`);

        if (config.greeting_template) {
          const greeting = config.greeting_template
            .replace('{company_name}', client.company_name)
            .replace('{industry}', client.industry || 'General')
            .replace('{days_since_expiry}', daysSinceExpiry.toString())
            .replace('{offer}', config.active_offer || '');
          promptParts.push(`\nUse this greeting: "${greeting}"`);
        }

        if (config.active_offer) {
          promptParts.push(`\nIMPORTANT: Mention this special offer: "${config.active_offer}"${config.offer_code ? ` (code: ${config.offer_code})` : ''}${config.offer_expiry ? ` (expires: ${config.offer_expiry})` : ''}`);
        }

        if (config.custom_instructions) {
          promptParts.push(`\nAdditional instructions: ${config.custom_instructions}`);
        }

        if (config.objection_handlers && config.objection_handlers.length > 0) {
          const handlers = config.objection_handlers.map(h => `- If they say "${h.objection}": ${h.response}`).join('\n');
          promptParts.push(`\nObjection handling:\n${handlers}`);
        }

        promptParts.push(`\nDefault points to cover:\n1. Greet warmly\n2. Ask about their trial experience\n3. Highlight that their setup is preserved\n4. Mention pricing: ₹9,999/month per channel (quarterly billing)\n5. Be respectful if not interested\n\nKeep it conversational and under 200 words. Indian business context.`);

        const azureUri = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;

        const azureResponse = await fetch(azureUri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'You are a helpful assistant that generates cold call scripts. Always respond in valid JSON.' },
              { role: 'user', content: promptParts.join('\n') + '\n\nRespond in JSON format with keys: "script" (string) and "key_objection_handlers" (array of strings).' }
            ],
            response_format: { type: "json_object" },
            max_completion_tokens: 500
          })
        });

        if (!azureResponse.ok) {
          const errText = await azureResponse.text();
          console.error(`[retentionCall] Azure error for ${client.company_name}: ${azureResponse.status} ${errText.substring(0, 200)}`);
          results.errors.push({ client_id: client.id, company: client.company_name, error: `Azure OpenAI: ${azureResponse.status}` });
          continue;
        }

        const azureData = await azureResponse.json();
        let scriptResponse = {};
        try {
          scriptResponse = JSON.parse(azureData.choices[0].message.content);
        } catch (_) {
          scriptResponse = { script: 'Standard retention script' };
        }

        // Build lead context inline
        let leadContext = '';
        try {
          const recentCalls = await base44.entities.CallLog.filter({ client_id: client.id }, '-created_date', 3);
          const ctxParts = [`CLIENT HISTORY:`];
          if (recentCalls.length > 0) {
            ctxParts.push(`Previous calls: ${recentCalls.length}`);
            recentCalls.forEach((c, i) => {
              const dt = c.call_start_time ? new Date(c.call_start_time).toLocaleDateString('en-IN') : 'Unknown';
              ctxParts.push(`  Call ${i+1} (${dt}): ${c.status} — ${(c.conversation_summary || '').substring(0, 200)}`);
            });
          }
          leadContext = ctxParts.join('\n');
        } catch (_) {}

        // Client-specific context
        const clientContext = [
          `\nCLIENT CONTEXT:`,
          `- Company: ${client.company_name}`,
          `- Industry: ${client.industry || 'General'}`,
          `- Account Status: ${client.account_status}`,
          `- Trial Expired: ${daysSinceExpiry} days ago`,
          `- Has CRM: ${client.has_custom_crm ? 'Yes' : 'No'}`,
          `- Channels: ${client.total_channels || 1}`,
          client.email ? `- Email: ${client.email}` : '',
        ].filter(Boolean).join('\n');

        // Build retention system prompt
        const retentionSystemPrompt = [
          retentionAgent.system_prompt || '',
          `\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time). Always confirm callback times in IST.`,
          `\nYou are ${retentionAgent.name}, an AI voice agent from VaaniAI.`,
          `IMPORTANT: Always start the call by greeting the customer warmly and introducing yourself.`,
          `\nRetention call script:\n${scriptResponse?.script || 'Standard retention script'}`,
          scriptResponse?.key_objection_handlers ? `\nKey objection handlers:\n${scriptResponse.key_objection_handlers.join('\n')}` : '',
          clientContext,
          leadContext ? `\n--- LEAD CONTEXT ---\n${leadContext}` : '',
          `\nPERSONALIZATION: Address the customer as "${client.company_name}".`,
        ].filter(Boolean).join('\n');

        // Create call log
        const callSid = `ret_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const agentPersona = retentionAgent.persona || {};

        const callLog = await base44.entities.CallLog.create({
          client_id: client.id,
          agent_id: retentionAgent.id,
          call_sid: callSid,
          caller_id: callerDID,
          callee_number: client.phone,
          direction: 'outbound',
          status: 'initiated',
          call_start_time: new Date().toISOString(),
          conversation_summary: `Retention call - Day ${daysSinceExpiry}. ${config.active_offer ? 'Offer: ' + config.active_offer : ''}`,
          agent_config_cache: {
            agent_name: retentionAgent.name,
            system_prompt: retentionSystemPrompt,
            persona: agentPersona,
            knowledge_base_content: kbContent,
            lead_context: leadContext,
            greeting_message: retentionAgent.greeting_message || '',
            human_transfer_number: retentionAgent.human_transfer_number || ''
          }
        });

        // Initiate call via Smartflo
        let cleanCallerID = callerDID.replace(/\D/g, '');
        if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;
        const cleanPhone = client.phone.replace(/\D/g, '');

        const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: smartfloApiKey,
            customer_number: cleanPhone,
            caller_id: cleanCallerID,
            async: 1
          })
        });

        const smartfloData = await smartfloResponse.json();
        console.log(`[retentionCall] Smartflo for ${client.company_name}: ${JSON.stringify(smartfloData).substring(0, 200)}`);

        if (!smartfloResponse.ok || smartfloData.success === false || smartfloData.caller_id) {
          const errorMsg = smartfloData.caller_id
            ? `Invalid caller_id: DID ${callerDID} not mapped to token's channel`
            : (smartfloData.message || 'Smartflo call failed');
          await base44.entities.CallLog.update(callLog.id, { status: 'failed' });
          results.errors.push({ client_id: client.id, company: client.company_name, error: errorMsg });
          continue;
        }

        // Update call_sid with Smartflo's actual ID
        const actualCallSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id || callSid;
        await base44.entities.CallLog.update(callLog.id, {
          call_sid: actualCallSid,
          status: 'ringing',
        });

        // Create activity
        await base44.entities.Activity.create({
          client_id: client.id,
          type: 'call',
          title: `Retention call - Day ${daysSinceExpiry}${config.active_offer ? ' (with offer)' : ''}`,
          description: `Automated retention call to ${client.company_name} (${client.phone}). ${config.active_offer || ''}`,
          scheduled_date: new Date().toISOString(),
          status: 'scheduled',
          priority: 'high',
          auto_created: true,
        });

        results.calls_initiated.push({
          client_id: client.id,
          company: client.company_name,
          phone: client.phone,
          days_since_expiry: daysSinceExpiry,
          call_id: callLog.id,
          call_sid: actualCallSid,
          offer: config.active_offer || null,
        });

        console.log(`[retentionCall] ✅ Call initiated for ${client.company_name} (day ${daysSinceExpiry})`);

        // Send follow-up email (fire-and-forget — don't block on it)
        if (client.email) {
          sendFollowupEmail(client, config).catch(e =>
            console.error(`[retentionCall] Email failed for ${client.company_name}: ${e.message}`)
          );
          results.emails_sent.push({ client_id: client.id, email: client.email });
        }

      } catch (clientErr) {
        console.error(`[retentionCall] Error processing ${client.company_name}: ${clientErr.message}`);
        results.errors.push({ client_id: client.id, company: client.company_name, error: clientErr.message });
      }
    }

    return c.json({ data: {
      success: true,
      total_expired_clients: expiredClients.length,
      eligible_clients: eligibleClients.length,
      processed: clientsToProcess.length,
      config_used: {
        call_days: callDays,
        max_calls: maxCallsPerClient,
        active_offer: config.active_offer || null,
        retention_did: config.retention_did || 'agent default',
      },
      ...results,
    } });
  } catch (error) {
    console.error('[retentionCall] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};

// Separate email function so it doesn't block the main flow
async function sendFollowupEmail(client, config) {
  const connStr = `endpoint=${Deno.env.get('AZURE_COMM_ENDPOINT')};accesskey=${Deno.env.get('AZURE_COMM_KEY')}`;
  const { EmailClient } = await import('npm:@azure/communication-email@1.0.0');
  const emailClient = new EmailClient(connStr);

  const offerHtml = config.active_offer ? `
    <div style="background:#fff8e1;border:2px dashed #f59e0b;border-radius:8px;padding:16px;margin:16px 0;text-align:center;">
      <p style="margin:0 0 4px;color:#92400e;font-weight:bold;">🎁 Special Offer: ${config.active_offer}</p>
      ${config.offer_code ? `<p style="margin:0;color:#b45309;font-size:14px;">Use code: <strong>${config.offer_code}</strong></p>` : ''}
      ${config.offer_expiry ? `<p style="margin:4px 0 0;color:#d97706;font-size:12px;">Expires: ${new Date(config.offer_expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>` : ''}
    </div>
  ` : '';

  const message = {
    senderAddress: 'DoNotReply@vaaniai.io',
    displayName: 'VaaniAI',
    content: {
      subject: 'Following up on our call — VaaniAI',
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#1a365d,#2d3748);padding:30px;text-align:center;border-radius:12px 12px 0 0;">
          <h1 style="color:white;margin:0;">VaaniAI</h1>
        </div>
        <div style="padding:30px;background:white;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
          <h2 style="color:#1a365d;">Hi ${client.company_name},</h2>
          <p style="color:#4a5568;line-height:1.6;">Thanks for taking our call! Your VaaniAI setup is still intact and ready to go.</p>
          ${offerHtml}
          <div style="background:#f7fafc;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
            <p style="margin:0 0 8px;color:#2d3748;font-weight:bold;">Starting at just ₹9,999/month</p>
            <p style="margin:0;color:#718096;font-size:13px;">Quarterly billing • Cancel anytime</p>
          </div>
          <div style="text-align:center;margin:30px 0;">
            <a href="https://vaaniai.in" style="background:linear-gradient(135deg,#e67e22,#f39c12);color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Subscribe Now</a>
          </div>
        </div>
      </div>`
    },
    recipients: { to: [{ address: client.email }] }
  };

  const poller = await getEmailClient().beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') {
    throw new Error(`ACS Email error: ${result.error?.message || result.status}`);
  }
  console.log(`[retentionCall] ✅ Email sent to ${client.email}`);
}