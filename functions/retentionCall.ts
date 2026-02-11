import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const results = { calls_initiated: [], emails_sent: [], errors: [] };

    // Get all expired clients
    const expiredClients = await base44.asServiceRole.entities.Client.filter({ account_status: 'expired' });

    for (const client of expiredClients) {
      if (!client.trial_end_date || !client.phone) continue;

      const trialEnd = new Date(client.trial_end_date);
      const now = new Date();
      const daysSinceExpiry = Math.floor((now - trialEnd) / (1000 * 60 * 60 * 24));

      // Call on day 2 and day 5 after expiry
      if (daysSinceExpiry !== 2 && daysSinceExpiry !== 5) continue;

      // Find a VaaniAI retention agent (admin-owned agent with "retention" in name or system prompt)
      // Use any available active agent with a DID, preferably the first admin agent
      const allAgents = await base44.asServiceRole.entities.Agent.filter({ status: 'active' });
      const retentionAgent = allAgents.find(a => 
        a.assigned_did && a.assigned_did.trim() !== ''
      );

      if (!retentionAgent) {
        results.errors.push({ 
          client_id: client.id, 
          error: 'No active agent with DID available for retention calls' 
        });
        continue;
      }

      // Generate a personalized retention script using AI
      const scriptResponse = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `Generate a short, warm, professional retention phone call script for a VaaniAI sales agent calling a customer whose free trial has expired.

Customer details:
- Company: ${client.company_name}
- Industry: ${client.industry || 'General'}
- Trial expired: ${daysSinceExpiry} days ago
- Has CRM: ${client.has_custom_crm ? 'Yes' : 'No'}

The agent should:
1. Greet warmly and introduce themselves as being from VaaniAI
2. Ask about their trial experience
3. Address common objections (cost, not sure about ROI, need more time)
4. Highlight that their agent setup and data are preserved
5. Mention the pricing: ₹6,500/month per channel (quarterly billing)
6. Offer to help them subscribe or answer questions
7. Be respectful if they're not interested

Keep it conversational and under 200 words. Indian business context.`,
        response_json_schema: {
          type: "object",
          properties: {
            script: { type: "string" },
            key_objection_handlers: { 
              type: "array", 
              items: { type: "string" } 
            }
          }
        }
      });

      // Create a retention-specific call log
      const callSid = `ret_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const callLog = await base44.asServiceRole.entities.CallLog.create({
        client_id: client.id,
        agent_id: retentionAgent.id,
        call_sid: callSid,
        caller_id: retentionAgent.assigned_did,
        callee_number: client.phone,
        direction: 'outbound',
        status: 'initiated',
        call_start_time: new Date().toISOString(),
        conversation_summary: `Retention call - Day ${daysSinceExpiry} after trial expiry. Script: ${scriptResponse?.script?.substring(0, 200) || 'Standard retention'}`,
      });

      // Initiate actual call via Smartflo
      const cleanCallerID = retentionAgent.assigned_did.replace(/\D/g, '');
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
        results.errors.push({ 
          client_id: client.id, 
          company: client.company_name,
          error: smartfloData.message || 'Smartflo call failed' 
        });
        continue;
      }

      // Update call log
      await base44.asServiceRole.entities.CallLog.update(callLog.id, {
        call_sid: smartfloData.call_id || smartfloData.call_sid || callSid,
        status: 'ringing',
      });

      // Create activity record
      await base44.asServiceRole.entities.Activity.create({
        client_id: client.id,
        type: 'call',
        title: `Automated retention call - Day ${daysSinceExpiry}`,
        description: `Automated call to ${client.company_name} (${client.phone}). Trial expired ${daysSinceExpiry} days ago.`,
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
      });

      // Also send a follow-up SMS-style email after the call
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
              <p style="color: #4a5568; line-height: 1.6;">Thanks for taking our call! As discussed, your VaaniAI setup is still intact and ready to go.</p>
              <p style="color: #4a5568; line-height: 1.6;">Here's a quick summary of what you get with a subscription:</p>
              <ul style="color: #4a5568; line-height: 1.8;">
                <li>AI Voice Agent making/receiving calls 24/7</li>
                <li>Automated lead qualification & follow-ups</li>
                <li>Call transcripts & AI summaries</li>
                <li>Full CRM with deal pipeline</li>
                <li>Knowledge base training</li>
              </ul>
              <div style="background: #f7fafc; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
                <p style="margin: 0 0 8px; color: #2d3748; font-weight: bold;">Starting at just ₹6,500/month</p>
                <p style="margin: 0; color: #718096; font-size: 13px;">Quarterly billing • Cancel anytime</p>
              </div>
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://vaaniai.in" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Subscribe Now</a>
              </div>
              <p style="color: #718096; font-size: 13px; text-align: center;">Questions? Reply to this email or call us.</p>
            </div>
          </div>
        `,
      });
      results.emails_sent.push({ client_id: client.id, email: client.email });
    }

    return Response.json({
      success: true,
      total_expired_clients: expiredClients.length,
      ...results,
    });
  } catch (error) {
    console.error('Retention call error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});