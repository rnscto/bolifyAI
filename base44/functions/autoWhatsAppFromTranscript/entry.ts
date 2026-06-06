import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.31';

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

// ─── Send WhatsApp template directly via provider API (no SDK auth needed for service role) ───
async function sendWhatsAppDirect(svc, { template_id, recipient, variables, lead_id, call_log_id }) {
  const template = await svc.entities.WhatsAppTemplate.get(template_id);
  if (!template) throw new Error('Template not found');
  if (template.status !== 'APPROVED') throw new Error(`Template is ${template.status}, not APPROVED`);

  const configs = await svc.entities.ClientMessagingConfig.filter({ client_id: template.client_id });
  if (configs.length === 0) throw new Error('No messaging config');
  const cfg = configs[0];

  if (!['meta_cloud', 'rcs_digital'].includes(cfg.whatsapp_provider)) {
    throw new Error('Provider not supported for template sends');
  }

  // Phone normalization
  let cleanRecipient = String(recipient).replace(/[^0-9]/g, '');
  if (cleanRecipient.length === 10) cleanRecipient = '91' + cleanRecipient;
  else if (cleanRecipient.length === 11 && cleanRecipient.startsWith('0')) cleanRecipient = '91' + cleanRecipient.slice(1);

  // Build components
  const components = [];
  const vars = variables || [];
  if (vars.length > 0) {
    components.push({
      type: 'body',
      parameters: vars.map(v => ({ type: 'text', text: String(v || '') }))
    });
  }

  const baseUrl = cfg.whatsapp_provider === 'rcs_digital'
    ? `https://rcsdigital.in/v23.0/${cfg.whatsapp_phone_number_id}/messages`
    : `https://graph.facebook.com/v20.0/${cfg.whatsapp_phone_number_id}/messages`;

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.whatsapp_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanRecipient,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language || 'en' },
        ...(components.length > 0 ? { components } : {})
      }
    })
  });

  const data = await res.json();
  const messageId = data.messages?.[0]?.id;

  // Log outreach
  try {
    await svc.entities.OutreachLog.create({
      client_id: template.client_id,
      lead_id: lead_id || null,
      call_log_id: call_log_id || null,
      channel: 'whatsapp',
      direction: 'outbound',
      vendor: cfg.whatsapp_provider,
      vendor_message_id: messageId || null,
      template_id,
      template_name: template.name,
      recipient_phone: cleanRecipient,
      body: template.body_text || '',
      outreach_type: 'lead_followup',
      status: res.ok ? 'sent' : 'failed',
      error_message: res.ok ? '' : (data.error?.error_user_msg || data.error?.message || JSON.stringify(data))
    });
  } catch (_) {}

  if (res.ok) {
    try {
      await svc.entities.WhatsAppTemplate.update(template_id, {
        send_count: (template.send_count || 0) + 1
      });
    } catch (_) {}
  }

  return { ok: res.ok, message_id: messageId, error: res.ok ? null : (data.error?.message || 'Send failed') };
}

// MAIN: Analyze transcript → detect intent → send mapped template silently
Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = createClient({ appId, asServiceRole: true });

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

    // Auto-fill variables: count {{N}} placeholders, fill with lead.name then generic values
    const placeholderCount = (template.body_text || '').match(/\{\{\d+\}\}/g)?.length || 0;
    const variables = [];
    for (let i = 0; i < placeholderCount; i++) {
      if (i === 0) variables.push(lead.name || 'Sir/Madam');
      else variables.push('');
    }

    const sendResult = await sendWhatsAppDirect(svc, {
      template_id: templateId,
      recipient: lead.phone,
      variables,
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