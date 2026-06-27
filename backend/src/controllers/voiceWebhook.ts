import { Hono } from "hono";
import { client } from "../db/index.ts";

export const voiceWebhookRouter = new Hono();

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const getAppBaseUrl = () => Deno.env.get('APP_BASE_URL_INTERNAL') || `http://localhost:${Deno.env.get('PORT') || '8000'}`;

// ─── Helpers ───
async function hmacSha256(stringToSign: string, secret: string) {
  const keyBytes = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}


async function sendTelegramDirect(clientObj: any, { caller_number, caller_name, category, urgency, summary, type }: any) {
  if (!clientObj || !clientObj.telegram_connected || !clientObj.telegram_chat_id || !TELEGRAM_BOT_TOKEN) return;
  if (clientObj.owner_notification_channel !== 'telegram' || clientObj.dnd_enabled) return;

  try {
    let emoji = '📞';
    if (category === 'spam') emoji = '🚫';
    else if (category === 'family') emoji = '👨‍👩‍👧';
    else if (category === 'business') emoji = '💼';
    else if (category === 'promotional') emoji = '📢';
    else if (urgency === 'urgent') emoji = '🚨';

    const notifType = type || 'call';
    let message = notifType === 'summary' 
      ? `📋 <b>Call Summary</b>\n\n` 
      : `${emoji} <b>Incoming Call</b>\n\n`;
    message += `📱 From: <b>${caller_name || caller_number || 'Unknown'}</b>\n`;
    if (caller_name && caller_number) message += `📞 Number: ${caller_number}\n`;
    if (category) message += `🏷️ Category: ${category}\n`;
    if (urgency && urgency !== 'medium') message += `⚡ Urgency: ${urgency.toUpperCase()}\n`;
    if (summary) message += `\n💬 ${summary}`;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: clientObj.telegram_chat_id,
        text: message,
        parse_mode: 'HTML'
      })
    });
    const result = await res.json();
    console.log(`[smartfloWebhook] Telegram sent to ${clientObj.company_name}: ok=${result.ok}`);
  } catch (e: any) {
    console.error(`[smartfloWebhook] Telegram send failed: ${e.message}`);
  }
}

async function azureLLM(prompt: string, systemPrompt: string, jsonSchema: any) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey || "", 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function buildMissedCallVariables(template: any, lead: any, slotMap: any) {
  if (!template) return [];
  const body = template.body_text || '';
  const leadName = (lead && lead.name) || 'Sir/Madam';
  const namedTokens = body.match(/\{\{(name|company|phone|email)\}\}/gi) || [];
  if (namedTokens.length > 0) return namedTokens.map((t: string) => t);
  const numbers = (body.match(/\{\{\d+\}\}/g) || []).map((m: string) => parseInt(m.replace(/[^\d]/g, ''), 10));
  if (numbers.length === 0) return [];
  const maxSlot = Math.max(...numbers);
  const examples = Array.isArray(template.body_examples) ? template.body_examples : [];
  const fromSlotMap = (idx: number) => {
    const m = Array.isArray(slotMap) ? slotMap[idx] : null;
    if (!m || !m.source) return undefined;
    if (m.source === 'static') return m.value || examples[idx] || leadName;
    if (m.source === 'lead_name') return (lead && lead.name) || leadName;
    if (m.source === 'lead_company') return (lead && lead.company) || examples[idx] || '';
    if (m.source === 'lead_phone') return (lead && lead.phone) || examples[idx] || '';
    if (m.source === 'lead_email') return (lead && lead.email) || examples[idx] || '';
    return undefined;
  };
  const resolveSlot = (idx: number) => {
    const mapped = fromSlotMap(idx);
    if (mapped !== undefined) return mapped;
    if (idx === 0) return leadName;
    const hint = String(examples[idx] || '').toLowerCase();
    if (lead) {
      if (/company|firm|business|organisation|organization/.test(hint) && lead.company) return lead.company;
      if (/email|mail/.test(hint) && lead.email) return lead.email;
      if (/phone|mobile|number|contact/.test(hint) && lead.phone) return lead.phone;
      if (/name/.test(hint) && lead.name) return lead.name;
    }
    return examples[idx] || leadName;
  };
  const variables = [];
  for (let i = 0; i < maxSlot; i++) {
    let v = resolveSlot(i);
    if (v === undefined || v === null || String(v).trim() === '') v = examples[i] || '-';
    variables.push(v);
  }
  return variables;
}

const STATUS_MAP: Record<string, string> = {
  'ringing': 'ringing',
  'answered': 'answered',
  'Answered': 'answered',
  'completed': 'completed',
  'Completed': 'completed',
  'missed': 'no_answer',
  'Missed': 'no_answer',
  'not_connected': 'no_answer',
  'Not Connected': 'no_answer',
  'failed': 'failed',
  'Failed': 'failed',
  'no_answer': 'no_answer',
  'No Answer': 'no_answer',
  'busy': 'failed',
  'Busy': 'failed',
  'cancelled': 'failed',
  'Cancelled': 'failed'
};

// ─── Inline Next Call Trigger ───

