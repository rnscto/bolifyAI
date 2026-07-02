import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// sendEmailFromTemplate — Send a templated email with attachments
//
// Provider-agnostic (Azure ACS by default, falls back to ClientMessagingConfig).
// Handles:
//   - Variable interpolation ({{name}}, {{company}}, {{agent_name}}, {{meeting_link}}, custom)
//   - AI personalization (off | variables_only | rewrite_body | full_ai)
//   - Brand voice (signature, footer disclaimer, CC/BCC, brand color)
//   - Attachments fetched from Azure Blob via SAS signed URLs → base64 inline
//   - Auto meeting link injection when lead has scheduled meeting
//   - OutreachLog tracking
//
// Payload:
//   { client_id, template_id, to_email, lead_id?, call_log_id?, activity_id?,
//     variables?: { name, company, custom_1, ... },
//     extra_attachment_ids?: [],
//     outreach_type?: 'lead_followup' }
// ═══════════════════════════════════════════════════════════════════



function interpolate(str, vars) {
  if (!str) return '';
  return Object.entries(vars || {}).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'gi'), v ?? ''),
    String(str)
  );
}

async function azureLLM(prompt, systemPrompt) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You write professional business emails. Return JSON.' },
        { role: 'user', content: prompt }
      ],
      max_completion_tokens: 1500,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content || '{}');
}

