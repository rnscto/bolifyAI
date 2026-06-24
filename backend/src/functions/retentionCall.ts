import { base44ORM as base44 } from "../db/orm.ts";

async function sendEmailViaSMTP({ to, fromName, subject, html }: any) {
  const { SMTPClient } = await import('emailjs');
  const smtpHost = Deno.env.get('PLATFORM_SMTP_HOST');
  const smtpUser = Deno.env.get('PLATFORM_SMTP_USER');
  const smtpPass = Deno.env.get('PLATFORM_SMTP_PASS');
  const smtpFrom = Deno.env.get('PLATFORM_SMTP_FROM') || smtpUser;
  const smtpPort = parseInt(Deno.env.get('PLATFORM_SMTP_PORT') || '587');
  
  if (!smtpHost || !smtpUser || !smtpPass) throw new Error('Platform SMTP not configured');
  
  const client = new SMTPClient({ user: smtpUser, password: smtpPass, host: smtpHost, port: smtpPort, tls: true, timeout: 15000 });
  await client.sendAsync({ from: `${fromName || 'Bolify AI'} <${smtpFrom}>`, to, subject, text: '', attachment: [{ data: html, alternative: true }] });
  return { provider: 'platform_smtp', status: 'sent' };
}

export default async function retentionCall(c: any) {
  try {
    let forceRun = false;

    if (c.req.method === 'GET') {
      const cronSecret = c.req.query('cron_secret');
      const cronApiKey = c.req.query('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
      console.log('[retentionCall] Triggered by external cron');
    } else {
      const user = c.get('user');
      if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
      
      let requestBody: any = {};
      try {
        requestBody = await c.req.json();
      } catch (_) {}
      forceRun = requestBody.force === true;
    }

    const configs = await base44.entities.RetentionConfig.filter({}, '-created_date', 1);
    const config = configs[0] || {};

    if (config.is_active === false) {
      return c.json({ data: { success: true, message: 'Retention system is paused', skipped: true } });
    }

    const callDays = config.call_days_after_expiry || [2, 5, 7, 10, 14, 21, 30];
    const maxCallsPerClient = config.max_calls_per_client || 5;
    const results = { calls_initiated: [] as any[], emails_sent: [] as any[], errors: [] as any[], skipped: [] as any[], force_mode: forceRun };

    const explicitlyExpired = await base44.entities.Client.filter({ account_status: 'expired' });
    const trialClients = await base44.entities.Client.filter({ account_status: 'trial' });

    const now = new Date();
    const staleTrials = [];
    for (const tc of trialClients) {
      if (tc.trial_end_date && new Date(tc.trial_end_date) < now) {
        await base44.entities.Client.update(tc.id, { account_status: 'expired' });
        tc.account_status = 'expired';
        staleTrials.push(tc);
        console.log(`[retentionCall] Auto-expired stale trial: ${tc.company_name}`);
      }
    }

    const expiredClients = [...explicitlyExpired, ...staleTrials];
    console.log(`[retentionCall] Found ${expiredClients.length} expired clients`);

    const allCallLogs = await base44.entities.CallLog.filter({}, '-created_date', 500);

    for (const client of expiredClients) {
      if (!client.trial_end_date || !client.phone) continue;

      if (config.excluded_client_ids && config.excluded_client_ids.includes(client.id)) {
        results.skipped.push({ client_id: client.id, reason: 'excluded' });
        continue;
      }

      const trialEnd = new Date(client.trial_end_date);
      const daysSinceExpiry = Math.floor((now.getTime() - trialEnd.getTime()) / (1000 * 60 * 60 * 24));

      if (!forceRun && !callDays.includes(daysSinceExpiry)) continue;

      const clientRetentionCalls = allCallLogs.filter((l: any) =>
        l.client_id === client.id && (l.call_sid?.startsWith('ret_') || l.conversation_summary?.includes('Retention'))
      );
      if (!forceRun && clientRetentionCalls.length >= maxCallsPerClient) {
        results.skipped.push({ client_id: client.id, reason: 'max_calls_reached', count: clientRetentionCalls.length });
        continue;
      }

      let retentionAgent = null;
      if (config.retention_agent_id) {
        const agents = await base44.entities.Agent.filter({ status: 'active' });
        retentionAgent = agents.find((a: any) => a.id === config.retention_agent_id);
      }

      if (!retentionAgent) {
        const allAgents = await base44.entities.Agent.filter({ status: 'active' });
        retentionAgent = allAgents.find((a: any) => {
          if (a.assigned_dids?.length > 0) return true;
          if (a.assigned_did && a.assigned_did.trim() !== '') return true;
          return false;
        });
      }

      if (!retentionAgent) {
        results.errors.push({ client_id: client.id, error: 'No active agent with DID available' });
        continue;
      }

      const agentDIDs = (retentionAgent.assigned_dids?.length > 0)
        ? retentionAgent.assigned_dids
        : (retentionAgent.assigned_did ? [retentionAgent.assigned_did] : []);
      const callerDID = config.retention_did || agentDIDs[0];

      if (!callerDID) {
        results.errors.push({ client_id: client.id, error: 'No DID available for retention calls' });
        continue;
      }

      let promptParts = [];
      promptParts.push(`Generate a short, warm, professional retention phone call script for a Bolify AI sales agent calling a customer whose free trial has expired.`);
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
        const handlers = config.objection_handlers.map((h: any) => `- If they say "${h.objection}": ${h.response}`).join('\n');
        promptParts.push(`\nObjection handling:\n${handlers}`);
      }

      promptParts.push(`\nDefault points to cover:\n1. Greet warmly\n2. Ask about their trial experience\n3. Highlight that their setup is preserved\n4. Mention pricing: ₹6,500/month per channel (quarterly billing)\n5. Be respectful if not interested\n\nKeep it conversational and under 200 words. Indian business context.`);

      let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
      const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
      const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
      const oIdx = baseUrl.indexOf('/openai/'); if (oIdx > 0) baseUrl = baseUrl.substring(0, oIdx);
      const pIdx = baseUrl.indexOf('/api/projects'); if (pIdx > 0) baseUrl = baseUrl.substring(0, pIdx);

      if (!baseUrl || !deployment || !apiKey) {
        results.errors.push({ client_id: client.id, error: 'Missing Azure OpenAI secrets' });
        continue;
      }

      const azureUri = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;

      const azureResponse = await fetch(azureUri, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'You are a helpful assistant that generates cold call scripts. Always respond in valid JSON.' },
            { role: 'user', content: promptParts.join('\n') + '\n\nRespond in JSON format with keys: "script" (string) and "key_objection_handlers" (array of strings).' }
          ],
          response_format: { type: "json_object" }
        })
      });

      if (!azureResponse.ok) {
        results.errors.push({ client_id: client.id, error: `Azure OpenAI: ${azureResponse.status}` });
        continue;
      }

      const azureData = await azureResponse.json();
      const scriptResponse = JSON.parse(azureData.choices[0].message.content);

      let kbContent = '';
      if (retentionAgent.knowledge_base_ids?.length > 0) {
        for (const kbId of retentionAgent.knowledge_base_ids) {
          try {
            const doc = await base44.entities.KnowledgeBase.get(kbId);
            if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
          } catch (_) {}
        }
      }

      let leadContext = '';
      try {
        const clientLeads = await base44.entities.Lead.filter({ client_id: client.id });
        const recentCalls = await base44.entities.CallLog.filter({ client_id: client.id }, '-created_date', 3);
        const ctxParts = [`CLIENT HISTORY:`];
        if (recentCalls.length > 0) {
          ctxParts.push(`Previous calls: ${recentCalls.length}`);
          recentCalls.forEach((c: any, i: number) => {
            const dt = c.call_start_time ? new Date(c.call_start_time).toLocaleDateString('en-IN') : 'Unknown';
            ctxParts.push(`  Call ${i+1} (${dt}): ${c.status} — ${(c.conversation_summary || '').substring(0, 200)}`);
          });
        }
        if (clientLeads.length > 0) ctxParts.push(`Total leads: ${clientLeads.length}`);
        leadContext = ctxParts.join('\n');
      } catch (_) {}

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

      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

      const retentionSystemPrompt = [
        retentionAgent.system_prompt || '',
        `\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time). Use this for any relative time calculations. Always confirm callback times in IST.`,
        `\nYou are ${retentionAgent.name}, an AI voice agent from Bolify AI.`,
        `IMPORTANT: Always start the call by greeting the customer warmly and introducing yourself.`,
        `\nRetention call script:\n${scriptResponse?.script || 'Standard retention script'}`,
        scriptResponse?.key_objection_handlers ? `\nKey objection handlers:\n${scriptResponse.key_objection_handlers.join('\n')}` : '',
        clientContext,
        leadContext ? `\n--- LEAD CONTEXT ---\n${leadContext}` : '',
        `\nPERSONALIZATION: Address the customer as "${client.company_name}".`,
      ].filter(Boolean).join('\n');

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
        conversation_summary: '',
        agent_config_cache: {
          agent_name: retentionAgent.name,
          system_prompt: retentionSystemPrompt,
          persona: agentPersona,
          knowledge_base_content: kbContent,
          lead_context: leadContext,
          greeting_message: retentionAgent.greeting_message || ''
        }
      });

      const cleanCallerID = callerDID.replace(/\D/g, '');
      const cleanPhone = client.phone.replace(/\D/g, '');

      const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: Deno.env.get('SMARTFLO_API_KEY'),
          customer_number: cleanPhone,
          caller_id: cleanCallerID,
          async: 1
        })
      });

      const smartfloData = await smartfloResponse.json();

      if (!smartfloResponse.ok || smartfloData.success === false) {
        await base44.entities.CallLog.update(callLog.id, { status: 'failed' });
        results.errors.push({ client_id: client.id, company: client.company_name, error: smartfloData.message || 'Smartflo call failed' });
        continue;
      }

      const actualCallSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id || callSid;
      await base44.entities.CallLog.update(callLog.id, {
        call_sid: actualCallSid,
        status: 'ringing',
      });

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

      if (client.email) {
        try {
          const offerHtml = config.active_offer ? `
            <div style="background:#fff8e1;border:2px dashed #f59e0b;border-radius:8px;padding:16px;margin:16px 0;text-align:center;">
              <p style="margin:0 0 4px;color:#92400e;font-weight:bold;">🎁 Special Offer: ${config.active_offer}</p>
              ${config.offer_code ? `<p style="margin:0;color:#b45309;font-size:14px;">Use code: <strong>${config.offer_code}</strong></p>` : ''}
              ${config.offer_expiry ? `<p style="margin:4px 0 0;color:#d97706;font-size:12px;">Expires: ${new Date(config.offer_expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>` : ''}
            </div>
          ` : '';

          await sendEmailViaSMTP({
            to: client.email,
            fromName: 'Bolify AI',
            subject: 'Following up on our call — Bolify AI',
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:linear-gradient(135deg,#1a365d,#2d3748);padding:30px;text-align:center;border-radius:12px 12px 0 0;">
                <h1 style="color:white;margin:0;">Bolify AI</h1>
              </div>
              <div style="padding:30px;background:white;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
                <h2 style="color:#1a365d;">Hi ${client.company_name},</h2>
                <p style="color:#4a5568;line-height:1.6;">Thanks for taking our call! Your Bolify AI setup is still intact and ready to go.</p>
                ${offerHtml}
                <div style="background:#f7fafc;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
                  <p style="margin:0 0 8px;color:#2d3748;font-weight:bold;">Starting at just ₹6,500/month</p>
                  <p style="margin:0;color:#718096;font-size:13px;">Quarterly billing • Cancel anytime</p>
                </div>
                <div style="text-align:center;margin:30px 0;">
                  <a href="https://bolify.ai" style="background:linear-gradient(135deg,#e67e22,#f39c12);color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Subscribe Now</a>
                </div>
              </div>
            </div>`
          });
          results.emails_sent.push({ client_id: client.id, email: client.email });
        } catch (emailErr: any) {
          console.error(`[retentionCall] Email failed for ${client.company_name}: ${emailErr.message}`);
        }
      }
    }

    return c.json({
      data: {
        success: true,
        total_expired_clients: expiredClients.length,
        config_used: {
          call_days: callDays,
          max_calls: maxCallsPerClient,
          active_offer: config.active_offer || null,
          retention_did: config.retention_did || 'agent default',
        },
        ...results,
      }
    });
  } catch (error: any) {
    console.error('[retentionCall] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
