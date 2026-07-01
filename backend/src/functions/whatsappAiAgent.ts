import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// whatsappAiAgent — Inbound WhatsApp conversational AI agent.
//
// Invoked (service-role, fire-and-forget) by rcsDigitalWebhook for each
// inbound TEXT message. It:
//   1. Resolves the client + their primary AI agent (system prompt + KB)
//   2. Loads/creates a WhatsAppChatSession (rolling memory + lead link)
//   3. Generates a reply with Azure OpenAI (function-calling enabled)
//   4. Handles two tools: book_demo (→ bookDemoFromCall) and
//      request_call (→ initiateCall) when the customer asks
//   5. Sends the reply back as a WhatsApp SESSION text (24h window is open
//      because the customer just messaged us)
//
// Uses Azure OpenAI DIRECTLY (own keys) — NOT Base44 integration credits.
//
// Payload (from webhook): {
//   client_id, phone_number_id, contact_phone, contact_name,
//   text, message_id
// }
// Returns: { success, reply_sent, action? } or { error }
// ═══════════════════════════════════════════════════════════════════════



const RCS_BASE = 'https://rcsdigital.in';
const META_BASE = 'https://graph.facebook.com';
const RCS_VERSION = 'v23.0';
const META_VERSION = 'v21.0';
const MAX_HISTORY = 20;

function resolveEndpoint(provider, phoneNumberId) {
  if (provider === 'meta_cloud') return `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`;
  return `${RCS_BASE}/${RCS_VERSION}/${phoneNumberId}/messages`;
}

function normalizePhone(to) {
  let n = String(to || '').replace(/[^0-9]/g, '');
  if (n.length === 10) n = '91' + n;
  else if (n.length === 11 && n.startsWith('0')) n = '91' + n.substring(1);
  return n;
}

// Send a free-form session TEXT message (allowed inside the 24h CS window).
async function sendSessionText(config, to, text) {
  const endpoint = resolveEndpoint(config.whatsapp_provider, config.whatsapp_phone_number_id);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizePhone(to),
    type: 'text',
    text: { preview_url: false, body: text }
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.whatsapp_api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn('[whatsappAiAgent] send error', res.status, JSON.stringify(data).slice(0, 300));
    return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
  }
  return { ok: true, message_id: data?.messages?.[0]?.id || null };
}

// Resolve a WhatsApp media id → a temporary download URL, then fetch the bytes.
// Works for RCS Digital (Meta-compatible) and Meta Cloud. Returns { bytes, mime }.
async function fetchWhatsAppMedia(config, mediaId) {
  const isMeta = config.whatsapp_provider === 'meta_cloud';
  const base = isMeta ? `${META_BASE}/${META_VERSION}` : `${RCS_BASE}/${RCS_VERSION}`;
  const metaRes = await fetch(`${base}/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${config.whatsapp_api_key}` }
  });
  if (!metaRes.ok) throw new Error(`media meta ${metaRes.status}`);
  const meta = await metaRes.json();
  const url = meta.url;
  const mime = meta.mime_type || 'application/octet-stream';
  const binRes = await fetch(url, { headers: { 'Authorization': `Bearer ${config.whatsapp_api_key}` } });
  if (!binRes.ok) throw new Error(`media bin ${binRes.status}`);
  const bytes = new Uint8Array(await binRes.arrayBuffer());
  return { bytes, mime };
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