function buildBrandedShell({ companyName, brandColor, bodyHtml, signatureHtml, footerDisclaimer, ctaLabel, ctaUrl }) {
  const color = brandColor || '#1e3a5f';
  const cta = ctaLabel && ctaUrl ? `
    <div style="text-align:center;margin:28px 0 12px;">
      <a href="${ctaUrl}" style="display:inline-block;background:${color};color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">${ctaLabel}</a>
    </div>` : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,${color},${color}dd);border-radius:16px 16px 0 0;padding:24px 32px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">${companyName}</h1>
    </div>
    <div style="background:#fff;padding:32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;color:#1f2937;font-size:15px;line-height:1.6;">
      ${bodyHtml}
      ${cta}
      ${signatureHtml ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;color:#374151;font-size:14px;">${signatureHtml}</div>` : ''}
    </div>
    <div style="background:#1f2937;border-radius:0 0 16px 16px;padding:18px 32px;text-align:center;">
      <p style="color:#9ca3af;font-size:11px;margin:0;line-height:1.5;">
        ${footerDisclaimer ? footerDisclaimer + '<br>' : ''}
        Sent by <strong style="color:#d1d5db;">${companyName}</strong> • Powered by VaaniAI
      </p>
    </div>
  </div></body></html>`;
}

async function fetchAttachmentAsBase64(base44, attachmentId) {
  const att = await base44.entities.EmailAttachment.get(attachmentId).catch(() => null);
  if (!att?.file_uri) return null;
  // Get signed URL
  const sig = await base44.functions.invoke('azureBlobSignedUrl', { file_uri: att.file_uri, expires_in: 600 });
  const signedUrl = sig?.data?.signed_url;
  if (!signedUrl) return null;
  const res = await fetch(signedUrl);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  // base64 encode in chunks (avoids stack overflow for big files)
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return {
    name: att.file_name || att.name,
    contentType: att.file_type || 'application/octet-stream',
    contentInBase64: btoa(binary)
  };
}

export default async function sendEmailFromTemplate(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const base44 = client.asServiceRole;

    const payload = await c.req.json();
    const {
      client_id, template_id, to_email,
      lead_id, call_log_id, activity_id,
      variables = {}, extra_attachment_ids = [],
      outreach_type = 'lead_followup',
      email_campaign_id = null,
      require_client_provider = false
    } = payload;

    if (!client_id || !template_id || !to_email) {
      return c.json({ data: { error: 'client_id, template_id, to_email required' } }, 400);
    }

    const [template, clientRecord, msgConfig] = await Promise.all([
      base44.entities.EmailTemplate.get(template_id).catch(() => null),
      base44.entities.Client.get(client_id).catch(() => null),
      base44.entities.ClientMessagingConfig.filter({ client_id }).then(l => l[0]).catch(() => null)
    ]);

    if (!template) return c.json({ data: { error: 'Template not found' } }, 404);
    if (template.enabled === false) return c.json({ data: { error: 'Template disabled' } }, 400);

    // ── Build variable map ──
    let lead = null, callLog = null, activity = null, agentRecord = null;
    if (lead_id) lead = await base44.entities.Lead.get(lead_id).catch(() => null);
    if (call_log_id) callLog = await base44.entities.CallLog.get(call_log_id).catch(() => null);
    if (activity_id) activity = await base44.entities.Activity.get(activity_id).catch(() => null);

    // Resolve the AI agent's name (used for email sign-off)
    if (callLog?.agent_id) {
      agentRecord = await base44.entities.Agent.get(callLog.agent_id).catch(() => null);
    }
    const resolvedAgentName = variables.agent_name
      || agentRecord?.name
      || clientRecord?.company_name
      || 'Team';

    const vars = {
      name: lead?.name || variables.name || 'there',
      company: clientRecord?.company_name || variables.company || '',
      agent_name: resolvedAgentName,
      lead_company: lead?.company || '',
      ...variables,
      // Force agent_name from resolved value even if variables.agent_name was empty string
      ...(variables.agent_name ? {} : { agent_name: resolvedAgentName })
    };

    // Meeting link auto-resolve
    let meetingLink = variables.meeting_link || activity?.meet_link || '';
    if (!meetingLink && lead_id && (template.include_meeting_link || msgConfig?.email_always_include_meeting_link)) {
      const acts = await base44.entities.Activity.filter({ lead_id, status: 'scheduled' }, '-scheduled_date', 1).catch(() => []);
      if (acts[0]?.meet_link) meetingLink = acts[0].meet_link;
    }
    vars.meeting_link = meetingLink;

    // ── Subject + Body ──
    let subject = interpolate(template.subject, vars);
    let bodyHtml = interpolate(template.body_html, vars);

    // ── Light brand-voice tone pass (applies even when AI mode is off/variables_only) ──
    // Only runs if brand voice is configured AND template isn't already going through full AI rewrite.
    const brandVoiceText = (msgConfig?.email_brand_voice || '').trim();
    const aiMode = template.ai_personalize_mode || 'variables_only';
    if (brandVoiceText && (aiMode === 'off' || aiMode === 'variables_only')) {
      try {
        const tonePrompt = `Apply the brand voice to the email body below WITHOUT changing meaning, facts, structure, links, or HTML tags.

BRAND VOICE: ${brandVoiceText}

RULES:
- Keep ALL HTML tags, links, and {{variable}} placeholders EXACTLY as they are.
- Do NOT add or remove paragraphs, lists, or sentences.
- Only adjust word choice and tone to match the brand voice.
- Keep length within ±10% of original.
- Return JSON { "body_html": "..." }

ORIGINAL BODY:
${bodyHtml}`;
        const toned = await azureLLM(tonePrompt, 'You polish business email tone. Return strict JSON. Never change facts or structure.');
        if (toned?.body_html && toned.body_html.length > 20) bodyHtml = toned.body_html;
      } catch (e) {
        console.warn('[sendEmailFromTemplate] Brand-voice tone pass failed, keeping original:', e.message);
      }
    }

    // ── AI Personalization ──
    if (template.ai_personalize_mode === 'rewrite_body' || template.ai_personalize_mode === 'full_ai') {
      const brandVoice = msgConfig?.email_brand_voice || '';
      const guardrails = template.ai_personalize_instructions || '';
      const transcript = callLog?.transcript?.substring(0, 3000) || '';
      const summary = callLog?.conversation_summary || '';

      const prompt = `Personalize the following email for this lead.

SENDER (the person signing this email): ${resolvedAgentName} from ${clientRecord?.company_name || 'our company'}
LEAD (the recipient): ${lead?.name || 'Customer'} | Company: ${lead?.company || 'N/A'} | Status: ${lead?.status || 'N/A'}
${summary ? `LAST CALL SUMMARY: ${summary}` : ''}
${transcript ? `TRANSCRIPT EXCERPT:\n${transcript}` : ''}

BRAND VOICE GUIDANCE: ${brandVoice || 'Professional, warm, concise.'}
TEMPLATE GUARDRAILS: ${guardrails || 'None specified.'}

ORIGINAL SUBJECT: ${subject}
ORIGINAL BODY (HTML):
${bodyHtml}

MODE: ${template.ai_personalize_mode === 'full_ai' ? 'FULL_AI — rewrite everything keeping the same intent, using the original as a style guide.' : 'REWRITE_BODY — keep subject AND overall structure. Rewrite the body to reference specific transcript context. Preserve all HTML tags, links, and {{variable}} placeholders that remain.'}

RULES:
- Output valid HTML in body_html (use <p>, <br>, <strong>, <ul>, <li>)
- Keep length 100-250 words
- Never invent facts not in the transcript or knowledge
- Address the lead by their first name (${lead?.name?.split(' ')[0] || 'them'}).
- SIGN OFF as "${resolvedAgentName}" (a person), NOT as the company name. Example: "Best regards,<br>${resolvedAgentName}". The company name belongs in the header/footer only, not in the sign-off.
- Return JSON { "subject": "...", "body_html": "..." }`;

      try {
        const ai = await azureLLM(prompt, 'You are an expert business email writer. Return strict JSON.');
        if (ai.subject) subject = interpolate(ai.subject, vars);
        if (ai.body_html) bodyHtml = interpolate(ai.body_html, vars);
      } catch (e) {
        console.warn('[sendEmailFromTemplate] AI personalization failed, falling back to variables_only:', e.message);
      }
    }

    // ── Auto meeting link block ──
    if (meetingLink && !bodyHtml.includes(meetingLink) &&
        (template.include_meeting_link || msgConfig?.email_always_include_meeting_link)) {
      bodyHtml += `<div style="margin-top:20px;padding:16px;background:#ecfdf5;border-left:4px solid #10b981;border-radius:8px;">
        <p style="margin:0 0 6px;font-weight:600;color:#059669;">📅 Your Meeting Link</p>
        <a href="${meetingLink}" style="color:#059669;font-size:14px;word-break:break-all;">${meetingLink}</a>
      </div>`;
    }

    // ── CTA resolved ──
    const ctaLabel = interpolate(template.cta_label || '', vars);
    const ctaUrl = interpolate(template.cta_url || '', vars);

    // ── Brand shell ──
    const finalHtml = buildBrandedShell({
      companyName: clientRecord?.company_name || 'VaaniAI',
      brandColor: msgConfig?.email_brand_color || '#1e3a5f',
      bodyHtml,
      signatureHtml: msgConfig?.email_signature_html || '',
      footerDisclaimer: msgConfig?.email_footer_disclaimer || '',
      ctaLabel, ctaUrl
    });

    // ── Attachments ──
    const allAttachmentIds = [...new Set([...(template.attachment_ids || []), ...extra_attachment_ids])];
    const attachments = [];
    for (const id of allAttachmentIds) {
      const att = await fetchAttachmentAsBase64(base44, id);
      if (att) attachments.push(att);
    }

    // ── CC / BCC ──
    const ccList = (msgConfig?.email_default_cc || '').split(',').map(s => s.trim()).filter(Boolean);
    const bccList = (msgConfig?.email_default_bcc || '').split(',').map(s => s.trim()).filter(Boolean);

    // ── Bulk-campaign unsubscribe (only when sending as part of an EmailCampaign) ──
    let unsubscribeUrl = null;
    let listUnsubscribeHeader = null;
    if (email_campaign_id) {
      // Token: base64url(client_id:email:campaign_id)
      const raw = `${client_id}:${(to_email || '').toLowerCase()}:${email_campaign_id}`;
      const token = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const appOrigin = Deno.env.get('APP_ORIGIN') || 'https://app.vaaniai.io';
      unsubscribeUrl = `${appOrigin}/functions/emailUnsubscribe?token=${token}`;
      listUnsubscribeHeader = `<${unsubscribeUrl}>`;
      // Append visible unsubscribe footer inside the email body (before the brand shell footer)
      const unsubBlock = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;line-height:1.5;">
        You received this email because you're on our list.<br>
        <a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>
      </div>`;
      // Insert before the closing of the white content div in finalHtml
      // Simpler: append to bodyHtml-based shell rebuild not done here, so just inject before </body>
      // We'll re-wrap by appending into finalHtml just before the closing footer div
    }
    let htmlToSend = finalHtml;
    if (email_campaign_id && unsubscribeUrl) {
      const footer = `<div style="max-width:640px;margin:0 auto;padding:8px 20px 20px;text-align:center;font-size:11px;color:#9ca3af;font-family:'Segoe UI',Arial,sans-serif;">
        <a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe from this list</a>
      </div></body>`;
      htmlToSend = finalHtml.replace('</body>', footer);
    }

    // ── Send via the CLIENT's configured email provider (falls back to Vaani ACS only if none) ──
    const sendRes = await base44.functions.invoke('sendViaClientProvider', {
      client_id,
      to: to_email,
      cc: ccList,
      bcc: bccList,
      subject,
      html: htmlToSend,
      from_address: msgConfig?.email_from_address,
      from_name: msgConfig?.email_from_name || clientRecord?.company_name,
      attachments,
      headers: listUnsubscribeHeader ? {
        'List-Unsubscribe': listUnsubscribeHeader,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      } : undefined,
      require_client_provider
    });
    if (!sendRes?.data?.success) {
      throw new Error(sendRes?.data?.error || 'Email dispatch failed');
    }
    const providerUsed = sendRes.data.provider_used;

    // ── Log ──
    await base44.entities.OutreachLog.create({
      client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
      channel: 'email', recipient_email: to_email,
      subject, body: bodyHtml.substring(0, 2000),
      outreach_type, status: 'sent',
      ai_summary: `Template: ${template.name} | Attachments: ${attachments.length} | AI mode: ${template.ai_personalize_mode} | Provider: ${providerUsed}`
    }).catch(e => console.warn('OutreachLog failed:', e.message));

    // Increment usage
    await base44.entities.EmailTemplate.update(template_id, {
      usage_count: (template.usage_count || 0) + 1
    }).catch(() => {});

    return c.json({ data: {
      success: true,
      to: to_email,
      subject,
      attachments_count: attachments.length,
      ai_mode: template.ai_personalize_mode,
      provider_used: providerUsed
    } });
  } catch (error) {
    console.error('[sendEmailFromTemplate] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};