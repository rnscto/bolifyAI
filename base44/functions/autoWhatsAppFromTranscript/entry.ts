import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
async function azureLLM(prompt, systemPrompt, jsonSchema) {
  let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const oIdx = baseUrl.indexOf('/openai/'); if (oIdx > 0) baseUrl = baseUrl.substring(0, oIdx);
  const pIdx = baseUrl.indexOf('/api/projects'); if (pIdx > 0) baseUrl = baseUrl.substring(0, pIdx);
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_completion_tokens: 400,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// ─── Send WhatsApp template INLINE using the service-role client ───
// Previously this delegated to whatsappSendTemplate via functions.invoke, but cross-function
// invocation from a service-role context was rejected (403) at the transport layer, so the
// auto-send silently failed. We now send directly here using the same provider logic
// (meta_cloud / rcs_digital / interakt) + OutreachLog + send_count — no fragile inter-function hop.
function normalizePhone(p) {
  let n = String(p || '').replace(/[^0-9]/g, '');
  if (n.length === 10) n = '91' + n;
  else if (n.length === 11 && n.startsWith('0')) n = '91' + n.slice(1);
  return n;
}

async function sendWhatsAppDirect(svc, { template, recipient, variables, lead, lead_id, call_log_id }) {
  const configs = await svc.entities.ClientMessagingConfig.filter({ client_id: template.client_id });
  if (configs.length === 0) return { ok: false, error: 'No messaging config' };
  const cfg = configs[0];
  if (!['meta_cloud', 'rcs_digital', 'interakt'].includes(cfg.whatsapp_provider)) {
    return { ok: false, error: `Provider ${cfg.whatsapp_provider} not supported for template sends` };
  }

  const interpolate = (val) => {
    if (!lead) return String(val);
    return String(val)
      .replace(/\{\{name\}\}/gi, lead.name || '')
      .replace(/\{\{company\}\}/gi, lead.company || '')
      .replace(/\{\{phone\}\}/gi, lead.phone || '')
      .replace(/\{\{email\}\}/gi, lead.email || '');
  };

  const apiKeyRaw = String(cfg.whatsapp_api_key || '').trim().replace(/^(Bearer|Basic)\s+/i, '');
  const vars = variables || [];
  let ok = false, messageId = null, errMsg = '';
  let recipientPhone = normalizePhone(recipient);

  // ===== INTERAKT BRANCH =====
  if (cfg.whatsapp_provider === 'interakt') {
    let baseHost = String(cfg.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
    if (!baseHost || !/^https?:\/\/api\.interakt\.ai/i.test(baseHost)) baseHost = 'https://api.interakt.ai';
    const url = `${baseHost}/v1/public/message/`;
    let digits = normalizePhone(recipient);
    if (digits.length < 11 || digits.length > 15) return { ok: false, error: `Invalid phone: ${digits}` };
    const countryCode = '+' + digits.slice(0, digits.length - 10);
    const phoneNumber = digits.slice(-10);
    recipientPhone = phoneNumber;
    const tmpl = { name: template.name, languageCode: template.language || 'en' };
    const bodyValues = vars.map(v => interpolate(v));
    if (bodyValues.length > 0) tmpl.bodyValues = bodyValues;
    const hType = (template.header_type || 'NONE').toUpperCase();
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(hType) && template.header_media_url) {
      tmpl.headerValues = [template.header_media_url];
      if (hType === 'DOCUMENT') tmpl.fileName = (template.name || 'document') + '.pdf';
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${apiKeyRaw}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode, phoneNumber, type: 'Template', callbackData: call_log_id || lead_id || '', template: tmpl })
    });
    const rawText = await res.text();
    let data; try { data = JSON.parse(rawText); } catch (_) { data = { raw: rawText }; }
    console.log(`[autoWhatsAppFromTranscript/interakt] ← HTTP ${res.status}: ${rawText.substring(0, 300)}`);
    ok = res.ok && data.result === true;
    messageId = data.id || null;
    errMsg = ok ? '' : (data.message || rawText);
  } else {
    // ===== META CLOUD / RCS DIGITAL BRANCH =====
    const components = [];
    const headerType = (template.header_type || 'NONE').toUpperCase();
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType) && template.header_media_url) {
      const mediaKey = headerType.toLowerCase();
      components.push({ type: 'header', parameters: [{ type: mediaKey, [mediaKey]: { link: template.header_media_url } }] });
    }
    if (vars.length > 0) {
      components.push({ type: 'body', parameters: vars.map(v => ({ type: 'text', text: interpolate(v) })) });
    }
    const cleanRecipient = normalizePhone(recipient);
    recipientPhone = cleanRecipient;
    if (cleanRecipient.length < 11 || cleanRecipient.length > 15) return { ok: false, error: `Invalid phone: ${cleanRecipient}` };
    const phoneNumberId = String(cfg.whatsapp_phone_number_id || '').trim();
    if (!phoneNumberId) return { ok: false, error: 'Phone Number ID not configured' };
    const customHost = String(cfg.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
    const url = cfg.whatsapp_provider === 'rcs_digital'
      ? `${customHost || 'https://rcsdigital.in'}/v23.0/${phoneNumberId}/messages`
      : `${customHost || 'https://graph.facebook.com/v20.0'}/${phoneNumberId}/messages`.replace('/v20.0//', '/v20.0/');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKeyRaw}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to: cleanRecipient,
        type: 'template',
        template: { name: template.name, language: { code: template.language || 'en' }, ...(components.length > 0 ? { components } : {}) }
      })
    });
    const data = await res.json();
    console.log(`[autoWhatsAppFromTranscript/${cfg.whatsapp_provider}] ← HTTP ${res.status}: ${JSON.stringify(data).substring(0, 300)}`);
    ok = res.ok;
    messageId = data.messages?.[0]?.id || null;
    errMsg = ok ? '' : (data.error?.error_user_msg || data.error?.message || JSON.stringify(data));
  }

  // Log outreach + bump send_count (mirrors whatsappSendTemplate behavior)
  try {
    await svc.entities.OutreachLog.create({
      client_id: template.client_id, lead_id: lead_id || lead?.id || null, call_log_id: call_log_id || null,
      channel: 'whatsapp', direction: 'outbound', vendor: cfg.whatsapp_provider,
      vendor_message_id: messageId, template_id: template.id, template_name: template.name,
      recipient_phone: recipientPhone, body: template.body_text || '',
      outreach_type: 'lead_followup', status: ok ? 'sent' : 'failed', error_message: errMsg
    });
  } catch (_) {}
  if (ok) {
    try { await svc.entities.WhatsAppTemplate.update(template.id, { send_count: (template.send_count || 0) + 1 }); } catch (_) {}
  }

  return { ok, message_id: messageId, error: ok ? null : errMsg };
}