// Transcribe a voice note via Azure OpenAI Whisper (own keys — no Base44 credits).
async function transcribeAudio(bytes, mime) {
  const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01`;
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : 'm4a';
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), `voice.${ext}`);
  const res = await fetch(url, { method: 'POST', headers: { 'api-key': apiKey }, body: fd });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return (await res.json()).text || '';
}

// Describe an image via the vision-capable chat model (own keys).
async function describeImage(base64, mime, caption) {
  const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Briefly describe what this image shows so a support agent understands it.${caption ? ` Customer caption: "${caption}"` : ''}` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ]
      }],
      max_completion_tokens: 300
    })
  });
  if (!res.ok) throw new Error(`vision ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content || '';
}

// Azure OpenAI chat completion with tool-calling.
async function azureChat(messages, tools) {
  const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, tools, tool_choice: 'auto', max_completion_tokens: 600 })
  });
  if (!res.ok) throw new Error(`Azure OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message || {};
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'book_demo',
      description: 'Book a product demo for the customer. Use ONLY after the customer agreed to a specific date AND time, and you have their email. Confirm the slot in your reply text.',
      parameters: {
        type: 'object',
        properties: {
          scheduled_at: { type: 'string', description: 'ISO 8601 UTC datetime. IST → UTC = subtract 5h30m.' },
          lead_email: { type: 'string' },
          lead_name: { type: 'string' },
          focus_area: { type: 'string' },
          language: { type: 'string', enum: ['en', 'hi', 'bilingual'] }
        },
        required: ['scheduled_at', 'lead_email']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_call',
      description: 'Trigger an outbound AI phone call to the customer. Use ONLY when the customer explicitly asks to be called / wants to talk on a call now.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_media',
      description: 'Send a file (brochure, catalog, pricing PDF, image, etc.) from the business media library to the customer on WhatsApp. Use when the customer asks for a document/brochure/catalog/pricing/image that matches an available file. Pick the best matching media_id from the AVAILABLE MEDIA list in the system prompt.',
      parameters: {
        type: 'object',
        properties: {
          media_id: { type: 'string', description: 'The id of the media asset to send (from AVAILABLE MEDIA).' }
        },
        required: ['media_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_lead_info',
      description: "Save the customer's details to their lead record. Call this the moment the customer tells you their name and/or email during onboarding (or whenever they share/correct these details). Always pass whatever you have learned.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Customer's full name (or first name if that's all they gave)." },
          email: { type: 'string', description: "Customer's email address." },
          company: { type: 'string', description: "Customer's company, if mentioned." }
        }
      }
    }
  }
];

// A lead is "known" once we have a real human name (not the placeholder we
// auto-create new contacts with). Used to decide whether to run onboarding.
function isKnownLead(lead) {
  const n = (lead?.name || '').trim().toLowerCase();
  if (!n) return false;
  return n !== 'whatsapp lead' && n !== 'whatsapp chat';
}

