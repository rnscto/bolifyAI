import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.25';

// Send email using client's configured provider via centralized sendClientEmail function
// Falls back to platform SMTP if client has no email config
async function sendEmail({ to, subject, html, displayName, clientId }) {
  if (clientId) {
    try {
      const appId = Deno.env.get('BASE44_APP_ID');
      const svcBase44 = createClient({ appId, asServiceRole: true });
      const result = await svcBase44.functions.invoke('sendClientEmail', {
        client_id: clientId,
        to,
        subject,
        html,
        from_name: displayName
      });
      console.log(`[composeEmail] Email sent via ${result.data?.provider || 'unknown'} for client ${clientId}`);
      return result.data;
    } catch (e) {
      console.warn(`[composeEmail] sendClientEmail failed, falling back to platform SMTP: ${e.message}`);
    }
  }
  // Fallback: platform SMTP
  const { SMTPClient } = await import('npm:emailjs@4.0.3');
  const smtpHost = Deno.env.get('PLATFORM_SMTP_HOST');
  const smtpUser = Deno.env.get('PLATFORM_SMTP_USER');
  const smtpPass = Deno.env.get('PLATFORM_SMTP_PASS');
  const smtpFrom = Deno.env.get('PLATFORM_SMTP_FROM') || smtpUser;
  const smtpPort = parseInt(Deno.env.get('PLATFORM_SMTP_PORT') || '587');

  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new Error('Platform SMTP not configured');
  }
  const client = new SMTPClient({
    user: smtpUser, password: smtpPass, host: smtpHost, port: smtpPort, tls: true, timeout: 15000
  });
  const name = displayName || 'Bolify AI';
  await client.sendAsync({
    from: `${name} <${smtpFrom}>`,
    to, subject,
    attachment: [{ data: html, alternative: true }]
  });
  return { provider: 'platform_smtp', status: 'sent' };
}