// ─── Resolve template variables from a lead, mapping each placeholder correctly ───
// Handles BOTH named tokens ({{name}}/{{company}}/{{phone}}/{{email}}) and numbered
// placeholders ({{1}},{{2}}…). For numbered slots we map slot 1 → lead name, then resolve
// the rest from the lead fields hinted by the template's approved body_examples, falling
// back to the example value the client already registered (never a blind name dump, never empty).
function buildTemplateVariables(template, lead) {
  const body = template.body_text || '';
  const leadName = (lead && lead.name) || 'Sir/Madam';

  // Named tokens: pass through so the downstream interpolate() resolves them from the lead.
  const namedTokens = body.match(/\{\{(name|company|phone|email)\}\}/gi) || [];
  if (namedTokens.length > 0) return namedTokens.map(t => t);

  // Numbered placeholders {{1}}…{{N}} — resolve each slot intelligently.
  const numbers = (body.match(/\{\{\d+\}\}/g) || []).map(m => parseInt(m.replace(/[^\d]/g, ''), 10));
  if (numbers.length === 0) return [];
  const maxSlot = Math.max(...numbers);
  const examples = Array.isArray(template.body_examples) ? template.body_examples : [];

  const resolveSlot = (idx) => {
    // idx is 0-based (slot {{1}} → idx 0)
    if (idx === 0) return leadName; // convention: first variable is the recipient name
    const hint = String(examples[idx] || '').toLowerCase();
    if (lead) {
      if (/company|firm|business|organisation|organization/.test(hint) && lead.company) return lead.company;
      if (/email|mail/.test(hint) && lead.email) return lead.email;
      if (/phone|mobile|number|contact/.test(hint) && lead.phone) return lead.phone;
      if (/name/.test(hint) && lead.name) return lead.name;
    }
    // Fall back to the client-approved example value so the message still reads correctly;
    // never empty (Meta/RCS reject empty params).
    return examples[idx] || leadName;
  };

  const variables = [];
  for (let i = 0; i < maxSlot; i++) variables.push(resolveSlot(i));
  return variables;
}