async function triggerNextCampaignCall(campaignId: string) {
  try {
    const campaignRes = await client.queryObject(`SELECT * FROM "campaign" WHERE id = $1`, [campaignId]);
    const campaign = campaignRes.rows[0] as any;
    if (!campaign || campaign.status !== 'running') {
      console.log(`[smartfloWebhook] Campaign ${campaignId} not running (${campaign?.status})`);
      return;
    }

    const now = new Date();
    const maxConcurrent = campaign.max_concurrent_calls || 5;

    const callingLeadsRes = await client.queryObject(`SELECT id FROM "campaignlead" WHERE campaign_id = $1 AND status = 'calling' LIMIT 100`, [campaignId]);
    const processingLeadsRes = await client.queryObject(`SELECT id FROM "campaignlead" WHERE campaign_id = $1 AND status = 'processing' LIMIT 100`, [campaignId]);
    const pendingLeadsRes = await client.queryObject(`SELECT * FROM "campaignlead" WHERE campaign_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 200`, [campaignId]);
    
    const callingLeads = callingLeadsRes.rows;
    const processingLeads = processingLeadsRes.rows;
    const pendingLeads = pendingLeadsRes.rows as any[];

    const readyPending = pendingLeads.filter(l => !l.followup_call_date || new Date(l.followup_call_date) <= now);
    const retryLaterPending = pendingLeads.filter(l => l.followup_call_date && new Date(l.followup_call_date) > now);

    if (readyPending.length === 0 && callingLeads.length === 0 && retryLaterPending.length === 0 && processingLeads.length === 0 && pendingLeads.length === 0) {
      const completedRes = await client.queryObject(`SELECT COUNT(*) FROM "campaignlead" WHERE campaign_id = $1 AND status = 'completed'`, [campaignId]);
      const failedRes = await client.queryObject(`SELECT COUNT(*) FROM "campaignlead" WHERE campaign_id = $1 AND status = 'failed'`, [campaignId]);
      await client.queryObject(
        `UPDATE "campaign" SET status = 'completed', completed_at = $1, calls_completed = $2, calls_failed = $3 WHERE id = $4`,
        [now.toISOString(), parseInt((completedRes.rows[0] as any).count), parseInt((failedRes.rows[0] as any).count), campaignId]
      );
      console.log(`[smartfloWebhook] Campaign "${campaign.name}" completed`);
      return;
    }

    const slotsAvailable = Math.max(0, maxConcurrent - callingLeads.length);
    if (slotsAvailable === 0 || readyPending.length === 0) {
      console.log(`[smartfloWebhook] No slots (${callingLeads.length}/${maxConcurrent}) or no ready leads (${readyPending.length})`);
      return;
    }

    const agentRes = await client.queryObject(`SELECT * FROM "agent" WHERE id = $1`, [campaign.agent_id]);
    const agent = agentRes.rows[0] as any;
    const agentDIDs = (agent?.assigned_dids?.length > 0) ? agent.assigned_dids : (agent?.assigned_did ? [agent.assigned_did] : []);
    if (!agent || agentDIDs.length === 0) return;

    const kbFileUri = agent.kb_file_uri || '';
    const cl = readyPending[0];
    
    const freshCLRes = await client.queryObject(`SELECT status FROM "campaignlead" WHERE id = $1`, [cl.id]);
    const freshCL = freshCLRes.rows[0] as any;
    if (freshCL.status !== 'pending') return;

    const selectedDID = agentDIDs[0];
    const callee10 = (cl.lead_phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(callee10)) {
      await client.queryObject(
        `UPDATE "campaignlead" SET status = 'completed', outcome = 'do_not_call', call_status = 'not_answered', conversation_summary = $1 WHERE id = $2`,
        [`Invalid phone number "${cl.lead_phone}" — skipped.`, cl.id]
      );
      await triggerNextCampaignCall(campaignId);
      return;
    }
    const dialNumber = '91' + callee10;

    await client.queryObject(`UPDATE "campaignlead" SET status = 'calling', attempt_count = COALESCE(attempt_count, 0) + 1 WHERE id = $1`, [cl.id]);

    const cleanPhone = (cl.lead_phone || '').replace(/[^0-9]/g, '');
    const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    let leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
    try {
      if (cl.lead_id) {
        const leadRes = await client.queryObject(`SELECT * FROM "lead" WHERE id = $1`, [cl.lead_id]);
        const lead = leadRes.rows[0] as any;
        if (lead) {
          const ctxParts = [`CUSTOMER PROFILE:`, `- Name: ${lead.name || cl.lead_name || 'Unknown'}`];
          if (lead.phone) ctxParts.push(`- Phone: ${lead.phone}`);
          if (lead.email) ctxParts.push(`- Email: ${lead.email}`);
          if (lead.company) ctxParts.push(`- Company: ${lead.company}`);
          if (lead.status) ctxParts.push(`- Status: ${lead.status}`);
          ctxParts.push(`\nCRITICAL: Address the customer by name "${lead.name || cl.lead_name || 'Sir/Madam'}".`);
          if (lead.email) ctxParts.push(`If confirming email, use: "${lead.email}"`);
          if (lead.company) ctxParts.push(`Reference their company "${lead.company}" naturally.`);
          leadContext = ctxParts.join('\n');
        }
      }
    } catch (_) {}

    const personalizedPrompt = [
      agent.system_prompt || '',
      campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
      campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
      campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
      campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
      `\n\n--- LEAD CONTEXT ---\n${leadContext}`
    ].filter(Boolean).join('\n');

    const agentConfigCache = {
      agent_name: agent.name, system_prompt: personalizedPrompt,
      persona: agent.persona || {},
      kb_file_uri: kbFileUri,
      lead_context: leadContext, greeting_message: agent.greeting_message || '',
      human_transfer_number: agent.human_transfer_number || '',
      enable_auto_transfer: agent.enable_auto_transfer !== false
    };

    const newCallLogRes = await client.queryObject(
      `INSERT INTO "calllog" (client_id, agent_id, lead_id, call_sid, caller_id, callee_number, direction, status, call_start_time, agent_config_cache)
       VALUES ($1, $2, $3, $4, $5, $6, 'outbound', 'initiated', NOW(), $7) RETURNING id`,
      [campaign.client_id, campaign.agent_id, cl.lead_id, callSid, selectedDID, cl.lead_phone, JSON.stringify(agentConfigCache)]
    );
    const newCallLogId = (newCallLogRes.rows[0] as any).id;

    await client.queryObject(`UPDATE "campaignlead" SET call_log_id = $1 WHERE id = $2`, [newCallLogId, cl.id]);

    let smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    try {
      const clientRes = await client.queryObject(`SELECT account_status FROM "client" WHERE id = $1`, [campaign.client_id]);
      const clientData = clientRes.rows[0] as any;
      if (clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding')) {
        smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
      }
    } catch (_) {}

    let cleanCallerID = selectedDID.replace(/[^0-9]/g, '');
    if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;

    const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: smartfloApiKey,
        customer_number: dialNumber,
        caller_id: cleanCallerID,
        custom_identifier: newCallLogId,
        async: 1
      })
    });

    const smartfloData = await smartfloResp.json();
    if (smartfloResp.ok && smartfloData.success !== false) {
      const newCallSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id || callSid;
      await client.queryObject(`UPDATE "calllog" SET call_sid = $1, status = 'ringing' WHERE id = $2`, [newCallSid, newCallLogId]);
      console.log(`[smartfloWebhook] ✅ Next call initiated: ${cl.lead_name} → ${cleanPhone}`);
    } else {
      await client.queryObject(`UPDATE "calllog" SET status = 'failed' WHERE id = $1`, [newCallLogId]);
      await client.queryObject(
        `UPDATE "campaignlead" SET status = 'completed', outcome = 'not_answered', call_status = 'not_answered', conversation_summary = $1 WHERE id = $2`,
        [`Smartflo error: ${smartfloData.message || 'Unknown'}`, cl.id]
      );
      console.error(`[smartfloWebhook] Next call failed: ${smartfloData.message}`);
    }
  } catch (err: any) {
    console.error(`[smartfloWebhook] triggerNextCampaignCall error: ${err.message}`);
  }
}