export default async function whatsappAiAgent(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const body = await c.req.json();
    const { client_id, contact_phone, contact_name, message_id, media_type, media_id, media_url } = body;
    let text = body.text || '';

    if (!client_id || !contact_phone) {
      return c.json({ data: { error: 'client_id, contact_phone required' } }, 400);
    }

    // WhatsApp config (must be connected to reply)
    const configs = await svc.entities.ClientMessagingConfig.filter({ client_id });
    const config = configs[0];
    if (!config || config.whatsapp_status !== 'connected') {
      return c.json({ data: { error: 'WhatsApp not connected for client' } }, 400);
    }

    // Master on/off switch — when disabled, don't auto-reply (default ON).
    if (config.whatsapp_ai_enabled === false) {
      return c.json({ data: { success: true, skipped: 'ai_disabled' } });
    }

    // ─── Media understanding (image / voice note) — own Azure keys ───
    // Two media sources supported:
    //  - media_id  → Meta/RCS Digital (resolve id → url → bytes)
    //  - media_url → Zixflow (direct downloadable URL, no auth needed)
    const resolveMedia = async () => {
      if (media_url) {
        const r = await fetch(media_url);
        if (!r.ok) throw new Error(`media url ${r.status}`);
        const mime = r.headers.get('content-type') || 'application/octet-stream';
        return { bytes: new Uint8Array(await r.arrayBuffer()), mime };
      }
      return await fetchWhatsAppMedia(config, media_id);
    };
    if (media_type === 'audio' && (media_id || media_url)) {
      try {
        const { bytes, mime } = await resolveMedia();
        const transcript = await transcribeAudio(bytes, mime);
        text = transcript || text;
        console.log(`[whatsappAiAgent] voice transcribed: "${text.slice(0, 80)}"`);
      } catch (e) { console.error('[whatsappAiAgent] audio handling failed:', e.message); }
    } else if (media_type === 'image' && (media_id || media_url)) {
      try {
        const { bytes, mime } = await resolveMedia();
        const desc = await describeImage(bytesToBase64(bytes), mime, text);
        text = `[Customer sent an image] ${desc}${text ? `\nCaption: ${text}` : ''}`;
        console.log(`[whatsappAiAgent] image described: "${desc.slice(0, 80)}"`);
      } catch (e) { console.error('[whatsappAiAgent] image handling failed:', e.message); }
    }

    if (!text) {
      return c.json({ data: { error: 'No text/media content to process' } }, 400);
    }

    // Load or create the chat session (rolling memory)
    const phone = normalizePhone(contact_phone);
    const existing = await svc.entities.WhatsAppChatSession.filter({ client_id, contact_phone: phone });
    let session = existing[0] || null;

    // Idempotency: skip if we've already processed this exact inbound message
    if (session && message_id && session.last_inbound_message_id === message_id) {
      return c.json({ data: { success: true, skipped: 'duplicate' } });
    }

    // Resolve the agent (system prompt + KB) for persona/context.
    // Prefer the agent explicitly assigned to WhatsApp chats; else primary/active.
    const agents = await svc.entities.Agent.filter({ client_id });
    const agent = (config.whatsapp_agent_id && agents.find(a => a.id === config.whatsapp_agent_id))
      || agents.find(a => a.is_primary)
      || agents.find(a => a.status === 'active')
      || agents[0] || null;

    // Load the client's active media library (brochures/pricing/etc.) so the AI
    // can send the right file when a customer asks for one.
    const mediaAssets = (await svc.entities.MediaAsset.filter({ client_id, is_active: true }).catch(() => [])) || [];

    // Resolve or create a Lead for this contact (needed for demo + call tools).
    // We keep the FULL lead object (not just the id) so the AI can greet by
    // name and decide whether onboarding (ask name+email) is needed.
    let lead = null;
    if (session?.lead_id) {
      lead = await svc.entities.Lead.get(session.lead_id).catch(() => null);
    }
    if (!lead) {
      const last10 = phone.slice(-10);
      const leadMatches = await svc.entities.Lead.filter({ client_id });
      lead = (leadMatches || []).find(l => String(l.phone || '').replace(/[^0-9]/g, '').slice(-10) === last10) || null;
      if (!lead) {
        lead = await svc.entities.Lead.create({
          client_id, phone: phone,
          // Use the WhatsApp profile name if the provider sent one, else a
          // placeholder that flags this lead as "needs onboarding".
          name: contact_name || 'WhatsApp Lead',
          source: 'whatsapp_chat', status: 'new'
        }).catch(() => null);
      }
    }
    const leadId = lead?.id || null;
    const leadKnown = isKnownLead(lead);

    // Build KB snippet (small — keep prompt lean)
    let kbText = '';
    if (agent?.knowledge_base_ids?.length) {
      const docs = await Promise.all(agent.knowledge_base_ids.slice(0, 5).map(id =>
        svc.entities.KnowledgeBase.get(id).catch(() => null)));
      kbText = docs.filter(d => d?.content).map(d => `[${d.title}]\n${d.content}`).join('\n\n---\n\n').slice(0, 6000);
    }

    const history = Array.isArray(session?.messages) ? session.messages.slice(-MAX_HISTORY) : [];
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

    // Only offer send_media when the client actually has files to send.
    const availableTools = mediaAssets.length
      ? TOOLS
      : TOOLS.filter(t => t.function.name !== 'send_media');
    const mediaList = mediaAssets.length
      ? mediaAssets.map(m => `- id:${m.id} | ${m.name} (intent: ${m.intent})${m.description ? ` — ${m.description}` : ''}`).join('\n')
      : '';

    // ─── Lead context + onboarding state ───
    const leadFirstName = (lead?.name || '').trim().split(/\s+/)[0] || '';
    const leadContext = leadKnown
      ? `KNOWN CUSTOMER (already in CRM):
- Name: ${lead.name}${leadFirstName ? ` (first name: ${leadFirstName})` : ''}
- Email: ${lead.email || 'not on file'}
- Company: ${lead.company || 'not on file'}
- Status: ${lead.status || 'new'}
Greet them BY THEIR FIRST NAME ("${leadFirstName}") right away. Never use placeholders like {{lead_name}} or "there".`
      : `UNKNOWN CONTACT (not yet in CRM — needs onboarding):
We only have their phone number. You do NOT know their name or email yet.`;

    const onboardingEnabled = config.whatsapp_ai_onboarding_enabled !== false; // default ON
    const onboardingRule = leadKnown
      ? (lead.email
          ? '- This customer is fully known — no need to ask for name/email again.'
          : '- We have their name but NOT their email. When it becomes relevant (demo/follow-up), politely ask for their email and call update_lead_info to save it.')
      : onboardingEnabled
        ? `- ONBOARDING (do this first for this unknown contact): warmly greet, briefly introduce the business, then ask for their FIRST NAME. After they share it, call update_lead_info immediately. Then ask for their EMAIL and call update_lead_info again. Once you have at least their first name, greet them by it and continue helping. Ask ONE thing at a time — don't dump multiple questions.`
        : `- This is an unknown contact, but onboarding is OFF — just help them with their query directly. Don't push for their name/email, but if they volunteer these details, call update_lead_info to save them.`;

    const systemPrompt = `You are a helpful WhatsApp chat assistant for this business.
${agent?.system_prompt ? `\nBUSINESS PERSONA & INSTRUCTIONS:\n${agent.system_prompt.slice(0, 1500)}\n` : ''}
CONTACT CONTEXT:
${leadContext}

RULES:
- Reply in the SAME language the customer uses (English / Hindi / Hinglish). Keep replies short and WhatsApp-friendly.
${onboardingRule}
- Whenever the customer shares or corrects their name, email, or company, call update_lead_info to save it.
- Answer product/pricing/feature questions ONLY from the knowledge base below. If it's not there, say you'll have someone follow up — never invent facts.
- If the customer wants a demo: collect a date+time and their email, confirm the slot, THEN call book_demo.
- If the customer explicitly asks to be called / wants a phone call now: call request_call.
- If the customer asks for a brochure / catalog / pricing sheet / document / image that matches an item in AVAILABLE MEDIA, call send_media with the best matching id. Only send a file if a relevant one exists — never promise a file that's not listed.
- Be warm and concise. Current time: ${nowIST} IST.
${mediaList ? `\nAVAILABLE MEDIA (files you can send via send_media):\n${mediaList}` : ''}
${kbText ? `\nKNOWLEDGE BASE:\n${kbText}` : ''}`;

    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.role, content: m.text })),
      { role: 'user', content: text }
    ];

    let aiMsg = await azureChat(chatMessages, availableTools);
    let action = null;
    let replyText = aiMsg.content || '';

    // Handle a tool call (single round — then ask the model to phrase the reply)
    const toolCall = aiMsg.tool_calls?.[0];
    if (toolCall) {
      const fnName = toolCall.function?.name;
      const args = JSON.parse(toolCall.function?.arguments || '{}');
      let toolResult = {};

      if (fnName === 'book_demo') {
        // Book a demo for the CLIENT's lead on the CLIENT's Google Calendar with a
        // Google Meet link — then send that link to the lead on WhatsApp + email.
        // (This is NOT Vaani's internal sales-demo system.)
        try {
          // Save email/name to the lead if newly provided
          const patch = {};
          if (args.lead_email && args.lead_email.trim()) patch.email = args.lead_email.trim();
          if (args.lead_name && args.lead_name.trim() && !leadKnown) patch.name = args.lead_name.trim();
          if (leadId && Object.keys(patch).length) {
            await svc.entities.Lead.update(leadId, patch).catch(() => {});
            lead = { ...(lead || {}), ...patch };
          }

          // Resolve client owner email for activity assignment (calendar sync)
          let ownerEmail = '';
          try {
            const cl = await svc.entities.Client.get(client_id).catch(() => null);
            ownerEmail = cl?.email || '';
          } catch (_) {}

          // Create the demo Activity (type 'demo' → gets a Google Meet link)
          const demoActivity = await svc.entities.Activity.create({
            client_id,
            lead_id: leadId || null,
            type: 'demo',
            title: `Demo with ${lead?.name || contact_name || 'Lead'}`,
            description: `Demo requested via WhatsApp.${args.focus_area ? `\nFocus: ${args.focus_area}` : ''}`,
            scheduled_date: args.scheduled_at,
            status: 'scheduled',
            priority: 'high',
            auto_created: true,
            assigned_to: ownerEmail || '',
            duration_minutes: 30
          });

          // Generate the Google Meet link (await so link is saved before we send it)
          const calRes = await svc.functions.invoke('createCalendarEvent', { activity_id: demoActivity.id })
            .catch(e => ({ data: { error: e.message } }));
          const meetLink = calRes?.data?.meet_link || '';

          // Send the Meet link on WhatsApp (+ email if available)
          svc.functions.invoke('sendMeetingLinkWhatsApp', { activity_id: demoActivity.id })
            .catch(e => console.error('[whatsappAiAgent] sendMeetingLinkWhatsApp failed:', e.message));
          if (lead?.email) {
            svc.functions.invoke('sendMeetingLinkEmail', { lead_id: leadId, email_activity_id: demoActivity.id })
              .catch(e => console.error('[whatsappAiAgent] sendMeetingLinkEmail failed:', e.message));
          }

          toolResult = calRes?.data?.error
            ? { error: calRes.data.error }
            : { success: true, activity_id: demoActivity.id, meet_link: meetLink, scheduled_at: args.scheduled_at };
          action = toolResult.error ? null : 'demo_booked';
        } catch (e) {
          toolResult = { error: e.message };
        }
      } else if (fnName === 'request_call') {
        if (leadId && agent?.id) {
          const r = await svc.functions.invoke('initiateCall', {
            lead_id: leadId, agent_id: agent.id, phone_number: phone, service_call: true
          }).catch(e => ({ data: { error: e.message } }));
          toolResult = r?.data || {};
          action = toolResult.success ? 'call_requested' : null;
        } else {
          toolResult = { error: 'No agent/lead available to place the call' };
        }
      } else if (fnName === 'send_media') {
        const wanted = mediaAssets.find(m => m.id === args.media_id);
        if (wanted) {
          const r = await svc.functions.invoke('sendWhatsAppMedia', {
            client_id, to: phone, media_asset_id: wanted.id,
            lead_id: leadId, outreach_type: 'lead_followup'
          }).catch(e => ({ data: { error: e.message } }));
          toolResult = r?.data || {};
          toolResult.asset_name = wanted.name;
        } else {
          toolResult = { error: 'Requested media not found in library' };
        }
      } else if (fnName === 'update_lead_info') {
        const patch = {};
        // Don't overwrite a real name with the placeholder; accept any new value.
        if (args.name && args.name.trim()) patch.name = args.name.trim();
        if (args.email && args.email.trim()) patch.email = args.email.trim();
        if (args.company && args.company.trim()) patch.company = args.company.trim();
        if (leadId && Object.keys(patch).length) {
          await svc.entities.Lead.update(leadId, patch).catch(() => {});
          lead = { ...(lead || {}), ...patch }; // keep local context fresh
          toolResult = { success: true, saved: patch };
        } else {
          toolResult = { error: 'Nothing to save' };
        }
      }

      // Second pass: let the model phrase a natural confirmation using the result.
      // We pass an explicit instruction so a FAILED action never gets a fake
      // "Done!" confirmation — the customer gets an honest, graceful message.
      const ok = !toolResult.error && toolResult.success !== false;
      let phrasingHint;
      if (fnName === 'book_demo') {
        phrasingHint = ok
          ? `The demo was scheduled successfully and a Google Meet link${toolResult.meet_link ? ` (${toolResult.meet_link})` : ''} is being sent to them on WhatsApp${lead?.email ? ' and email' : ''}. Confirm the date/time warmly and tell them the join link is on its way here on WhatsApp.`
          : `The demo booking FAILED (${toolResult.error || 'unknown error'}). Apologize briefly and offer to have the team follow up. Do NOT claim it was booked.`;
      } else if (fnName === 'send_media') {
        phrasingHint = ok
          ? `The file "${toolResult.asset_name || 'document'}" was just sent to the customer on WhatsApp. Tell them it's on its way and ask if they need anything else.`
          : `The file could NOT be sent (${toolResult.error || 'unknown error'}). Apologize and offer to have someone share it. Do NOT claim it was sent.`;
      } else if (fnName === 'update_lead_info') {
        const savedName = (toolResult.saved?.name || lead?.name || '').trim().split(/\s+/)[0];
        phrasingHint = ok
          ? `Saved their details. ${savedName ? `Greet them warmly by first name "${savedName}".` : ''} If you still need their email (and don't have it yet), ask for it next; otherwise continue helping with their query. Do NOT repeat a question they've already answered.`
          : `Could not save their details — just continue the conversation naturally and don't mention any error.`;
      } else {
        phrasingHint = ok
          ? `An AI call to the customer has been started — tell them they'll receive a call shortly.`
          : `The call could NOT be placed right now (${toolResult.error || 'unknown error'}). Apologize and offer to have someone reach out. Do NOT claim a call is coming.`;
      }
      const followup = await azureChat([
        ...chatMessages,
        { role: 'assistant', content: null, tool_calls: aiMsg.tool_calls },
        { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) },
        { role: 'system', content: `Now write the WhatsApp reply to the customer. ${phrasingHint} Keep it short and friendly.` }
      ], availableTools);
      replyText = followup.content || replyText || (ok ? 'All set! ✅' : 'Sorry, something went wrong — our team will follow up shortly.');
    }

    if (!replyText) replyText = "Thanks for your message! How can I help you today?";

    // Send the reply
    const sent = await sendSessionText(config, phone, replyText);

    // Persist session memory
    const newMessages = [
      ...history,
      { role: 'user', text, ts: new Date().toISOString() },
      { role: 'assistant', text: replyText, ts: new Date().toISOString() }
    ].slice(-MAX_HISTORY);

    const sessionData = {
      client_id, contact_phone: phone, lead_id: leadId,
      contact_name: (isKnownLead(lead) ? lead.name : null) || contact_name || session?.contact_name || null,
      messages: newMessages,
      last_inbound_message_id: message_id || null,
      status: action === 'demo_booked' ? 'demo_booked' : action === 'call_requested' ? 'call_requested' : 'active',
      last_activity_at: new Date().toISOString()
    };
    if (session) await svc.entities.WhatsAppChatSession.update(session.id, sessionData).catch(() => {});
    else await svc.entities.WhatsAppChatSession.create(sessionData).catch(() => {});

    // Log outbound reply
    await svc.entities.OutreachLog.create({
      client_id, lead_id: leadId, channel: 'whatsapp', recipient_phone: phone,
      body: replyText, outreach_type: 'lead_followup',
      status: sent.ok ? 'sent' : 'failed', error_message: sent.ok ? null : sent.error
    }).catch(() => {});

    return c.json({ data: { success: true, reply_sent: sent.ok, action, reply: replyText } });
  } catch (error) {
    console.error('[whatsappAiAgent] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};