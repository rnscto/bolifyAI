import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";
import { sendClientEmailLogic } from "./sendClientEmail.ts";

async function azureLLM(prompt: string, systemPrompt: string, jsonSchema: any) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  
  if (!baseUrl || !deployment || !apiKey) {
    throw new Error('Azure OpenAI not configured');
  }

  let cleanBase = baseUrl;
  const openaiIdx = cleanBase.indexOf('/openai');
  if (openaiIdx > 0) cleanBase = cleanBase.substring(0, openaiIdx);
  const apiProjectIdx = cleanBase.indexOf('/api/projects');
  if (apiProjectIdx > 0) cleanBase = cleanBase.substring(0, apiProjectIdx);
  
  const url = `${cleanBase}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const headers = { 'api-key': apiKey, 'Content-Type': 'application/json' };
  const bodyObj = {
    messages: [
      { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
      { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
    ],
    max_completion_tokens: 2000,
    response_format: { type: "json_object" }
  };
  
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[azureLLM] Error ${res.status}: ${errText}`);
    throw new Error(`Azure OpenAI error: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const { action } = payload;

    // ── ACTION: generate_template ──
    if (action === 'generate_template') {
      const { lead_id, client_id, activity_id, template_type } = payload;

      let lead: any = null, client: any = null, activity: any = null, callLog: any = null;
      try { if (lead_id) lead = await base44ORM.entities.Lead.get(lead_id); } catch (e: any) { console.log(`Lead fetch failed: ${e.message}`); }
      try { if (client_id) client = await base44ORM.entities.Client.get(client_id); } catch (e: any) { console.log(`Client fetch failed: ${e.message}`); }
      try { if (activity_id) activity = await base44ORM.entities.Activity.get(activity_id); } catch (e: any) { console.log(`Activity fetch failed: ${e.message}`); }

      try {
        if (lead_id) {
          const calls = await base44ORM.entities.CallLog.filter({ lead_id, status: 'completed' }, '-created_at', 1);
          if (calls.length > 0) callLog = calls[0];
        }
      } catch (e: any) { console.log(`CallLog fetch failed: ${e.message}`); }

      let kbContent = '';
      if (callLog?.agent_config_cache?.knowledge_base_content) {
        kbContent = callLog.agent_config_cache.knowledge_base_content;
      } else if (callLog?.agent_id) {
        try {
          const agent = await base44ORM.entities.Agent.get(callLog.agent_id);
          if (agent?.knowledge_base_ids?.length > 0) {
            for (const kbId of agent.knowledge_base_ids) {
              try {
                const doc = await base44ORM.entities.KnowledgeBase.get(kbId);
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

      return c.json({ data: { success: true, template: result } });
    }

    // ── ACTION: send_email ──
    if (action === 'send_email') {
      const { to_email, from_name, subject, body_html, lead_id, client_id, activity_id, outreach_type } = payload;

      if (!to_email || !subject || !body_html) {
        return c.json({ data: { success: false, error: 'to_email, subject, and body_html are required' } });
      }

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

      try {
        await sendClientEmailLogic({
          client_id,
          to: to_email,
          subject,
          html: wrappedHtml,
          from_name: companyName
        });
      } catch (err: any) {
        console.error(`[composeEmail] email dispatch failed: ${err.message}`);
        return c.json({ data: { success: false, error: err.message } });
      }

      // Log the outreach
      if (lead_id && client_id) {
        try {
          await base44ORM.entities.OutreachLog.create({
            client_id,
            lead_id,
            channel: 'email',
            recipient_email: to_email,
            subject,
            body: body_html.substring(0, 2000),
            outreach_type: outreach_type || 'lead_followup',
            status: 'sent'
          });
        } catch (e: any) { console.error(`[composeEmail] OutreachLog creation failed: ${e.message}`); }
      }

      // Mark activity as completed if provided
      if (activity_id) {
        try {
          await base44ORM.entities.Activity.update(activity_id, {
            status: 'completed',
            completed_date: new Date().toISOString(),
            outcome: `Email sent: ${subject}`,
            notes: (payload.activity_notes || '') + `\n[Manual] Email sent to ${to_email} at ${new Date().toISOString()}`
          });
        } catch (e: any) { console.error(`[composeEmail] Activity update failed: ${e.message}`); }
      }

      return c.json({ data: { success: true, to: to_email } });
    }

    return c.json({ data: { success: false, error: 'Invalid action. Use generate_template or send_email' } });

  } catch (error: any) {
    console.error('[composeEmail] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