// Azure OpenAI helper
async function azureLLM(prompt, systemPrompt, jsonSchema) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_completion_tokens: 2000,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await req.json();
    const { action } = payload;

    // ── ACTION: generate_template ──
    // Generates AI email template based on activity context, lead info, and call history
    if (action === 'generate_template') {
      const { lead_id, client_id, activity_id, template_type } = payload;

      let lead = null, client = null, activity = null, callLog = null;
      if (lead_id) lead = await base44.entities.Lead.get(lead_id);
      if (client_id) client = await base44.entities.Client.get(client_id);
      if (activity_id) activity = await base44.entities.Activity.get(activity_id);

      // Get latest call for this lead
      if (lead_id) {
        const calls = await base44.entities.CallLog.filter({ lead_id, status: 'completed' }, '-created_date', 1);
        if (calls.length > 0) callLog = calls[0];
      }

      // Get knowledge base content
      let kbContent = '';
      if (callLog?.agent_config_cache?.knowledge_base_content) {
        kbContent = callLog.agent_config_cache.knowledge_base_content;
      } else if (callLog?.agent_id) {
        try {
          const agent = await base44.entities.Agent.get(callLog.agent_id);
          if (agent?.knowledge_base_ids?.length > 0) {
            for (const kbId of agent.knowledge_base_ids) {
              try {
                const doc = await base44.entities.KnowledgeBase.get(kbId);
                if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n`;
              } catch (_) {}
            }
          }
        } catch (_) {}
      }

      const templatePrompt = `Generate a professional email template for a client admin to send to a lead.

CONTEXT:
- Company: ${client?.company_name || 'Our Company'}
- Lead Name: ${lead?.name || 'Customer'}
- Lead Email: ${lead?.email || 'N/A'}
- Lead Company: ${lead?.company || 'N/A'}
- Lead Status: ${lead?.status || 'N/A'}
- Lead Score: ${lead?.score || 'N/A'}/100
- Lead Tier: ${lead?.qualification_tier || 'N/A'}
- Lead Notes: ${(lead?.notes || '').substring(0, 500)}

${activity ? `ACTIVITY:
- Type: ${activity.type}
- Title: ${activity.title}
- Description: ${activity.description || 'N/A'}
- Notes: ${(activity.notes || '').substring(0, 300)}` : ''}

${callLog ? `LAST CALL:
- Summary: ${(callLog.conversation_summary || '').substring(0, 500)}
- Transcript excerpt: ${(callLog.transcript || '').substring(0, 1000)}` : ''}

${kbContent ? `KNOWLEDGE BASE (use for accurate details):
${kbContent.substring(0, 3000)}` : ''}

TEMPLATE TYPE: ${template_type || 'follow_up'}
Available types: follow_up, pricing, brochure, proposal, demo_details, site_visit, thank_you, custom

RULES:
- Write the email in a professional, warm Indian business tone
- Reference specific details from the call transcript if available
- Use HTML formatting with <br> for line breaks, <strong> for emphasis, <ul><li> for lists
- Include REAL details from the knowledge base (pricing, features, addresses) — don't use placeholders
- Subject line should be compelling and specific
- Email should be 100-250 words
- Include a clear CTA at the end`;

      const result = await azureLLM(
        templatePrompt,
        'You are an expert business email writer for Indian companies. Write compelling, personalized emails. Always respond in valid JSON.',
        {
          type: "object",
          properties: {
            subject: { type: "string", description: "Email subject line" },
            body_html: { type: "string", description: "Email body in HTML" },
            greeting: { type: "string", description: "Opening greeting line" },
            template_type: { type: "string" },
            suggested_attachments: { type: "array", items: { type: "string" }, description: "Suggested attachments to include manually" }
          }
        }
      );

      return Response.json({ success: true, template: result });
    }

    // ── ACTION: send_email ──
    // Sends the composed email via Azure Communication Services
    if (action === 'send_email') {
      const { to_email, from_name, subject, body_html, lead_id, client_id, activity_id, outreach_type } = payload;

      if (!to_email || !subject || !body_html) {
        return Response.json({ error: 'to_email, subject, and body_html are required' }, { status: 400 });
      }

      // Wrap in a nice template
      const brandColor = '#1e3a5f';
      const companyName = from_name || 'Bolify AI';
      const wrappedHtml = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,${brandColor},${brandColor}dd);border-radius:16px 16px 0 0;padding:24px 32px;text-align:center;">
      <h1 style="color:white;margin:0;font-size:22px;font-weight:700;">${companyName}</h1>
    </div>
    <div style="background:white;padding:32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
      ${body_html}
    </div>
    <div style="background:#1f2937;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
      <p style="color:#9ca3af;font-size:12px;margin:0;">Sent by <strong style="color:#d1d5db;">${companyName}</strong> • Powered by Bolify AI</p>
    </div>
  </div>
</body>
</html>`;

      await sendEmail({
        to: to_email,
        subject,
        html: wrappedHtml,
        displayName: companyName,
        clientId: client_id
      });

      // Log the outreach
      if (lead_id && client_id) {
        await base44.entities.OutreachLog.create({
          client_id,
          lead_id,
          channel: 'email',
          recipient_email: to_email,
          subject,
          body: body_html.substring(0, 2000),
          outreach_type: outreach_type || 'lead_followup',
          status: 'sent'
        });
      }

      // Mark activity as completed if provided
      if (activity_id) {
        await base44.entities.Activity.update(activity_id, {
          status: 'completed',
          completed_date: new Date().toISOString(),
          outcome: `Email sent: ${subject}`,
          notes: (payload.activity_notes || '') + `\n[Manual] Email sent to ${to_email} at ${new Date().toISOString()}`
        });
      }

      return Response.json({ success: true, to: to_email });
    }

    return Response.json({ error: 'Invalid action. Use generate_template or send_email' }, { status: 400 });

  } catch (error) {
    console.error('[composeEmail] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});