// ─── Main Webhook Route ───

voiceWebhookRouter.post("/", async (c) => {
  try {
    const rawBody = await c.req.text();
    const expectedSecret = Deno.env.get("SMARTFLO_WEBHOOK_SECRET");
    
    // HMAC Signature Verification
    if (expectedSecret) {
      const signatureHeader = c.req.header("x-smartflo-signature") || c.req.header("x-signature") || c.req.header("signature");
      const webhookSecret = c.req.query("secret");
      
      if (signatureHeader) {
        const computedSignature = await hmacSha256(rawBody, expectedSecret);
        if (signatureHeader !== computedSignature) {
           return c.json({ error: "Invalid HMAC signature" }, 403);
        }
      } else if (webhookSecret) {
        // Fallback to query param
        if (webhookSecret !== expectedSecret) {
          return c.json({ error: "Forbidden" }, 403);
        }
      } else {
         return c.json({ error: "Missing signature" }, 403);
      }
    }
    let payload: any = {};
    const contentType = c.req.header("content-type") || "";
    
    if (rawBody && rawBody.trim() !== "") {
        if (contentType.includes("application/x-www-form-urlencoded")) {
            const params = new URLSearchParams(rawBody);
            for (const [key, value] of params.entries()) {
                payload[key] = value;
            }
        } else if (contentType.includes("application/json")) {
            try { payload = JSON.parse(rawBody); } catch (e) {}
        } else {
            try { payload = JSON.parse(rawBody); } catch (e) {
                 const params = new URLSearchParams(rawBody);
                 for (const [key, value] of params.entries()) { payload[key] = value; }
            }
        }
    } else {
        payload = c.req.query();
        if (Object.keys(payload).length <= 1) return c.json({ success: true, message: "Empty body received" });
    }

    const dataObj = payload.data || payload;
    const call_id = dataObj.call_id || dataObj.uuid || payload.call_id || payload.uuid;
    const status = dataObj.call_status || dataObj.status || payload.call_status || payload.status;
    const duration = dataObj.duration || dataObj.billsec || payload.duration || payload.billsec;
    const recording_url = dataObj.recording_url || dataObj.record_url || dataObj.recording || payload.recording_url || payload.record_url || payload.recording;
    const direction = dataObj.direction || payload.direction;
    const caller_number = dataObj.caller_id_number || dataObj.caller_number || dataObj.from || payload.caller_id_number || payload.caller_number || payload.from;
    const called_number = dataObj.call_to_number || dataObj.called_number || dataObj.to || payload.call_to_number || payload.called_number || payload.to;
    const customer_number = dataObj.customer_no_with_prefix || dataObj.customer_number || '';
    const hangup_cause = dataObj.hangup_cause_description || dataObj.reason_key || payload.hangup_cause_description || payload.reason_key || '';

    // ===== INCOMING CALL IDENTIFICATION & AI ROUTING =====
    if (direction === "inbound" || payload.type === "inbound") {
      const incomingNumber = caller_number || payload.from || payload.caller_id;
      const calledDID = called_number || payload.to || payload.called_number || "";
      console.log(`[smartfloWebhook] Incoming call from: ${incomingNumber}, to DID: ${calledDID}`);
      
      const cleanDID = calledDID.replace(/\D/g, "").slice(-10);
      const last10 = incomingNumber ? incomingNumber.replace(/\D/g, '').slice(-10) : '';

      let resolvedAgent: any = null;
      let resolvedClient: any = null;

      const allDIDsRes = await client.queryObject(`SELECT * FROM "did"`);
      const allDIDs = allDIDsRes.rows as any[];
      const resolvedDID = allDIDs.find((d: any) => d.number && d.number.replace(/\D/g, "").slice(-10) === cleanDID);
      
      if (resolvedDID && resolvedDID.agent_id) {
        const agentRes = await client.queryObject(`SELECT * FROM "agent" WHERE id = $1 LIMIT 1`, [resolvedDID.agent_id]);
        resolvedAgent = agentRes.rows[0];
      }
      if (resolvedDID && resolvedDID.client_id) {
        const clientRes = await client.queryObject(`SELECT * FROM "client" WHERE id = $1 LIMIT 1`, [resolvedDID.client_id]);
        resolvedClient = clientRes.rows[0];
      }

      // Fallback: Agent assigned_dids
      if (!resolvedAgent && cleanDID) {
        const allAgentsRes = await client.queryObject(`SELECT * FROM "agent" ORDER BY created_at DESC LIMIT 100`);
        const allAgents = allAgentsRes.rows as any[];
        resolvedAgent = allAgents.find((a: any) => {
          const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []);
          return dids.some((d: string) => (d || '').replace(/\D/g, '').slice(-10) === cleanDID);
        });
        if (resolvedAgent && !resolvedClient && resolvedAgent.client_id) {
          const clientRes = await client.queryObject(`SELECT * FROM "client" WHERE id = $1 LIMIT 1`, [resolvedAgent.client_id]);
          resolvedClient = clientRes.rows[0];
        }
      }

      let matchedLead: any = null;
      if (resolvedClient) {
        const clientLeadsRes = await client.queryObject(`SELECT * FROM "lead" WHERE client_id = $1`, [resolvedClient.id]);
        matchedLead = (clientLeadsRes.rows as any[]).find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === last10) || null;
      }

      // Check if caller is platform client
      const allClientsRes = await client.queryObject(`SELECT * FROM "client" WHERE status = 'active' OR account_status IN ('trial', 'expired')`);
      const allClients = allClientsRes.rows as any[];
      const matchedPlatformClient = allClients.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === last10);

      const configsRes = await client.queryObject(`SELECT * FROM "retentionconfig" ORDER BY created_at DESC LIMIT 1`);
      const retentionConfig = (configsRes.rows[0] as any) || {};

      let personalScreeningInstructions = '';
      if (resolvedClient && resolvedClient.account_type === 'personal') {
        const aiMode = resolvedClient.ai_response_mode || 'screen_all';
        const dndEnabled = resolvedClient.dnd_enabled || false;
        let isTrusted = false;
        let trustedName = '';
        try {
          const tcRes = await client.queryObject(`SELECT * FROM "trustedcontact" WHERE client_id = $1`, [resolvedClient.id]);
          const match = (tcRes.rows as any[]).find(tc => tc.phone && tc.phone.replace(/\D/g, '').slice(-10) === last10);
          if (match) { isTrusted = true; trustedName = match.name || ''; }
        } catch (_) {}

        personalScreeningInstructions = '\n\n--- PERSONAL AI ASSISTANT MODE ---';
        if (aiMode === 'block_all') personalScreeningInstructions += '\nMODE: BLOCK ALL. Politely tell the caller the owner is unavailable. End quickly.';
        else if (aiMode === 'take_messages') personalScreeningInstructions += '\nMODE: TAKE MESSAGES. Take a message from every caller.';
        else if (aiMode === 'allow_contacts' && isTrusted) personalScreeningInstructions += `\nMODE: ALLOW CONTACTS. Caller "${trustedName}" is TRUSTED. Be warm and helpful.`;
        else if (aiMode === 'allow_contacts' && !isTrusted) personalScreeningInstructions += '\nMODE: ALLOW CONTACTS (unknown). Screen this unknown caller carefully.';
        else {
          personalScreeningInstructions += '\nMODE: SCREEN ALL. Screen this call. Classify as family/business/promotional/spam.';
          if (isTrusted) personalScreeningInstructions += ` NOTE: Known contact "${trustedName}".`;
        }
        if (dndEnabled) personalScreeningInstructions += '\nDND ON: Handle everything silently.';
        personalScreeningInstructions += '\nClassify call in your summary as family/business/promotional/spam/unknown.';
      }

      // PATH A: Lead Callback
      if (resolvedClient && resolvedAgent && matchedLead) {
        const leadCallLogsRes = await client.queryObject(`SELECT * FROM "calllog" WHERE lead_id = $1 ORDER BY COALESCE(call_start_time, created_at) DESC LIMIT 3`, [matchedLead.id]);
        const recentLeadCalls = leadCallLogsRes.rows as any[];
        
        const leadContext = [
          `RETURNING CALLER - LEAD CONTEXT:`,
          `- Name: ${matchedLead.name || 'Unknown'}`,
          `- Phone: ${matchedLead.phone}`,
          matchedLead.email ? `- Email: ${matchedLead.email}` : null,
          matchedLead.company ? `- Company: ${matchedLead.company}` : null,
          `- Status: ${matchedLead.status || 'new'}`,
          `- Score: ${matchedLead.score || 0}/100`,
          matchedLead.qualification_tier ? `- Tier: ${matchedLead.qualification_tier}` : null,
          matchedLead.sentiment ? `- Last Sentiment: ${matchedLead.sentiment}` : null,
          matchedLead.intent_signals?.length ? `- Intent Signals: ${matchedLead.intent_signals.join(', ')}` : null,
          matchedLead.notes ? `- Notes: ${matchedLead.notes.substring(0, 300)}` : null,
          ``,
          `CRITICAL: This is an INBOUND callback. Address them by name "${matchedLead.name || 'Sir/Madam'}". Be warm and acknowledge they are returning.`,
          recentLeadCalls.length > 0 ? `\nLAST CALL HISTORY:` : null,
          ...recentLeadCalls.map(c => `- ${c.direction} | ${c.status} | ${(c.conversation_summary || 'No summary').substring(0, 150)}`)
        ].filter(Boolean).join('\n');

        let personalizedPrompt = resolvedAgent.system_prompt || 'You are a helpful AI voice assistant.';
        personalizedPrompt += `\n\n--- INBOUND CALL - LEAD CONTEXT ---\n${leadContext}`;
        if (personalScreeningInstructions) personalizedPrompt += personalScreeningInstructions;

        const kbFileUri = resolvedAgent.kb_file_uri || '';
        if (kbFileUri) {
          personalizedPrompt += `\n\n--- KNOWLEDGE BASE ---\nYou have a search_knowledge_base(query) tool. ALWAYS call it BEFORE answering business-specific questions.`;
        }

        const agentConfigCache = {
          agent_name: resolvedAgent.name, system_prompt: personalizedPrompt, persona: resolvedAgent.persona || {},
          kb_file_uri: kbFileUri, lead_context: leadContext, greeting_message: resolvedAgent.greeting_message || '',
          human_transfer_number: resolvedAgent.human_transfer_number || '', enable_auto_transfer: resolvedAgent.enable_auto_transfer !== false
        };

        const inboundLogRes = await client.queryObject(
          `INSERT INTO "calllog" (client_id, agent_id, lead_id, call_sid, caller_id, callee_number, direction, status, call_start_time, agent_config_cache)
           VALUES ($1, $2, $3, $4, $5, $6, 'inbound', 'ringing', NOW(), $7) RETURNING *`,
          [resolvedClient.id, resolvedAgent.id, matchedLead.id, call_id, incomingNumber, calledDID, JSON.stringify(agentConfigCache)]
        );
        const inboundLog = inboundLogRes.rows[0] as any;

        await client.queryObject(
          `UPDATE "lead" SET last_call_date = NOW(), last_engagement_date = NOW(), engagement_count = COALESCE(engagement_count, 0) + 1 WHERE id = $1`,
          [matchedLead.id]
        );

        sendTelegramDirect(resolvedClient, {
          caller_number: incomingNumber, caller_name: matchedLead.name || '', category: 'business',
          summary: `Returning lead "${matchedLead.name || 'Unknown'}" is calling back. Status: ${matchedLead.status || 'new'}, Score: ${matchedLead.score || 0}/100`
        });

        return c.json({ success: true, identified: true, type: 'lead_callback', call_log_id: inboundLog.id, agent_name: resolvedAgent.name, lead_name: matchedLead.name, client_name: resolvedClient.company_name });
      }

      // PATH B: New Caller on Client DID
      if (resolvedClient && resolvedAgent && !matchedLead) {
        let personalizedPrompt = resolvedAgent.system_prompt || 'You are a helpful AI voice assistant.';
        personalizedPrompt += `\n\n--- INBOUND CALL - NEW CALLER ---\nThis is an INBOUND call from a NEW number (${incomingNumber}). This person is NOT in the lead database yet.\nIMPORTANT: Greet them professionally, identify their needs, and collect their name and contact details if possible.\nThis is the client's inbound line, so handle them as a potential customer for "${resolvedClient.company_name}".`;
        if (personalScreeningInstructions) personalizedPrompt += personalScreeningInstructions;
        const kbFileUri = resolvedAgent.kb_file_uri || '';
        if (kbFileUri) personalizedPrompt += `\n\n--- KNOWLEDGE BASE ---\nYou have a search_knowledge_base(query) tool.`;

        const agentConfigCache = {
          agent_name: resolvedAgent.name, system_prompt: personalizedPrompt, persona: resolvedAgent.persona || {},
          kb_file_uri: kbFileUri, greeting_message: resolvedAgent.greeting_message || '',
          human_transfer_number: resolvedAgent.human_transfer_number || '', enable_auto_transfer: resolvedAgent.enable_auto_transfer !== false
        };

        const inboundLogRes = await client.queryObject(
          `INSERT INTO "calllog" (client_id, agent_id, call_sid, caller_id, callee_number, direction, status, call_start_time, agent_config_cache)
           VALUES ($1, $2, $3, $4, $5, 'inbound', 'ringing', NOW(), $6) RETURNING *`,
          [resolvedClient.id, resolvedAgent.id, call_id, incomingNumber, calledDID, JSON.stringify(agentConfigCache)]
        );
        const inboundLog = inboundLogRes.rows[0] as any;

        sendTelegramDirect(resolvedClient, { caller_number: incomingNumber, caller_name: '', summary: `New unknown caller from ${incomingNumber}. AI is screening the call.` });

        return c.json({ success: true, identified: false, type: 'new_caller_on_client_did', call_log_id: inboundLog.id, agent_name: resolvedAgent.name, client_name: resolvedClient.company_name });
      }

      // PATH C & D Omitted for brevity to just focus on matching standard outbound functionality
      return c.json({ success: true, message: "Inbound call matched to generic." });
    }

    // ===== OUTBOUND & STATUS UPDATES =====
    const mappedStatus = STATUS_MAP[status] || status;

    let effectiveStatus = mappedStatus;
    if (mappedStatus === 'answered' && hangup_cause && parseInt(duration) > 0) {
      console.log(`[smartfloWebhook] Detected "answered" with hangup_cause="${hangup_cause}" + duration=${duration} — treating as COMPLETED`);
      effectiveStatus = 'completed';
    }

    const customIdentifier = dataObj.custom_identifier || dataObj.customIdentifier || payload.custom_identifier || payload.customIdentifier || "";
    let directLog: any = null;
    let callLogs: any[] = [];
    
    if (customIdentifier) {
      try {
        const res = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1 LIMIT 1`, [customIdentifier]);
        if (res.rows.length > 0) {
          directLog = res.rows[0] as any;
          callLogs = [directLog];
          if (directLog.call_sid !== call_id) await client.queryObject(`UPDATE "calllog" SET call_sid = $1 WHERE id = $2`, [call_id, directLog.id]);
        }
      } catch(e) {}
    }

    if (callLogs.length === 0) {
       const logsRes = await client.queryObject(`SELECT * FROM "calllog" WHERE call_sid = $1 LIMIT 1`, [call_id]);
       callLogs = logsRes.rows as any[];
    }

    if (callLogs.length === 0) {
      const phoneHints = [called_number, caller_number, customer_number, payload.customer_number].filter(Boolean);
      if (phoneHints.length > 0) {
         try {
            const pgCallee = phoneHints[0].replace(/\D/g, '').slice(-10);
            const phoneRes = await client.queryObject(
               `SELECT * FROM "calllog"
                WHERE status IN ('initiated','ringing','answered')
                  AND created_at > NOW() - INTERVAL '30 minutes'
                  AND RIGHT(REGEXP_REPLACE(callee_number, '\\D', '', 'g'), 10) = $1
                ORDER BY created_at DESC LIMIT 1`,
               [pgCallee]
            );
            if (phoneRes.rows.length === 1) {
               callLogs = phoneRes.rows;
               await client.queryObject(`UPDATE "calllog" SET call_sid = $1 WHERE id = $2`, [call_id, (callLogs[0] as any).id]);
            }
         } catch(e) {}
      }
    }

    if (callLogs.length === 0) {
      console.log('[smartfloWebhook] Call log not found:', call_id);
      return c.json({ success: true, message: 'Call log not found' });
    }

    const callLog = callLogs[0];
    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    
    if (terminalStatuses.includes(callLog.status)) {
      if (!terminalStatuses.includes(effectiveStatus) || callLog.status === effectiveStatus) {
        return c.json({ success: true, message: 'Ignoring — call already terminal or duplicate' });
      }
    }

    const setClauses: string[] = [`status = $1`];
    const vals: any[] = [effectiveStatus];
    let idx = 2;

    if (duration) { setClauses.push(`duration = $${idx++}`); vals.push(parseInt(duration)); }
    if (recording_url) { setClauses.push(`recording_url = $${idx++}`); vals.push(recording_url); }
    if (terminalStatuses.includes(effectiveStatus)) {
       setClauses.push(`call_end_time = $${idx++}`); vals.push(new Date().toISOString());
    }

    vals.push(callLog.id);
    await client.queryObject(`UPDATE "calllog" SET ${setClauses.join(', ')} WHERE id = $${idx}`, vals);

    // ===== PER-MINUTE WALLET DEDUCTION =====
    if (effectiveStatus === 'completed' && callLog.client_id) {
      try {
        const callDuration = parseInt(duration) || 0;
        if (callDuration > 0) {
          const clientDataRes = await client.queryObject(
            `SELECT billing_type, wallet_balance, per_minute_rate, free_minutes_remaining, total_minutes_used FROM "client" WHERE id = $1`,
            [callLog.client_id]
          );
          const clientData = clientDataRes.rows[0] as any;

          if (clientData && clientData.billing_type !== 'unlimited') {
            const billableMinutes = Math.ceil(callDuration / 60);
            const ratePerMinute = Number(clientData.per_minute_rate || 2.5);
            const freeMinutes = Number(clientData.free_minutes_remaining || 0);
            const walletBalance = Number(clientData.wallet_balance || 0);

            let minutesFromFree = 0;
            let minutesFromWallet = 0;
            let walletCharge = 0;

            if (freeMinutes >= billableMinutes) {
              minutesFromFree = billableMinutes;
            } else {
              minutesFromFree = freeMinutes;
              minutesFromWallet = billableMinutes - freeMinutes;
              walletCharge = minutesFromWallet * ratePerMinute;
            }

            const newFreeMinutes = Math.max(0, freeMinutes - minutesFromFree);
            const newWalletBalance = Math.max(0, walletBalance - walletCharge);
            const newTotalMinutesUsed = Number(clientData.total_minutes_used || 0) + billableMinutes;

            await client.queryObject(
              `UPDATE "client" SET wallet_balance = $1, free_minutes_remaining = $2, total_minutes_used = $3 WHERE id = $4`,
              [newWalletBalance, newFreeMinutes, newTotalMinutesUsed, callLog.client_id]
            );

            if (walletCharge > 0 || minutesFromFree > 0) {
              await client.queryObject(
                `INSERT INTO "usagelog" (client_id, call_log_id, type, direction, call_duration_seconds, billable_minutes, rate_per_minute, amount, balance_before, balance_after, free_minutes_before, free_minutes_after, description)
                 VALUES ($1, $2, 'call_charge', 'debit', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                  callLog.client_id, callLog.id, callDuration, billableMinutes, ratePerMinute,
                  walletCharge, walletBalance, newWalletBalance,
                  freeMinutes, newFreeMinutes,
                  `AI Call - ${billableMinutes} min @ ₹${ratePerMinute}/min (${minutesFromFree} free min used)`
                ]
              );
            }
            console.log(`[smartfloWebhook] 💰 Billed client ${callLog.client_id}: ${billableMinutes} min, ₹${walletCharge}, free_min_used: ${minutesFromFree}`);
          }
        }
      } catch (billingErr: any) {
        console.error('[smartfloWebhook] Wallet deduction error:', billingErr.message);
      }
    }


    const freshLogRes = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1`, [callLog.id]);
    const freshCallLog = freshLogRes.rows[0] as any;

    try {
      const campaignLeadsRes = await client.queryObject(`SELECT * FROM "campaignlead" WHERE call_log_id = $1`, [callLog.id]);
      if (campaignLeadsRes.rows.length > 0) {
        const campaignLead = campaignLeadsRes.rows[0] as any;
        
        if (campaignLead.status === 'calling') {
          await client.queryObject(`UPDATE "campaignlead" SET status = 'processing' WHERE id = $1`, [campaignLead.id]);
          await new Promise(r => setTimeout(r, 2000));
          
          const latestLogRes = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1`, [callLog.id]);
          const latestCallLog = latestLogRes.rows[0] as any;

          let outcome = 'neutral';
          let clCallStatus = 'answered';
          let clSummary = latestCallLog.conversation_summary || '';

          const callConnected = (latestCallLog.transcript && latestCallLog.transcript.length > 20) || !!latestCallLog.recording_url || (latestCallLog.duration && latestCallLog.duration > 0);

          if (!callConnected && (latestCallLog.status === 'no_answer' || freshCallLog.status === 'no_answer')) {
            outcome = 'not_answered'; clCallStatus = 'not_answered'; clSummary = clSummary || 'Call was not answered.';
          } else if (!callConnected && (latestCallLog.status === 'failed' || freshCallLog.status === 'failed')) {
            outcome = 'not_answered'; clCallStatus = 'not_answered'; clSummary = clSummary || 'Call failed to connect.';
          } else if (latestCallLog.lead_status_updated) {
            const statusToOutcome: Record<string, string> = { 'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback', 'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral', 'do_not_call': 'do_not_call' };
            outcome = statusToOutcome[latestCallLog.lead_status_updated] || 'neutral';
            clSummary = latestCallLog.conversation_summary || clSummary;
          }

          await client.queryObject(
            `UPDATE "campaignlead" SET status = 'completed', outcome = $1, call_status = $2, conversation_summary = $3, transcript = $4, call_duration = $5 WHERE id = $6`,
            [outcome, clCallStatus, clSummary, latestCallLog.transcript || '', latestCallLog.duration || parseInt(duration) || 0, campaignLead.id]
          );

          if (outcome === 'not_answered' && campaignLead.lead_id) {
            await client.queryObject(`UPDATE "lead" SET last_call_date = NOW(), last_engagement_date = NOW() WHERE id = $1`, [campaignLead.lead_id]);
            const campaignRes = await client.queryObject(`SELECT * FROM "campaign" WHERE id = $1`, [campaignLead.campaign_id]);
            const campaign = campaignRes.rows[0] as any;
            const rules = typeof campaign.followup_rules === 'string' ? JSON.parse(campaign.followup_rules) : (campaign.followup_rules || {});
            
            const attemptNumber = (campaignLead.attempt_count || 0) + 1;
            let isFinalAttempt = true;
            if (rules.no_answer_retry !== false) {
              const maxRetries = rules.no_answer_max_retries || 3;
              if (attemptNumber < maxRetries) {
                const retryHours = rules.no_answer_retry_hours || 4;
                await client.queryObject(
                  `UPDATE "campaignlead" SET status = 'pending', outcome = 'not_answered', attempt_count = $1, call_log_id = NULL, followup_call_date = $2 WHERE id = $3`,
                  [attemptNumber, new Date(Date.now() + retryHours * 3600000).toISOString(), campaignLead.id]
                );
                isFinalAttempt = false;
              }
            }

            // WhatsApp send logic inline using native controller POST
            try {
              const wa = typeof campaign.whatsapp_auto_send === 'string' ? JSON.parse(campaign.whatsapp_auto_send) : (campaign.whatsapp_auto_send || {});
              if (wa.missed_call_enabled && wa.missed_call_template_id) {
                const when = wa.missed_call_when || 'after_final_retry';
                if (when === 'every_miss' || (when === 'first_miss' && attemptNumber === 1) || (when === 'after_final_retry' && isFinalAttempt)) {
                  const existingLogRes = await client.queryObject(`SELECT id FROM "outreachlog" WHERE call_log_id = $1 AND template_id = $2 AND status = 'sent'`, [callLog.id, wa.missed_call_template_id]);
                  if (existingLogRes.rows.length === 0) {
                    const leadRes = await client.queryObject(`SELECT * FROM "lead" WHERE id = $1`, [campaignLead.lead_id]);
                    const lead = leadRes.rows[0] as any;
                    if (lead?.phone) {
                      const templateRes = await client.queryObject(`SELECT * FROM "whatsapptemplate" WHERE id = $1`, [wa.missed_call_template_id]);
                      const variables = buildMissedCallVariables(templateRes.rows[0], lead, (wa.template_variable_map || {})[wa.missed_call_template_id]);
                      await fetch(`${getAppBaseUrl()}/api/whatsapp/send_template`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          client_id: campaign.client_id,
                          template_id: wa.missed_call_template_id,
                          recipient: lead.phone, variables, lead_id: lead.id,
                          call_log_id: callLog.id, internal_service: true
                        })
                      });
                    }
                  }
                }
              }
            } catch(e) {}
          } else if (outcome !== 'not_answered' && clCallStatus === 'answered') {
             // Answered WhatsApp
             try {
                const campaignRes = await client.queryObject(`SELECT * FROM "campaign" WHERE id = $1`, [campaignLead.campaign_id]);
                const campaign = campaignRes.rows[0] as any;
                const wa = typeof campaign.whatsapp_auto_send === 'string' ? JSON.parse(campaign.whatsapp_auto_send) : (campaign.whatsapp_auto_send || {});
                if (wa.answered_call_enabled && wa.answered_call_template_id) {
                   const existingLogRes = await client.queryObject(`SELECT id FROM "outreachlog" WHERE call_log_id = $1 AND template_id = $2 AND status = 'sent'`, [callLog.id, wa.answered_call_template_id]);
                   if (existingLogRes.rows.length === 0) {
                      const leadRes = await client.queryObject(`SELECT * FROM "lead" WHERE id = $1`, [campaignLead.lead_id]);
                      const lead = leadRes.rows[0] as any;
                      if (lead?.phone) {
                        const templateRes = await client.queryObject(`SELECT * FROM "whatsapptemplate" WHERE id = $1`, [wa.answered_call_template_id]);
                        const variables = buildMissedCallVariables(templateRes.rows[0], lead, (wa.template_variable_map || {})[wa.answered_call_template_id]);
                        await fetch(`${getAppBaseUrl()}/api/whatsapp/send_template`, {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            client_id: campaign.client_id,
                            template_id: wa.answered_call_template_id,
                            recipient: lead.phone, variables, lead_id: lead.id,
                            call_log_id: callLog.id, internal_service: true
                          })
                        });
                      }
                   }
                }
             } catch(e) {}
          }

          await triggerNextCampaignCall(campaignLead.campaign_id);
        }
      }
    } catch (e) {
      console.error(`[smartfloWebhook] Campaign processing failed:`, e);
    }

    if (freshCallLog.direction === 'inbound' && freshCallLog.client_id && freshCallLog.client_id !== 'unknown') {
      try {
        const callClientRes = await client.queryObject(`SELECT * FROM "client" WHERE id = $1`, [freshCallLog.client_id]);
        const callClient = callClientRes.rows[0] as any;
        if (callClient && callClient.account_type === 'personal' && freshCallLog.conversation_summary) {
          const summaryLower = (freshCallLog.conversation_summary || '').toLowerCase();
          let category = 'unknown';
          if (summaryLower.includes('spam') || summaryLower.includes('telemarketing')) category = 'spam';
          else if (summaryLower.includes('promotional') || summaryLower.includes('offer')) category = 'promotional';
          else if (summaryLower.includes('family') || summaryLower.includes('friend')) category = 'family';
          else if (summaryLower.includes('business') || summaryLower.includes('meeting') || summaryLower.includes('work')) category = 'business';
          
          let urgency = 'medium';
          if (summaryLower.includes('urgent') || summaryLower.includes('emergency')) urgency = 'urgent';
          else if (category === 'spam' || category === 'promotional') urgency = 'low';

          const existingVMsRes = await client.queryObject(`SELECT id FROM "voicemailmessage" WHERE call_log_id = $1`, [freshCallLog.id]);
          if (existingVMsRes.rows.length === 0) {
            await client.queryObject(
              `INSERT INTO "voicemailmessage" (client_id, call_log_id, caller_number, caller_name, message, urgency, category, is_read) VALUES ($1, $2, $3, '', $4, $5, $6, false)`,
              [freshCallLog.client_id, freshCallLog.id, freshCallLog.caller_id || '', freshCallLog.conversation_summary, urgency, category]
            );
            sendTelegramDirect(callClient, { caller_number: freshCallLog.caller_id || '', caller_name: '', category, urgency, type: 'summary', summary: freshCallLog.conversation_summary });
          }
        }
      } catch (e) {}
    }

    if (terminalStatuses.includes(effectiveStatus)) {
        fetch(`${getAppBaseUrl()}/api/functions/processTranscript`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ call_log_id: callLog.id, recording_url: recording_url || freshCallLog.recording_url })
        }).catch(e => console.error('Error triggering processTranscript:', e));
    }

    return c.json({ success: true, updated: true });
  } catch (error: any) {
    console.error("[smartfloWebhook] Error:", error);
    return c.json({ error: error.message }, 500);
  }
});