// MAIN: Analyze transcript → detect intent → send mapped template silently
Deno.serve(async (req) => {
  try {
    // Use request-scoped service role (valid auth) — NOT createClient(asServiceRole) which lacks a token.
    const svc = createClientFromRequest(req).asServiceRole;

    const payload = await req.json();
    const { campaign_id, call_log_id, lead_id, transcript, summary } = payload;

    if (!campaign_id || !transcript || transcript.length < 30) {
      return Response.json({ skipped: 'insufficient_data' });
    }

    // Load campaign + check if auto-send is enabled
    const campaign = await svc.entities.Campaign.get(campaign_id);
    if (!campaign?.whatsapp_auto_send?.enabled) {
      return Response.json({ skipped: 'auto_send_disabled' });
    }

    const intentMap = campaign.whatsapp_auto_send.intent_template_map || {};
    const enabledIntents = Object.keys(intentMap).filter(k => intentMap[k]);
    if (enabledIntents.length === 0) {
      return Response.json({ skipped: 'no_templates_mapped' });
    }

    // Idempotency: don't double-send for the same call_log_id
    if (call_log_id) {
      const existing = await svc.entities.OutreachLog.filter({
        call_log_id, channel: 'whatsapp', client_id: campaign.client_id
      }, '-created_date', 5);
      if (existing.some(o => o.outreach_type === 'lead_followup' && o.status === 'sent')) {
        return Response.json({ skipped: 'already_sent_for_call' });
      }
    }

    // Load lead for variable interpolation + recipient
    let lead = null;
    if (lead_id) {
      try { lead = await svc.entities.Lead.get(lead_id); } catch (_) {}
    }
    if (!lead?.phone) {
      return Response.json({ skipped: 'no_recipient_phone' });
    }

    // === STEP 1: AI intent detection ===
    const detection = await azureLLM(
      `Analyze this sales call transcript and determine if the customer asked for ANY information to be sent on WhatsApp / phone / messaging.

TRANSCRIPT:
${transcript}

SUMMARY:
${summary || 'N/A'}

Detect which of these intents were expressed by the CUSTOMER (not the agent's offers):
- "pricing_details": customer asked for price/cost/pricing info
- "brochure_request": customer asked for brochure/catalog/product info
- "demo_booking": customer agreed to or asked for a demo/trial
- "callback_confirmation": customer confirmed a callback time and wants confirmation
- "location_address": customer asked for office address/directions/location
- "payment_link": customer asked for payment link/how to pay
- "general_details": customer asked for "details" / "information" / "send me info" without specifying what

Only enabled intents to choose from: ${enabledIntents.join(', ')}

Return:
- detected_intent: one of [${enabledIntents.map(i => `"${i}"`).join(', ')}, "none"]
- confidence: "high" | "medium" | "low"
- reason: short explanation
`,
      'You are a sales call intent detector. Always respond in valid JSON.',
      {
        type: 'object',
        properties: {
          detected_intent: { type: 'string' },
          confidence: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    );

    const intent = detection.detected_intent;
    if (!intent || intent === 'none' || !intentMap[intent]) {
      return Response.json({ skipped: 'no_intent_matched', detection });
    }
    if (detection.confidence === 'low') {
      return Response.json({ skipped: 'low_confidence', detection });
    }

    // === STEP 2: Send the mapped template ===
    const templateId = intentMap[intent];
    const template = await svc.entities.WhatsAppTemplate.get(templateId);
    if (!template) {
      return Response.json({ skipped: 'template_missing', intent });
    }
    if (template.status !== 'APPROVED') {
      return Response.json({ skipped: 'template_not_approved', intent, template_status: template.status });
    }

    // Build variables matching the template's body placeholders.
    const variables = buildTemplateVariables(template, lead);

    const sendResult = await sendWhatsAppDirect(svc, {
      template,
      recipient: lead.phone,
      variables,
      lead,
      lead_id: lead.id,
      call_log_id
    });

    console.log(`[autoWhatsAppFromTranscript] intent=${intent} sent=${sendResult.ok} to=${lead.phone}`);

    return Response.json({
      success: true,
      intent,
      confidence: detection.confidence,
      template_name: template.name,
      sent: sendResult.ok,
      message_id: sendResult.message_id,
      error: sendResult.error
    });
  } catch (e) {
    console.error('[autoWhatsAppFromTranscript]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});