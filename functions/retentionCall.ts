import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Load retention config
    const configs = await base44.asServiceRole.entities.RetentionConfig.list('-created_date', 1);
    const config = configs[0] || {};

    if (config.is_active === false) {
      return Response.json({ success: true, message: 'Retention system is paused', skipped: true });
    }

    const callDays = config.call_days_after_expiry || [2, 5];
    const maxCallsPerClient = config.max_calls_per_client || 3;
    const results = { calls_initiated: [], emails_sent: [], errors: [], skipped: [] };

    // Get all expired clients
    const expiredClients = await base44.asServiceRole.entities.Client.filter({ account_status: 'expired' });

    // Load all retention call logs to check call counts
    const allCallLogs = await base44.asServiceRole.entities.CallLog.list('-created_date', 500);

    for (const client of expiredClients) {
      if (!client.trial_end_date || !client.phone) continue;

      // Check exclusion list
      if (config.excluded_client_ids && config.excluded_client_ids.includes(client.id)) {
        results.skipped.push({ client_id: client.id, reason: 'excluded' });
        continue;
      }

      const trialEnd = new Date(client.trial_end_date);
      const now = new Date();
      const daysSinceExpiry = Math.floor((now - trialEnd) / (1000 * 60 * 60 * 24));

      // Check if today matches any configured call day
      if (!callDays.includes(daysSinceExpiry)) continue;

      // Check max calls per client
      const clientRetentionCalls = allCallLogs.filter(l => 
        l.client_id === client.id && (l.call_sid?.startsWith('ret_') || l.conversation_summary?.includes('Retention'))
      );
      if (clientRetentionCalls.length >= maxCallsPerClient) {
        results.skipped.push({ client_id: client.id, reason: 'max_calls_reached', count: clientRetentionCalls.length });
        continue;
      }

      // Determine which agent/DID to use
      let retentionAgent = null;
      if (config.retention_agent_id) {
        const agents = await base44.asServiceRole.entities.Agent.filter({ status: 'active' });
        retentionAgent = agents.find(a => a.id === config.retention_agent_id);
      }

      // Fallback: find any active agent with a DID
      if (!retentionAgent) {
        const allAgents = await base44.asServiceRole.entities.Agent.filter({ status: 'active' });
        retentionAgent = allAgents.find(a => a.assigned_did && a.assigned_did.trim() !== '');
      }

      if (!retentionAgent) {
        results.errors.push({ client_id: client.id, error: 'No active agent with DID available' });
        continue;
      }

      // Use configured retention DID or the agent's DID
      const callerDID = config.retention_did || retentionAgent.assigned_did;

      // Build personalized prompt with config-driven instructions
      let promptParts = [];
      
      promptParts.push(`Generate a short, warm, professional retention phone call script for a VaaniAI sales agent calling a customer whose free trial has expired.`);
      
      promptParts.push(`\nCustomer details:\n- Company: ${client.company_name}\n- Industry: ${client.industry || 'General'}\n- Trial expired: ${daysSinceExpiry} days ago\n- Has CRM: ${client.has_custom_crm ? 'Yes' : 'No'}`);

      // Add greeting template if configured
      if (config.greeting_template) {
        const greeting = config.greeting_template
          .replace('{company_name}', client.company_name)
          .replace('{industry}', client.industry || 'General')
          .replace('{days_since_expiry}', daysSinceExpiry.toString())
          .replace('{offer}', config.active_offer || '');
        promptParts.push(`\nUse this greeting: "${greeting}"`);
      }

      // Add active offer
      if (config.active_offer) {
        promptParts.push(`\nIMPORTANT: Mention this special offer: "${config.active_offer}"${config.offer_code ? ` (code: ${config.offer_code})` : ''}${config.offer_expiry ? ` (expires: ${config.offer_expiry})` : ''}`);
      }

      // Add custom instructions
      if (config.custom_instructions) {
        promptParts.push(`\nAdditional instructions: ${config.custom_instructions}`);
      }

      // Add objection handlers
      if (config.objection_handlers && config.objection_handlers.length > 0) {
        const handlers = config.objection_handlers
          .map(h => `- If they say "${h.objection}": ${h.response}`)
          .join('\n');
        promptParts.push(`\nObjection handling:\n${handlers}`);
      }

      promptParts.push(`\nDefault points to cover:\n1. Greet warmly\n2. Ask about their trial experience\n3. Highlight that their setup is preserved\n4. Mention pricing: ₹6,500/month per channel (quarterly billing)\n5. Be respectful if not interested\n\nKeep it conversational and under 200 words. Indian business context.`);

      const scriptResponse = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: promptParts.join('\n'),
        response_json_schema: {
          type: "object",
          properties: {
            script: { type: "string" },
            key_objection_handlers: { type: "array", items: { type: "string" } }
          }
        }
      });

      // Create call log
      const callSid = `ret_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const callLog = await base44.asServiceRole.entities.CallLog.create({
        client_id: client.id,
        agent_id: retentionAgent.id,
        call_sid: callSid,
        caller_id: callerDID,
        callee_number: client.phone,
        direction: 'outbound',
        status: 'initiated',
        call_start_time: new Date().toISOString(),
        conversation_summary: `Retention call - Day ${daysSinceExpiry}. ${config.active_offer ? 'Offer: ' + config.active_offer + '. ' : ''}Script: ${scriptResponse?.script?.substring(0, 200) || 'Standard retention'}`,
      });

      // Initiate call via Smartflo
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
        await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
        results.errors.push({ client_id: client.id, company: client.company_name, error: smartfloData.message || 'Smartflo call failed' });
        continue;
      }

      await base44.asServiceRole.entities.CallLog.update(callLog.id, {
        call_sid: smartfloData.call_id || smartfloData.call_sid || callSid,
        status: 'ringing',
      });

      // Create activity record
      await base44.asServiceRole.entities.Activity.create({
        client_id: client.id,
        type: 'call',
        title: `Retention call - Day ${daysSinceExpiry}${config.active_offer ? ' (with offer)' : ''}`,
        description: `Automated retention call to ${client.company_name} (${client.phone}). ${config.active_offer || ''}`,
        scheduled_date: new Date().toISOString(),
        status: 'completed',
        priority: 'high',
        auto_created: true,
      });

      results.calls_initiated.push({
        client_id: client.id,
        company: client.company_name,
        phone: client.phone,
        days_since_expiry: daysSinceExpiry,
        call_id: callLog.id,
        offer: config.active_offer || null,
      });

      // Send follow-up email
      const offerHtml = config.active_offer ? `
        <div style="background: #fff8e1; border: 2px dashed #f59e0b; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: center;">
          <p style="margin: 0 0 4px; color: #92400e; font-weight: bold;">🎁 Special Offer: ${config.active_offer}</p>
          ${config.offer_code ? `<p style="margin: 0; color: #b45309; font-size: 14px;">Use code: <strong>${config.offer_code}</strong></p>` : ''}
          ${config.offer_expiry ? `<p style="margin: 4px 0 0; color: #d97706; font-size: 12px;">Expires: ${new Date(config.offer_expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>` : ''}
        </div>
      ` : '';

      await base44.asServiceRole.integrations.Core.SendEmail({
        to: client.email,
        subject: `Following up on our call — VaaniAI`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
              <h1 style="color: white; margin: 0;">VaaniAI</h1>
            </div>
            <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
              <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
              <p style="color: #4a5568; line-height: 1.6;">Thanks for taking our call! Your VaaniAI setup is still intact and ready to go.</p>
              ${offerHtml}
              <div style="background: #f7fafc; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
                <p style="margin: 0 0 8px; color: #2d3748; font-weight: bold;">Starting at just ₹6,500/month</p>
                <p style="margin: 0; color: #718096; font-size: 13px;">Quarterly billing • Cancel anytime</p>
              </div>
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://vaaniai.in" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Subscribe Now</a>
              </div>
            </div>
          </div>
        `,
      });
      results.emails_sent.push({ client_id: client.id, email: client.email });
    }

    return Response.json({
      success: true,
      total_expired_clients: expiredClients.length,
      config_used: {
        call_days: callDays,
        max_calls: maxCallsPerClient,
        active_offer: config.active_offer || null,
        retention_did: config.retention_did || 'agent default',
      },
      ...results,
    });
  } catch (error) {
    console.error('Retention call error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});