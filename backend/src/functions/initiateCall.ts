import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";



// ─── PG-PRIMARY CallLog helpers (manual single calls) ───
// Manual call logs are written directly to the 'calllog' entity table — the same
// table the webhook and ORM both read from. Using the shared pool (client) avoids
// per-call connection overhead and ensures all queries see the same transaction.
function genUuid() {
  try { return crypto.randomUUID(); }
  catch (_) { return 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12); }
}
async function pgInsertCallLog(row) {
  const nowIso = new Date().toISOString();
  await client.queryObject(
    `INSERT INTO "calllog"
       (id, client_id, agent_id, lead_id, call_sid, caller_id, callee_number,
        direction, status, agent_config_cache, conversation_summary, call_start_time)
     VALUES
       ($1::uuid, $2, $3, $4, $5, $6, $7, 'outbound', $8, $9::jsonb, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      row.id, row.client_id, row.agent_id, row.lead_id || null, row.call_sid,
      row.caller_id, row.callee_number, row.status || 'initiated',
      JSON.stringify(row.agent_config_cache || {}), row.conversation_summary || '',
      nowIso
    ]
  );
}
async function pgUpdateCallLogStatus(id, callSid, status) {
  if (callSid) {
    await client.queryObject(
      `UPDATE "calllog" SET call_sid = $1, status = $2, updated_at = now() WHERE id = $3`,
      [callSid, status, id]
    );
  } else {
    await client.queryObject(
      `UPDATE "calllog" SET status = $1, updated_at = now() WHERE id = $2`,
      [status, id]
    );
  }
}

// ─── Last finalized call for a lead — reads from 'calllog' (source of truth) ───
// Reads the most recent completed/answered call for a lead so the agent
// knows about prior conversations. Returns the most recent call row or null.
async function pgGetLastCallForLead(leadId) {
  if (!leadId) return null;
  try {
    const res = await client.queryObject(
      `SELECT call_start_time, created_at, conversation_summary, status
       FROM "calllog"
       WHERE lead_id = $1
         AND status IN ('completed','answered')
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [leadId]
    );
    const row = res.rows?.[0] as any;
    if (!row) return null;
    // Normalize field names for callers that use call_start_time or created_date
    return { ...row, created_date: row.created_at };
  } catch (e) {
    console.error(`[initiateCall] pgGetLastCallForLead failed: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// INLINED buildAgentContext logic (Phase A Tier 1.1)
// Saves ~100-150ms by eliminating the function-to-function HTTP roundtrip.
// Logic is identical to functions/buildAgentContext — kept inline here
// so initiateCall returns faster. The standalone buildAgentContext fn
// is still kept for streamAudio's inbound path and other callers.
// ═══════════════════════════════════════════════════════════════════
const CORE_PROMPT_CAP = 1500;

function buildLeadSnapshot(lead, lastCall) {
  if (!lead) return '';
  const parts = [];
  parts.push(`Name: ${lead.name || 'Unknown'}`);
  if (lead.phone) parts.push(`Phone: ${lead.phone}`);
  if (lead.email) parts.push(`Email: ${lead.email}`);
  if (lead.company) parts.push(`Company: ${lead.company}`);
  if (lead.status) parts.push(`Status: ${lead.status}`);
  if (lead.score) parts.push(`Score: ${lead.score}/100`);
  if (lead.qualification_tier) parts.push(`Tier: ${lead.qualification_tier}`);
  if (lead.sentiment) parts.push(`Sentiment: ${lead.sentiment.replace(/_/g, ' ')}`);
  if (lastCall) {
    const daysAgo = lastCall.call_start_time
      ? Math.max(0, Math.round((Date.now() - new Date(lastCall.call_start_time).getTime()) / 86400000))
      : null;
    const ago = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d ago' : daysAgo ? `${daysAgo}d ago` : 'recent';
    const sum = (lastCall.conversation_summary || '').split('\n')[0].substring(0, 160);
    if (sum) parts.push(`Last call (${ago}): ${sum}`);
  }
  return parts.join(' | ');
}

function clipPrompt(prompt, cap = CORE_PROMPT_CAP) {
  if (!prompt) return '';
  if (prompt.length <= cap) return prompt;
  const head = prompt.substring(0, cap);
  const lastBreak = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('. '));
  const trim = lastBreak > cap * 0.6 ? head.substring(0, lastBreak) : head;
  return trim.trim() + '\n\n[Detailed info available via search_knowledge_base tool]';
}

function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function ensureKBFileInline(base44, agent) {
  const kbIds = agent.knowledge_base_ids || [];
  if (kbIds.length === 0) return '';
  // Cheap KB doc fetch to detect content change
  const kbDocs = (await Promise.all(
    kbIds.map(id => base44.asServiceRole.entities.KnowledgeBase.get(id).catch(() => null))
  )).filter(d => d && d.content);
  if (kbDocs.length === 0) return agent.kb_file_uri || '';

  const concatenated = kbDocs.map(d => `[${d.title || 'Untitled'}]\n${d.content}`).join('\n\n---\n\n');
  const currentHash = djb2Hash(concatenated);
  const hasAzureUri = agent.kb_file_uri && agent.kb_file_uri.startsWith('azblob://');
  const hashMatches = agent.kb_file_hash === currentHash;

  if (hasAzureUri && hashMatches) return agent.kb_file_uri;

  // Content changed or missing — rebuild in background, return stale URI for current call
  try {
    base44.asServiceRole.functions.invoke('uploadKBToStorage', { agent_id: agent.id })
      .then(() => console.log(`[initiateCall] Background KB rebuild for agent=${agent.id}`))
      .catch(e => console.error(`[initiateCall] KB rebuild failed: ${e.message}`));
  } catch (_) {}
  return agent.kb_file_uri || '';
}

// ── INDUSTRY BLUEPRINT resolve (shared with buildAgentContext logic) ──
// Resolves the client's blueprint by key or alias. Non-blocking, off the
// live-audio loop — one cheap read folded into config build.
async function resolveBlueprintInline(base44, client) {
  if (!client) return null;
  try {
    const bpKey = client.blueprint_key
      || (client.industry
          ? String(client.industry).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
          : null);
    if (!bpKey) return null;
    let bps = await base44.asServiceRole.entities.IndustryBlueprint.filter({ industry_key: bpKey, status: 'active' }).catch(() => []);
    if (!bps || bps.length === 0) {
      const rawLabel = String(client.industry || '').trim().toLowerCase();
      const all = await base44.asServiceRole.entities.IndustryBlueprint.filter({ status: 'active' }).catch(() => []);
      bps = (all || []).filter((b) => (b.aliases || []).some((a) => String(a).trim().toLowerCase() === rawLabel));
    }
    return bps?.[0] || null;
  } catch (e) {
    console.error(`[initiateCall] blueprint resolve failed: ${e.message}`);
    return null;
  }
}

async function buildSlimCacheInline(base44, { agent, lead, extraInstructions, campaignId }) {
  const client = agent.client_id
    ? await base44.asServiceRole.entities.Client.get(agent.client_id).catch(() => null)
    : null;
  const blueprint = await resolveBlueprintInline(base44, client);

  // Parallel: marketplace integrations + last call (POSTGRES) + KB resolution
  const [marketplaceInts, lastCall, kbFileUri] = await Promise.all([
    agent.client_id
      ? base44.asServiceRole.entities.MarketplaceIntegration.filter({
          client_id: agent.client_id, status: 'active'
        }).catch(() => [])
      : Promise.resolve([]),
    // Read the lead's last finalized call from Postgres (source of truth) —
    // finalized calls are no longer mirrored to Base44 CallLog.
    pgGetLastCallForLead(lead?.id),
    ensureKBFileInline(base44, agent)
  ]);

  const hasShopify = marketplaceInts.some(i => i.platform === 'shopify');
  const hasUniCommerce = marketplaceInts.some(i => i.platform === 'unicommerce');
  const hasKnowledgeBase = !!kbFileUri || !!(agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0);
  const leadSnapshot = lead ? buildLeadSnapshot(lead, lastCall) : '';

  let corePrompt = clipPrompt(agent.system_prompt || 'You are a helpful AI voice assistant.');
  if (leadSnapshot) {
    corePrompt += `\n\n--- LEAD SNAPSHOT ---\n${leadSnapshot}`;
    corePrompt += `\nCRITICAL: Address the customer by name "${lead.name || 'Sir/Madam'}" during the conversation.`;
    if (lastCall) {
      corePrompt += `\nIf the customer references past conversations or says "remember when...", CALL the get_call_history tool to fetch details.`;
    }
  }
  if (extraInstructions) {
    corePrompt += `\n\n--- ADDITIONAL INSTRUCTIONS ---\n${extraInstructions}`;
  }

  // ── BLUEPRINT GOAL + TARGET FIELDS (outbound lead calls) ──
  if (blueprint) {
    const goal = blueprint.default_agent_goal;
    const fieldLabels = (blueprint.custom_fields || []).map((f) => f.label).filter(Boolean).slice(0, 8);
    if (goal || fieldLabels.length) {
      corePrompt += `\n\n--- ${(blueprint.label || 'INDUSTRY').toUpperCase()} OBJECTIVE ---`;
      if (goal) corePrompt += `\nPrimary goal of this call: ${goal}.`;
      if (fieldLabels.length) {
        corePrompt += `\nWhere it fits naturally, try to learn: ${fieldLabels.join(', ')}. Do NOT interrogate — weave these into the conversation only when relevant.`;
      }
    }
  }

  // WhatsApp delivery options for campaigns
  if (campaignId) {
    try {
      const mappings = await base44.asServiceRole.entities.CampaignTemplateMapping.filter({
        campaign_id: campaignId, enabled: true
      }).catch(() => []);
      const aiMappings = mappings.filter(m =>
        m.template_id && (m.trigger_condition === 'ai_requested' || !m.trigger_condition)
      );
      if (aiMappings.length > 0) {
        const intentList = aiMappings.map(m => {
          const label = m.intent === 'custom' ? (m.custom_intent_label || 'custom') : m.intent;
          return `  - ${label}`;
        }).join('\n');
        corePrompt += `\n\n--- WHATSAPP DELIVERY OPTIONS ---
You CAN send the following on WhatsApp if the customer requests:
${intentList}

When the customer asks for any of these on WhatsApp:
1. Acknowledge naturally: "Theek hai, abhi WhatsApp pe bhej raha hoon" or "Sure, I'll send that on WhatsApp right after this call"
2. Continue the conversation
3. The system will auto-deliver the message after the call ends — do NOT promise things outside this list.`;
      }
    } catch (e) {
      console.error(`[initiateCall] WhatsApp options inject failed: ${e.message}`);
    }
  }

  const rawGreeting = agent.greeting_message || '';
  const greeting = rawGreeting.replace(/\{name\}/g, lead?.name || '');

  return {
    agent_name: agent.name,
    agent_id: agent.id,
    client_id: agent.client_id,
    lead_id: lead?.id || null,
    provider_id: null,
    core_prompt: corePrompt,
    greeting_message: greeting,
    lead_snapshot: leadSnapshot,
    persona: agent.persona || {},
    tool_flags: {
      has_kb: hasKnowledgeBase,
      has_shopify: hasShopify,
      has_unicommerce: hasUniCommerce,
      has_call_history: !!lead?.id,
      has_transfer: !!(agent.human_transfer_number || (client?.account_type === 'personal' && client?.phone)),
      has_end_call: true
    },
    kb_file_uri: kbFileUri,
    human_transfer_number: agent.human_transfer_number
      || (client?.account_type === 'personal' ? client?.phone : '')
      || '',
    enable_auto_transfer: agent.enable_auto_transfer !== false,
    is_screening_call: false
  };
}

// ─── Smartflo C2C token picker (multi-channel routing) ───
// Routes outbound calls to the correct Smartflo channel/token based on flow.
// Each channel is bound at the Smartflo side to a specific WSS streaming URL,
// so picking the right token automatically routes the call to the right
// stream function (streamGeminiPersonal / streamGeminiOutgoing / streamAudio).
function pickSmartfloToken(agent, client, fallbackToken) {
  const isPersonal = client?.account_type === 'personal';
  const isGemini = agent?.persona?.voice_engine === 'gemini_live';

  // Phase 1: Personal + Gemini → dedicated personal channel
  if (isPersonal && isGemini) {
    const t = Deno.env.get('SMARTFLO_C2C_GEMINI_PERSONAL');
    if (t) { console.log('[initiateCall] 🔀 Routing via Gemini-Personal channel'); return t; }
  }
  // Phase 2: Business + Gemini → outbound business Gemini channel
  if (!isPersonal && isGemini) {
    const t = Deno.env.get('SMARTFLO_C2C_GEMINI_OUTGOING');
    if (t) { console.log('[initiateCall] 🔀 Routing via Gemini-Outgoing channel'); return t; }
  }
  // Phase 3: Business + Realtime/AzureSpeech → outbound business Realtime channel
  const isRealtime = agent?.persona?.voice_engine === 'realtime' || agent?.persona?.voice_engine === 'azure_speech';
  if (!isPersonal && isRealtime) {
    const t = Deno.env.get('SMARTFLO_C2C_REALTIME_OUTGOING');
    if (t) { console.log('[initiateCall] 🔀 Routing via Realtime-Outgoing channel'); return t; }
  }
  return fallbackToken;
}

// ─── Phase 2: country-code smart routing ───
// Determines which telephony provider handles the call based on:
//   1. agent.calling_provider explicit override ('smartflo' | 'twilio' | 'auto')
//   2. callee country code when set to 'auto' (+91 → smartflo, +1/+44 → twilio)
function detectCountryFromPhone(phone) {
  const clean = String(phone || '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+1') || /^1\d{10}$/.test(clean)) return 'US';
  if (clean.startsWith('+44') || /^44\d{9,10}$/.test(clean)) return 'GB';
  if (clean.startsWith('+91') || /^91\d{10}$/.test(clean)) return 'IN';
  // 11-digit number starting with leading trunk-zero (Indian dialing format e.g. 08087390277) → IN
  if (/^0\d{10}$/.test(clean)) return 'IN';
  // 10-digit naked number → assume IN (legacy behavior)
  if (/^\d{10}$/.test(clean)) return 'IN';
  // Any number prefixed with the India country code (91…) that isn't a clean
  // +1/+44 international number → treat as IN. Catches malformed/garbled Indian
  // entries (e.g. 13-digit "9109049785500" from double-prefixing) so they stay
  // on Smartflo instead of leaking to Twilio (which rejects them with HTTP 400).
  if (/^91\d{8,12}$/.test(clean)) return 'IN';
  return 'UNKNOWN';
}
// Returns true when the agent's assigned DID is an Indian (+91) Smartflo number.
// Indian Smartflo DIDs can't be used on Twilio (error 21210), so if the agent
// is clearly an Indian-Smartflo agent we must keep the call on Smartflo even
// when the destination number is malformed and country detection fails.
function agentHasIndianSmartfloDID(agent) {
  const dids = (agent?.assigned_dids && agent.assigned_dids.length > 0)
    ? agent.assigned_dids
    : (agent?.assigned_did ? [agent.assigned_did] : []);
  return dids.some((d) => {
    const clean = String(d || '').replace(/[^0-9]/g, '');
    return clean.startsWith('91') || /^0?\d{10}$/.test(clean);
  });
}

function resolveProvider(agent, phone, client) {
  const pref = (agent?.calling_provider || 'auto').toLowerCase();
  if (pref === 'smartflo' || pref === 'twilio' || pref === 'signalwire') return pref;
  // Client-region override: US/UK clients have no Smartflo credentials, so
  // force the international provider regardless of destination country.
  const clientRegion = (client?.region || '').toUpperCase();
  const country = detectCountryFromPhone(phone);
  // Safety net: if the destination country is unknown AND the agent uses an
  // Indian Smartflo DID, keep the call on Smartflo (Twilio would reject it
  // with error 21210 since the +91 DID isn't a verified Twilio number).
  if (country === 'UNKNOWN' && clientRegion !== 'US' && clientRegion !== 'UK'
      && agentHasIndianSmartfloDID(agent)) {
    return 'smartflo';
  }
  // US destination → SignalWire (preferred for US/CA compliance + pricing).
  // The router falls back to Twilio inside the SignalWire branch if config is missing.
  if (country === 'US' || clientRegion === 'US') return 'signalwire';
  if (clientRegion === 'UK') return 'twilio';
  // India → Smartflo. Everything else international → Twilio.
  if (country === 'IN') return 'smartflo';
  return 'twilio';
}

// ─── TRAI calling-window gate (India only) ───
// Restricts outbound voice calls to 9:00 AM–9:00 PM
// IST. campaignPoller already enforces this for campaign dials, but DIRECT dial
// paths (manual quick-call, sequences/scheduled activities, public API, auto-
// trigger) all funnel through initiateCall — so enforcing it HERE makes it the
// single source of truth no path can bypass. Returns true only when the current
// IST time is inside the window.
function isWithinIndianCallingWindow() {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = nowIST.getHours();
  return h >= 9 && h < 21; // 9:00 AM – 9:00 PM IST (calls must START before 21:00)
}

// ─── Region-aware call quota gate ───
// IN: legacy 10-call trial cap + trial_end_date.
// US/UK: trial gated by trial_end_date; active gated when minute usage
//        exceeds included × OVERAGE_GRACE_MULTIPLIER.
const OVERAGE_GRACE_MULTIPLIER = 1.5;
function checkCallQuota(client) {
  if (!client) return { allowed: false, error: 'Client not found', block_reason: 'no_client', http_status: 404 };
  const region = client.region || 'IN';
  const status = client.account_status;
  const now = new Date();

  if (status === 'suspended') {
    return { allowed: false, error: 'Account suspended. Contact support to restore access.', block_reason: 'account_suspended', http_status: 403 };
  }

  if (region === 'IN') {
    if (status === 'trial' || status === 'expired') {
      const trialEnd = client.trial_end_date ? new Date(client.trial_end_date) : null;
      const unlimitedUntil = client.trial_topup_unlimited_until ? new Date(client.trial_topup_unlimited_until) : null;
      const isUnlimited = unlimitedUntil && unlimitedUntil > now;
      const callsUsed = Number(client.trial_calls_used || 0);
      const callLimit = Number(client.trial_call_limit ?? 10);
      if (status === 'expired' || (trialEnd && trialEnd <= now && !isUnlimited)) {
        return { allowed: false, error: 'Your free trial has ended. Please top-up or subscribe to continue making calls.', block_reason: 'trial_expired', http_status: 402 };
      }
      if (!isUnlimited && callsUsed >= callLimit) {
        return { allowed: false, error: `You've used all ${callLimit} trial calls. Top-up for unlimited calling or subscribe to a full plan.`, block_reason: 'call_limit_reached', http_status: 402 };
      }
    }
    return { allowed: true };
  }

  // US / UK
  if (status === 'trial') {
    const trialEnd = client.trial_end_date ? new Date(client.trial_end_date) : null;
    if (trialEnd && trialEnd <= now) {
      return { allowed: false, error: 'Your free trial has ended. Please subscribe to a minute plan to continue making calls.', block_reason: 'trial_expired', http_status: 402 };
    }
    return { allowed: true };
  }
  if (status === 'expired') {
    return { allowed: false, error: 'Your subscription has expired. Please choose a plan to resume calling.', block_reason: 'subscription_expired', http_status: 402 };
  }
  if (status === 'active') {
    const included = Number(client.minutes_included || 0);
    const used = Number(client.minutes_used_this_period || 0);
    if (included > 0 && used >= included * OVERAGE_GRACE_MULTIPLIER) {
      return { allowed: false, error: `You've exceeded your monthly minutes (${used.toLocaleString()} used of ${included.toLocaleString()} included). Upgrade your plan to continue.`, block_reason: 'minutes_exceeded', http_status: 402 };
    }
  }
  return { allowed: true };
}

