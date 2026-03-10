import { createClient } from 'npm:@base44/sdk@0.8.20';
import { Resend } from 'npm:resend@4.0.0';

const resend = new Resend(Deno.env.get('RESEND_API_KEY'));

async function sendLeadEmail({ to, fromName, subject, html }) {
  const { data, error } = await resend.emails.send({
    from: `${fromName} <noreply@vaaniai.io>`,
    to,
    subject,
    html
  });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  return data;
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

// Beautiful HTML email template builder
function buildEmailTemplate({ companyName, leadName, subject, greeting, contentBlocks, ctaText, ctaSubtext, companyPhone, brandColor }) {
  const color = brandColor || '#2563eb';
  
  const blocksHtml = contentBlocks.map(block => {
    if (block.type === 'project_overview') {
      return `
        <div style="background: linear-gradient(135deg, ${color}08, ${color}15); border-radius: 12px; padding: 24px; margin: 20px 0; border-left: 4px solid ${color};">
          <h3 style="color: ${color}; margin: 0 0 12px 0; font-size: 18px;">🏢 ${block.title}</h3>
          <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
        </div>`;
    }
    if (block.type === 'location') {
      return `
        <div style="background: #f0fdf4; border-radius: 12px; padding: 24px; margin: 20px 0; border-left: 4px solid #22c55e;">
          <h3 style="color: #15803d; margin: 0 0 12px 0; font-size: 18px;">📍 Location & Address</h3>
          <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
        </div>`;
    }
    if (block.type === 'pricing') {
      return `
        <div style="background: #fef3c7; border-radius: 12px; padding: 24px; margin: 20px 0; border-left: 4px solid #f59e0b;">
          <h3 style="color: #92400e; margin: 0 0 12px 0; font-size: 18px;">💰 Pricing & Payment</h3>
          <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
        </div>`;
    }
    if (block.type === 'amenities') {
      return `
        <div style="background: #eff6ff; border-radius: 12px; padding: 24px; margin: 20px 0; border-left: 4px solid #3b82f6;">
          <h3 style="color: #1e40af; margin: 0 0 12px 0; font-size: 18px;">✨ Amenities & Features</h3>
          <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
        </div>`;
    }
    if (block.type === 'configurations') {
      return `
        <div style="background: #faf5ff; border-radius: 12px; padding: 24px; margin: 20px 0; border-left: 4px solid #a855f7;">
          <h3 style="color: #7e22ce; margin: 0 0 12px 0; font-size: 18px;">🏠 Configurations</h3>
          <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
        </div>`;
    }
    if (block.type === 'compliance') {
      return `
        <div style="background: #f1f5f9; border-radius: 12px; padding: 24px; margin: 20px 0; border-left: 4px solid #64748b;">
          <h3 style="color: #334155; margin: 0 0 12px 0; font-size: 18px;">✅ RERA & Compliance</h3>
          <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
        </div>`;
    }
    if (block.type === 'site_visit') {
      return `
        <div style="background: linear-gradient(135deg, #ecfdf5, #d1fae5); border-radius: 12px; padding: 24px; margin: 20px 0; border: 2px dashed #10b981;">
          <h3 style="color: #059669; margin: 0 0 12px 0; font-size: 18px;">📅 ${block.title || 'Your Site Visit'}</h3>
          <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
        </div>`;
    }
    // Generic block
    return `
      <div style="background: #f8fafc; border-radius: 12px; padding: 24px; margin: 20px 0; border-left: 4px solid #94a3b8;">
        <h3 style="color: #475569; margin: 0 0 12px 0; font-size: 18px;">${block.title || 'Details'}</h3>
        <p style="color: #374151; margin: 0; line-height: 1.7;">${block.content}</p>
      </div>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: 'Segoe UI', Arial, sans-serif;">
  <div style="max-width: 640px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, ${color}, ${color}dd); border-radius: 16px 16px 0 0; padding: 32px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 26px; font-weight: 700;">${companyName}</h1>
      <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0 0; font-size: 14px;">Your Trusted Partner</p>
    </div>

    <!-- Body -->
    <div style="background: white; padding: 36px 32px; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb;">
      <p style="color: #1f2937; font-size: 16px; line-height: 1.6; margin: 0 0 8px 0;">${greeting}</p>
      <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin: 0 0 24px 0;">
        As discussed during our conversation, here are the details you requested:
      </p>

      ${blocksHtml}

      <!-- CTA -->
      <div style="text-align: center; margin: 32px 0 16px 0;">
        <a href="tel:${companyPhone || ''}" style="display: inline-block; background: linear-gradient(135deg, ${color}, ${color}cc); color: white; padding: 16px 48px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; box-shadow: 0 4px 14px ${color}40;">
          ${ctaText || '📞 Call Us Now'}
        </a>
        ${ctaSubtext ? `<p style="color: #9ca3af; font-size: 12px; margin: 12px 0 0 0;">${ctaSubtext}</p>` : ''}
      </div>
    </div>

    <!-- Footer -->
    <div style="background: #1f2937; border-radius: 0 0 16px 16px; padding: 24px 32px; text-align: center;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">
        Sent with care by <strong style="color: #d1d5db;">${companyName}</strong> • Powered by VaaniAI
      </p>
      ${companyPhone ? `<p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">📞 ${companyPhone}</p>` : ''}
    </div>
  </div>
</body>
</html>`;
}

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const payload = await req.json();

    // Can be called in two modes:
    // 1. Direct: { lead_id, client_id } — sends content email based on last call
    // 2. Via automation/post-call: { call_log_id } — analyzes transcript and sends relevant content
    
    let callLog = null;
    let lead = null;
    let client = null;
    let clientId = payload.client_id;
    let leadId = payload.lead_id;

    if (payload.call_log_id) {
      callLog = await base44.entities.CallLog.get(payload.call_log_id);
      clientId = callLog.client_id;
      leadId = callLog.lead_id;
    }

    if (!leadId || !clientId) {
      return Response.json({ error: 'lead_id and client_id are required' }, { status: 400 });
    }

    lead = await base44.entities.Lead.get(leadId);
    client = await base44.entities.Client.get(clientId);

    const recipientEmail = payload.test_email || lead?.email;
    if (!recipientEmail) {
      return Response.json({ success: false, skipped: 'no_email', lead_name: lead?.name });
    }

    // Get the latest call log if not provided
    if (!callLog) {
      const callLogs = await base44.entities.CallLog.filter({ lead_id: leadId, status: 'completed' });
      callLogs.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
      callLog = callLogs[0];
    }

    if (!callLog) {
      return Response.json({ success: false, skipped: 'no_completed_call' });
    }

    const transcript = callLog.transcript || '';
    const summary = callLog.conversation_summary || '';
    const kbContent = callLog.agent_config_cache?.knowledge_base_content || '';

    // Also load knowledge base docs directly
    let fullKB = kbContent;
    if (!fullKB) {
      const agent = await base44.entities.Agent.get(callLog.agent_id);
      if (agent?.knowledge_base_ids?.length > 0) {
        for (const kbId of agent.knowledge_base_ids) {
          try {
            const doc = await base44.entities.KnowledgeBase.get(kbId);
            if (doc?.content) fullKB += `[${doc.title}]\n${doc.content}\n\n`;
          } catch (_) {}
        }
      }
    }

    // Step 1: AI analyzes transcript to determine what the customer SPECIFICALLY asked for
    const contentAnalysis = await azureLLM(
      `Analyze this sales call transcript and determine exactly what information the customer requested to be sent via email.

TRANSCRIPT:
${transcript.substring(0, 3000)}

CALL SUMMARY:
${summary}

LEAD NAME: ${lead.name || 'Customer'}
LEAD NOTES: ${lead.notes || ''}

Determine:
1. What specific content was requested? (project_details, location_address, pricing, brochure_info, amenities, configurations, site_visit_confirmation, payment_scheme, rera_details, sitemap, commercial_details, residential_details)
2. Which specific project/property was discussed?
3. Was a site visit scheduled? If yes, provide date/time.
4. What was the customer's primary interest? (residential/commercial/both)
5. Write a personalized greeting referencing the call.
6. Write a compelling email subject line.
7. Suggest a CTA text.`,
      'You are a sales email content analyst. Always respond in valid JSON.',
      {
        type: "object",
        properties: {
          requested_content: { type: "array", items: { type: "string" }, description: "List of content types requested" },
          project_name: { type: "string" },
          interest_type: { type: "string", enum: ["residential", "commercial", "both"] },
          site_visit_scheduled: { type: "boolean" },
          site_visit_date: { type: "string" },
          greeting: { type: "string" },
          subject: { type: "string" },
          cta_text: { type: "string" },
          cta_subtext: { type: "string" }
        }
      }
    );

    console.log(`[sendContentEmail] Analysis for ${lead.name}: ${JSON.stringify(contentAnalysis)}`);

    // Step 2: AI extracts ONLY the relevant sections from Knowledge Base
    const contentBlocks = await azureLLM(
      `Based on the customer's specific requests, extract the EXACT relevant information from the knowledge base and format it into structured content blocks.

CUSTOMER REQUEST TYPES: ${JSON.stringify(contentAnalysis.requested_content)}
PROJECT OF INTEREST: ${contentAnalysis.project_name || 'General'}
INTEREST TYPE: ${contentAnalysis.interest_type || 'general'}

KNOWLEDGE BASE CONTENT:
${fullKB.substring(0, 6000)}

CALL CONTEXT:
${summary}

INSTRUCTIONS:
- ONLY include content blocks for what the customer ACTUALLY asked for
- Extract PRECISE details — exact addresses, exact pricing, exact configurations
- Format content as clean HTML with <br> for line breaks, <strong> for emphasis
- Keep each block focused and concise (3-6 sentences max)
- If site visit is confirmed, include date/time: ${contentAnalysis.site_visit_date || 'N/A'}
- Include Google Maps friendly address format for location blocks
- For pricing, include exact numbers from KB, payment scheme details
- Do NOT include information that wasn't asked for`,
      'You are a real estate content specialist. Extract precise project details. Always respond in valid JSON.',
      {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["project_overview", "location", "pricing", "amenities", "configurations", "compliance", "site_visit", "general"] },
                title: { type: "string" },
                content: { type: "string" }
              }
            }
          }
        }
      }
    );

    console.log(`[sendContentEmail] Generated ${contentBlocks.blocks?.length || 0} content blocks`);

    // Step 3: Build and send the beautiful email
    const emailHtml = buildEmailTemplate({
      companyName: client.company_name || 'Our Company',
      leadName: lead.name || 'Valued Customer',
      subject: contentAnalysis.subject,
      greeting: contentAnalysis.greeting || `Dear ${lead.name || 'Sir/Madam'},`,
      contentBlocks: contentBlocks.blocks || [],
      ctaText: contentAnalysis.cta_text || '📞 Call Us Now',
      ctaSubtext: contentAnalysis.cta_subtext || '',
      companyPhone: client.phone || '',
      brandColor: '#1e3a5f'
    });

    await sendLeadEmail({
      to: recipientEmail,
      fromName: client.company_name || 'VaaniAI',
      subject: contentAnalysis.subject,
      html: emailHtml
    });

    // Log the outreach
    await base44.entities.OutreachLog.create({
      client_id: clientId,
      lead_id: leadId,
      call_log_id: callLog.id,
      channel: 'email',
      recipient_email: recipientEmail,
      subject: contentAnalysis.subject,
      body: `Content blocks: ${(contentBlocks.blocks || []).map(b => b.type).join(', ')}`,
      outreach_type: 'proposal',
      call_outcome: callLog.lead_status_updated || 'interested',
      ai_summary: `Sent: ${contentAnalysis.requested_content?.join(', ')} for ${contentAnalysis.project_name}`,
      status: 'sent'
    });

    // Update lead to mark email was sent
    await base44.entities.Lead.update(leadId, {
      auto_actions_taken: [...(lead.auto_actions_taken || []), `content_email_${new Date().toISOString().split('T')[0]}`]
    });

    console.log(`[sendContentEmail] ✅ Content email sent to ${lead.email} (${lead.name})`);

    return Response.json({
      success: true,
      lead_name: lead.name,
      email: lead.email,
      subject: contentAnalysis.subject,
      content_types: contentAnalysis.requested_content,
      project: contentAnalysis.project_name,
      blocks_count: contentBlocks.blocks?.length || 0
    });

  } catch (error) {
    console.error('[sendContentEmail] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});