export default async function initiateCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const {
      lead_id, agent_id, phone_number, service_call, context_override,
      // ── BFSI Suite (Sprint 2): pre-call compliance gate ──
      // When any of these fields is present the call is treated as a BFSI
      // call and routed through bfsiComplianceGate (calling window + DNC +
      // max-attempts). The gate's result is later persisted by logBfsiCompliance.
      bfsi_case_type,            // 'collection' | 'verification' | 'rcu' | 'mandate_bounce' | 'legal'
      bfsi_loan_account_id,
      bfsi_client_id,            // optional override; defaults to agent.client_id
      bfsi_override_window = false,
    } = body;

    // Allow internal service-role invocations (e.g. from sequence processor) to bypass user auth
    let user = null;
    if (!service_call) {
      user = c.get('jwtPayload');
      if (!user) {
        return c.json({ data: { error: 'Unauthorized' } }, 401);
      }
    }

    if (!lead_id || !agent_id || !phone_number) {
      return c.json({ data: { error: 'Missing required fields' } }, 400);
    }

    // Get agent and lead details — use .catch so a missing record returns a
    // clean 404 to the UI instead of crashing the whole function with a 500.
    const [agent, lead] = await Promise.all([
      base44.asServiceRole.entities.Agent.get(agent_id).catch(() => null),
      base44.asServiceRole.entities.Lead.get(lead_id).catch(() => null)
    ]);

    if (!agent) {
      console.error(`[initiateCall] Agent not found: ${agent_id}`);
      return c.json({ data: {
        success: false,
        error: `Agent not found (id: ${agent_id}). It may have been deleted — please reselect an agent.`,
        block_reason: 'agent_not_found'
      } }, 404);
    }
    if (!lead) {
      console.error(`[initiateCall] Lead not found: ${lead_id}`);
      return c.json({ data: {
        success: false,
        error: `Lead not found (id: ${lead_id}). It may have been deleted — please refresh and try again.`,
        block_reason: 'lead_not_found'
      } }, 404);
    }

    // ─── BFSI Compliance Gate (Sprint 2) ───
    // Runs ONLY when the caller flagged this as a BFSI call. Non-BFSI calls
    // (regular sales/support/screening) are completely unaffected.
    let bfsiGateResult = null;
    if (bfsi_case_type) {
      const bfsiClient = bfsi_client_id || agent?.client_id || lead?.client_id;
      try {
        const gateRes = await base44.asServiceRole.functions.invoke('bfsiComplianceGate', {
          client_id: bfsiClient,
          phone: phone_number,
          loan_account_id: bfsi_loan_account_id || null,
          override_window: bfsi_override_window,
        });
        bfsiGateResult = gateRes?.data || null;
        if (bfsiGateResult && bfsiGateResult.allowed === false) {
          console.log(`[initiateCall] 🚫 BFSI GATE BLOCK violations=${(bfsiGateResult.violations || []).join(',')}`);
          return c.json({ data: {
            success: false,
            error: `BFSI compliance block: ${(bfsiGateResult.violations || []).join(', ')}`,
            block_reason: 'bfsi_compliance',
            bfsi_gate: bfsiGateResult,
          } }, 403);
        }
      } catch (e) {
        console.error('[initiateCall] BFSI gate check failed:', e.message);
        // Fail-closed for BFSI — regulators expect this.
        return c.json({ data: {
          success: false,
          error: 'BFSI compliance check failed. Call blocked as a precaution.',
          block_reason: 'bfsi_gate_error',
        } }, 503);
      }
    }

    // ─── TRAI calling-window gate (India, AUTOMATED paths only) ───
    // Blocks automated India outbound calls outside 9:00 AM–9:00 PM IST
    // (sequences, scheduled activities, public API, auto-trigger — all of which
    // arrive with service_call=true). MANUAL test dials initiated by a logged-in
    // user (service_call falsy) are exempt so the team can test agents any time.
    // BFSI calls are also exempt — they ran bfsiComplianceGate above (own window).
    const calleeCountry = detectCountryFromPhone(phone_number);
    if (service_call && !bfsi_case_type && calleeCountry === 'IN' && !isWithinIndianCallingWindow()) {
      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
      console.log(`[initiateCall] ⏰ TRAI WINDOW BLOCK — current IST ${nowIST} is outside 9:00 AM–9:00 PM`);
      return c.json({ data: {
        success: false,
        error: `Call blocked: outside the permitted TRAI calling window (9:00 AM – 9:00 PM IST). Current time is ${nowIST} IST.`,
        block_reason: 'outside_calling_hours',
      } }, 403);
    }

    // ─── TCPA / TPS DNC scrub (US + UK only) ───
    // Skip for service_call=true ONLY when the caller has already scrubbed
    // (currently no internal caller pre-scrubs — keep enforcing for safety).
    if (calleeCountry === 'US' || calleeCountry === 'GB') {
      try {
        const dncRes = await base44.asServiceRole.functions.invoke('checkDnc', {
          phone_number,
          client_id: agent?.client_id || lead?.client_id || null
        });
        if (dncRes?.data?.is_dnc) {
          // Mark lead as do_not_call (fire-and-forget)
          base44.asServiceRole.entities.Lead.update(lead_id, {
            status: 'do_not_call',
            notes: `${lead.notes ? lead.notes + '\n\n' : ''}[DNC] Blocked ${new Date().toISOString()}: ${dncRes.data.reason || 'on DNC list'} (${dncRes.data.source || 'internal'})`
          }).catch((e) => console.error('[initiateCall] DNC lead update failed:', e.message));

          console.log(`[initiateCall] 🚫 DNC BLOCK phone=${phone_number} country=${calleeCountry} source=${dncRes.data.source}`);
          return c.json({ data: {
            success: false,
            error: `Call blocked: this number is on the ${calleeCountry === 'US' ? 'US National DNC Registry' : 'UK TPS list'}. The lead has been marked do-not-call.`,
            block_reason: 'dnc_listed',
            dnc_source: dncRes.data.source,
            country: calleeCountry
          } }, 403);
        }
      } catch (e) {
        // DNC service errored — fail-closed for US/UK is the TCPA-safe choice.
        console.error('[initiateCall] DNC check failed:', e.message);
        return c.json({ data: {
          success: false,
          error: 'DNC compliance check failed. Call blocked as a precaution. Please try again or contact support.',
          block_reason: 'dnc_check_error'
        } }, 503);
      }
    }

    // ─── Phase 2: route to Twilio for US/UK numbers (or explicit twilio provider) ───
    // twilioInitiateCall has its own quota gate, so we forward as-is.
    // Fetch client up front so US/UK clients are forced to Twilio regardless
    // of destination country (they have no Smartflo credentials).
    const earlyClient = agent?.client_id
      ? await base44.asServiceRole.entities.Client.get(agent.client_id).catch(() => null)
      : null;
    if (agent) {
      const provider = resolveProvider(agent, phone_number, earlyClient);

      // ─── SignalWire branch (US destinations / US clients) ───
      if (provider === 'signalwire') {
        // Auto-fallback: if SignalWire isn't configured/active, drop through to Twilio.
        const swCfgs = await base44.asServiceRole.entities.SignalWireConfig.list('-created_date', 1).catch(() => []);
        const swActive = swCfgs?.[0]?.is_active && swCfgs[0]?.project_id && swCfgs[0]?.api_token && swCfgs[0]?.space_url;
        if (swActive) {
          console.log(`[initiateCall] 🌍 Routing to SignalWire (provider=${provider}, phone=${phone_number})`);
          let swRes;
          try {
            swRes = await base44.asServiceRole.functions.invoke('signalWireInitiateCall', {
              lead_id, agent_id, phone_number, service_call: true, context_override
            });
          } catch (swErr) {
            const body = swErr?.response?.data || swErr?.data || {};
            const msg = body.error || body.message || swErr.message || 'SignalWire routing failed';
            console.error(`[initiateCall] ❌ SignalWire sub-call failed: ${msg}`, JSON.stringify(body));
            return c.json({ data: { success: false, error: msg, ...body } }, 400);
          }
          const out = swRes?.data || { success: false, error: 'SignalWire routing failed (empty response)' };
          return c.json({ data: out }, out.success === false ? 400 : 200);
        }
        console.log('[initiateCall] ⚠️ SignalWire not configured — falling back to Twilio');
      }

      if (provider === 'twilio' || provider === 'signalwire') {
        console.log(`[initiateCall] 🌍 Routing to Twilio (provider=${provider}, phone=${phone_number}, client_region=${earlyClient?.region || 'unknown'})`);
        let twRes;
        try {
          twRes = await base44.asServiceRole.functions.invoke('twilioInitiateCall', {
            lead_id, agent_id, phone_number, service_call: true, context_override
          });
        } catch (twErr) {
          const body = twErr?.response?.data || twErr?.data || {};
          const msg = body.error || body.message || twErr.message || 'Twilio routing failed';
          console.error(`[initiateCall] ❌ Twilio sub-call failed: ${msg}`, JSON.stringify(body));
          return c.json({ data: { success: false, error: msg, ...body } }, 400);
        }
        const out = twRes?.data || { success: false, error: 'Twilio routing failed (empty response)' };
        return c.json({ data: out }, out.success === false ? 400 : 200);
      }
    }

    if (!agent) {
      return c.json({ data: { error: 'Agent not found' } }, 404);
    }

    if (!lead) {
      return c.json({ data: { error: 'Lead not found' } }, 404);
    }

    // Ownership validation: skip for service calls (processor already validated)
    // Admins bypass ownership — they can place calls on any tenant (e.g. Vaani Sales Hub).
    let clients = [];
    if (!service_call && user?.role !== 'admin') {
      clients = await base44.entities.Client.filter({ user_id: user.id });
      const userClientIds = clients.map(c => c.id);
      // Invited team members don't OWN a Client — they're linked to the owner's
      // account via user.client_id. Include it so they can place calls too.
      if (user?.client_id && !userClientIds.includes(user.client_id)) {
        userClientIds.push(user.client_id);
      }

      if (!userClientIds.includes(agent.client_id)) {
        return c.json({ data: { error: 'Forbidden: Agent does not belong to your account' } }, 403);
      }
      if (!userClientIds.includes(lead.client_id)) {
        return c.json({ data: { error: 'Forbidden: Lead does not belong to your account' } }, 403);
      }
    } else {
      // Fetch the client record for demo detection (service call OR admin)
      clients = await base44.asServiceRole.entities.Client.filter({ id: agent.client_id });
    }

    // Support multiple DIDs - pick first available
    const allDIDs = (agent.assigned_dids && agent.assigned_dids.length > 0)
      ? agent.assigned_dids
      : (agent.assigned_did ? [agent.assigned_did] : []);
    if (allDIDs.length === 0) {
      return c.json({ data: { 
        success: false,
        error: 'No DID assigned to agent. Please assign a DID to the agent before making calls.' 
      } }, 400);
    }

    // Check if this is a demo agent (client is trial/onboarding and DID is from demo pool)
    const clientData = clients[0];
    if (!clientData) {
      console.error(`[initiateCall] Client not found for agent.client_id=${agent.client_id}`);
      return c.json({ data: {
        success: false,
        error: 'Client account for this agent was not found. The agent may be linked to a deleted account — please reassign it.',
        block_reason: 'client_not_found'
      } }, 404);
    }
    const isDemoAgent = clientData.account_status === 'trial' || clientData.account_status === 'onboarding';

    // ── Region-aware quota gate (IN: 10-call trial; US/UK: minute-based) ──
    {
      const gate = checkCallQuota(clientData);
      if (!gate.allowed) {
        return c.json({ data: { success: false, error: gate.error, block_reason: gate.block_reason } }, gate.http_status);
      }
    }

    // Use primary DID for single calls
    const callerDID = allDIDs[0];

    // ── WHATSAPP DELIVERY OPTIONS (group-scoped) ──
    // If the lead belongs to any LeadGroup with WhatsApp mappings, inject the
    // available intents into the agent prompt so it can naturally offer them
    // mid-call. The actual send happens post-call via dispatchPostCallWhatsApp.
    let whatsappExtraInstructions = '';
    try {
      const groupIds = Array.isArray(lead.group_ids) ? lead.group_ids : [];
      if (groupIds.length > 0) {
        const mappingArrays = await Promise.all(groupIds.map(gid =>
          base44.asServiceRole.entities.CampaignTemplateMapping.filter({ group_id: gid }).catch(() => [])
        ));
        const allMappings = mappingArrays.flat().filter(m =>
          m.enabled !== false && m.template_id &&
          (m.trigger_condition === 'ai_requested' || !m.trigger_condition)
        );
        if (allMappings.length > 0) {
          const intentList = [...new Set(allMappings.map(m =>
            m.intent === 'custom' ? (m.custom_intent_label || 'custom') : m.intent
          ))].map(i => `  - ${i}`).join('\n');
          whatsappExtraInstructions = `\n\n--- WHATSAPP DELIVERY OPTIONS ---
You CAN send the following on WhatsApp if the customer requests:
${intentList}

When the customer asks for any of these on WhatsApp:
1. Acknowledge naturally: "Theek hai, abhi WhatsApp pe bhej raha hoon" or "Sure, I'll WhatsApp that to you right after this call"
2. Continue the conversation
3. The system will auto-deliver the message after the call ends — do NOT promise things outside this list.`;
        }
      }
    } catch (e) {
      console.error('[initiateCall] WhatsApp options inject failed:', e.message);
    }

    // ═══ SLIM CACHE: INLINED (Phase A Tier 1.1) ═══
    // Previously: functions.invoke('buildAgentContext') — added ~100-150ms HTTP roundtrip.
    // Now: built inline via buildSlimCacheInline() — same logic, same output, no network hop.
    let slimCache = null;
    try {
      slimCache = await buildSlimCacheInline(base44, {
        agent,
        lead,
        extraInstructions: (context_override || '') + whatsappExtraInstructions,
        campaignId: null
      });
    } catch (e) {
      console.error('Inline slim cache build failed — falling back to minimal cache:', e.message);
    }

    // Legacy fallback: if buildAgentContext failed, build a minimal cache inline
    if (!slimCache) {
      slimCache = {
        agent_name: agent.name,
        agent_id: agent.id,
        client_id: agent.client_id,
        lead_id: lead_id,
        core_prompt: (agent.system_prompt || 'You are a helpful AI voice assistant.').substring(0, 1500),
        greeting_message: (agent.greeting_message || '').replace(/\{name\}/g, lead?.name || ''),
        persona: agent.persona || {},
        tool_flags: {
          has_kb: !!(agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0),
          has_shopify: false,
          has_unicommerce: false,
          has_call_history: true,
          has_transfer: !!agent.human_transfer_number,
          has_end_call: true
        },
        kb_file_uri: agent.kb_file_uri || '',
        human_transfer_number: agent.human_transfer_number || '',
        enable_auto_transfer: agent.enable_auto_transfer !== false,
        is_screening_call: false
      };
    }

    // Sequence step context (passed to the stream via extra_instructions — already merged in core_prompt)

    // BACKWARD COMPAT: also set legacy `system_prompt` key so old stream code still works.
    // This is a COPY of core_prompt (already slim). The old ~5KB blob is no longer built.
    const legacyCompat = {
      system_prompt: slimCache.core_prompt,
      knowledge_base_content: '',   // intentionally empty — fetched lazily via kb_file_uri
      lead_context: slimCache.lead_snapshot || ''
    };

    // Create call log in POSTGRES (canonical) — read by the stream via
    // custom_identifier. No Base44 CallLog write in the dial hot path.
    const callLogId = genUuid();
    const initialCallSid = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const callLog = { id: callLogId, call_sid: initialCallSid };
    await pgInsertCallLog({
      id: callLogId,
      client_id: agent.client_id,
      agent_id: agent_id,
      lead_id: lead_id,
      call_sid: initialCallSid,
      caller_id: callerDID,
      callee_number: phone_number,
      status: 'initiated',
      conversation_summary: slimCache.lead_snapshot ? `[LEAD SNAPSHOT] ${slimCache.lead_snapshot}` : '',
      agent_config_cache: { ...slimCache, ...legacyCompat }
    });
    console.log(`[initiateCall] Slim cache built (PG callLog=${callLogId}): core_prompt=${slimCache.core_prompt.length}ch, kb_uri=${slimCache.kb_file_uri ? 'yes' : 'no'}, flags=${JSON.stringify(slimCache.tool_flags)}`);

    // Clean phone number for Smartflo API
    // Smartflo expects caller_id WITHOUT "+" prefix — keep full digits (e.g., 918065489180)
    // If that fails, some Smartflo channels need just the 10-digit number
    let cleanCallerID = callerDID.replace(/[^0-9]/g, '');
    // If stored as just 10 digits, prepend 91
    if (cleanCallerID.length === 10) {
      cleanCallerID = '91' + cleanCallerID;
    }
    let cleanPhoneNumber = phone_number.replace(/[^0-9]/g, '');
    // Strip Indian trunk-zero prefix (e.g. 08087390277 → 8087390277) so Smartflo accepts it
    if (/^0\d{10}$/.test(cleanPhoneNumber)) {
      cleanPhoneNumber = cleanPhoneNumber.substring(1);
    }
    console.log(`Cleaned caller_id: ${cleanCallerID}, callee: ${cleanPhoneNumber}`);

    // Demo agents always use the global/base API key; production agents use their own token.
    // Phase 1 routing: personal-account + Gemini agents are routed to the dedicated
    // SMARTFLO_C2C_GEMINI_PERSONAL channel (which streams to streamGeminiPersonal WSS).
    const baseToken = isDemoAgent
      ? Deno.env.get('SMARTFLO_API_KEY')
      : (agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY'));
    const smartfloApiKey = pickSmartfloToken(agent, clientData, baseToken);
    console.log(`Call mode: ${isDemoAgent ? 'DEMO (shared key)' : 'PRODUCTION (agent token)'}, DID: ${callerDID}`);
    if (!smartfloApiKey) {
      return c.json({ data: { 
        success: false, 
        error: 'No Smartflo API token configured for this agent. Please set the Click to Call API Token in agent settings.' 
      } }, 400);
    }

    // Initiate call via Smartflo Click-to-Call Support API
    const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: smartfloApiKey,
        customer_number: cleanPhoneNumber,
        caller_id: cleanCallerID,
        async: 1,
        // ─── Phase 1: custom tracking field ───
        // Per Smartflo's official Click-to-Call Support API docs, the ONLY field
        // echoed back into the webhook + VOICE Streaming `start.customParameters`
        // is `custom_identifier` (the parameter name is flexible, but it must be
        // sent under this mechanism — arbitrary keys like cf1/custom_field_1 are
        // silently dropped). We pack our CallLog id here so streamGeminiOutgoing
        // can resolve the call in O(1). NOTE: for a Dynamic Voice Bot endpoint,
        // this field must ALSO be registered in Settings → Channels → Voice Bot.
        // If it still doesn't arrive, the stream falls back to the phone-scan.
        custom_identifier: callLog.id
      })
    });

    const smartfloData = await smartfloResponse.json();
    console.log('Smartflo response:', JSON.stringify(smartfloData));

    if (!smartfloResponse.ok || smartfloData.success === false || smartfloData.caller_id) {
      // Smartflo returns {caller_id: "Provide a vaild caller_id."} when the DID is not mapped to the API token's channel
      const errorMsg = smartfloData.caller_id 
        ? `Invalid caller_id: DID ${callerDID} is not mapped to this API token's Smartflo channel. Please verify the DID is assigned to this token in Smartflo dashboard.`
        : (smartfloData.message || smartfloData.error || JSON.stringify(smartfloData));
      console.error('Smartflo API error:', errorMsg);

      await pgUpdateCallLogStatus(callLog.id, '', 'failed');

      return c.json({ data: { 
        success: false, 
        error: `Failed to initiate call: ${errorMsg}` 
      } }, 400);
    }

    // Update call log with Smartflo response (Postgres — canonical)
    await pgUpdateCallLogStatus(
      callLog.id,
      smartfloData.call_id || smartfloData.call_sid || callLog.call_sid,
      'ringing'
    );

    // ── DID concurrency increment (atomic, fire-and-forget) ──
    // Tracks in-flight calls per DID so dialers/observability can enforce
    // capacity without scanning CallLog. postCallOrchestrator decrements on
    // call-end. Now backed by Azure Postgres (pgDidConcurrency) instead of the
    // rate-limited Base44 DIDConcurrency entity. Best-effort — never blocks the
    // answer path.
    base44.asServiceRole.functions.invoke('pgDidConcurrency', {
      service_call: true,
      action: 'increment',
      did_number: callerDID,
      client_id: agent.client_id,
    }).catch((e) => console.error('[initiateCall] DID concurrency increment failed:', e.message));

    // Update lead status — FIRE-AND-FORGET (Phase A Tier 1.2)
    // Saves ~50ms. If this fails, the next webhook will refresh the lead anyway.
    base44.asServiceRole.entities.Lead.update(lead_id, {
      status: 'contacted',
      last_call_date: new Date().toISOString()
    }).catch((e) => console.error('[initiateCall] Lead update (async) failed:', e.message));

    // ─── BFSI: increment attempts_today on the loan account (async) ───
    if (bfsi_case_type && bfsi_loan_account_id) {
      (async () => {
        try {
          const acct = await base44.asServiceRole.entities.LoanAccount.get(bfsi_loan_account_id);
          const today = new Date().toISOString().substring(0, 10);
          const same = acct?.attempts_today_date === today;
          await base44.asServiceRole.entities.LoanAccount.update(bfsi_loan_account_id, {
            attempts_today: same ? (acct.attempts_today || 0) + 1 : 1,
            attempts_today_date: today,
            total_attempts: (acct?.total_attempts || 0) + 1,
            last_called_at: new Date().toISOString(),
          });
        } catch (e) {
          console.error('[initiateCall] BFSI attempt counter update failed:', e.message);
        }
      })();
    }

    // ── Increment trial call counter — FIRE-AND-FORGET (Phase A Tier 1.3) ──
    // Saves ~30ms. The trial GATE check at top is sync (cannot skip); only the
    // counter increment after success is async. Worst case: one extra trial call.
    if (clientData.account_status === 'trial') {
      const unlimitedUntil = clientData.trial_topup_unlimited_until ? new Date(clientData.trial_topup_unlimited_until) : null;
      const isUnlimited = unlimitedUntil && unlimitedUntil > new Date();
      if (!isUnlimited) {
        base44.asServiceRole.entities.Client.update(clientData.id, {
          trial_calls_used: Number(clientData.trial_calls_used || 0) + 1
        }).catch((e) => console.error('[initiateCall] trial counter (async) failed:', e.message));
      }
    }

    return c.json({ data: {
      success: true,
      call_id: callLog.id,
      call_log_id: callLog.id,
      call_sid: smartfloData.call_id || smartfloData.call_sid,
      message: 'Call initiated successfully',
      bfsi_gate: bfsiGateResult,
    } });

  } catch (error) {
    console.error('Error initiating call:', error);
    return c.json({ data: { 
      success: false, 
      error: error.message 
    } }, 500);
  }

};