import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// buildAgentContext
// Single source of truth for building an AI agent's runtime context.
//
// Returns a SLIM config (≤2KB) ready to be stored in
// CallLog.agent_config_cache. KB content is NOT inlined — only a
// kb_file_uri reference that the stream function fetches lazily.
//
// Called by:
//   - initiateCall (outbound lead calls)
//   - initiateScreeningCall (outbound screening)
//   - streamAudio / streamAudioGemini (inbound — via DID→Agent resolution)
//
// The streaming functions keep their own inbound-resolution logic; this
// function is invoked ONLY when the caller already knows agent_id.
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
  // If the agent prompt is too large, try to cut at the first clean section break after the cap
  const head = prompt.substring(0, cap);
  const lastBreak = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('. '));
  const trim = lastBreak > cap * 0.6 ? head.substring(0, lastBreak) : head;
  return trim.trim() + '\n\n[Detailed info available via search_knowledge_base tool]';
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function autoAttachMatchingKB(base44, agent) {
  if (!agent || (agent.knowledge_base_ids || []).length > 0 || !agent.client_id) return agent;

  const agentName = normalizeName(agent.name);
  if (!agentName) return agent;

  const docs = await base44.asServiceRole.entities.KnowledgeBase.filter({ client_id: agent.client_id }).catch(() => []);
  const readyDocs = docs.filter(d => d.status === 'ready' && d.content);
  const matches = readyDocs.filter(d => normalizeName(d.title).includes(agentName));

  if (matches.length !== 1) return agent;

  const kbId = matches[0].id;
  await base44.asServiceRole.entities.Agent.update(agent.id, {
    knowledge_base_ids: [kbId],
    kb_file_uri: '',
    kb_file_hash: ''
  });

  agent.knowledge_base_ids = [kbId];
  agent.kb_file_uri = '';
  agent.kb_file_hash = '';
  console.log(`[buildAgentContext] Auto-attached KB ${kbId} (${matches[0].title}) to agent=${agent.id}`);
  return agent;
}

// Compute hash of current KB doc contents (cheap — same djb2 as uploadKBToStorage)
function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function ensureKBFile(base44, agent) {
  await autoAttachMatchingKB(base44, agent);

  const kbIds = agent.knowledge_base_ids || [];
  // If agent has no KB docs, nothing to build
  if (kbIds.length === 0) return '';

  // Fetch current KB doc content to detect changes (cheap — small number of docs per agent)
  const kbDocs = (await Promise.all(
    kbIds.map(id => base44.asServiceRole.entities.KnowledgeBase.get(id).catch(() => null))
  )).filter(d => d && d.content);

  if (kbDocs.length === 0) return agent.kb_file_uri || '';

  const concatenated = kbDocs.map(d => `[${d.title || 'Untitled'}]\n${d.content}`).join('\n\n---\n\n');
  const currentHash = djb2Hash(concatenated);

  const hasAzureUri = agent.kb_file_uri && agent.kb_file_uri.startsWith('azblob://');
  const hashMatches = agent.kb_file_hash === currentHash;

  // Fast path: Azure URI exists AND content unchanged
  if (hasAzureUri && hashMatches) return agent.kb_file_uri;

  // Content changed OR file missing/legacy — fire rebuild in background.
  // Don't block the call. The CURRENT call will use the stale URI (if any);
  // the NEXT call will have the fresh KB.
  try {
    base44.asServiceRole.functions.invoke('uploadKBToStorage', { agent_id: agent.id })
      .then(() => console.log(`[buildAgentContext] Background KB rebuild kicked off for agent=${agent.id} (hash changed: ${!hashMatches}, missing URI: ${!hasAzureUri})`))
      .catch(e => console.error(`[buildAgentContext] Background KB rebuild failed for agent=${agent.id}: ${e.message}`));
  } catch (e) {
    console.error(`[buildAgentContext] KB background invoke failed for agent=${agent.id}: ${e.message}`);
  }

  // Return existing URI (stale is better than nothing); empty string if none
  return agent.kb_file_uri || '';
}

export default async function buildAgentContext(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const { agent_id, lead_id, provider_id, campaign_id, extra_instructions, is_screening, screening_data } = body;

    if (!agent_id) return c.json({ data: { error: 'agent_id required' } }, 400);

    // Fetch agent (required) + lead/provider (optional) in parallel
    const [agent, lead, provider, lastCallLogs] = await Promise.all([
      base44.asServiceRole.entities.Agent.get(agent_id),
      lead_id ? base44.asServiceRole.entities.Lead.get(lead_id).catch(() => null) : Promise.resolve(null),
      provider_id ? base44.asServiceRole.entities.ServiceProvider.get(provider_id).catch(() => null) : Promise.resolve(null),
      lead_id ? base44.asServiceRole.entities.CallLog.filter({ lead_id }, '-created_date', 1).catch(() => []) : Promise.resolve([])
    ]);

    if (!agent) return c.json({ data: { error: 'Agent not found' } }, 404);

    const client = agent.client_id
      ? await base44.asServiceRole.entities.Client.get(agent.client_id).catch(() => null)
      : null;

    // ── INDUSTRY BLUEPRINT (non-blocking, off the live-audio path) ──
    // Resolve the client's blueprint and inject its goal + target fields so the
    // agent knows what objective to hit and what info to gather. One cheap
    // parallel-ish read here; the real-time audio loop never re-fetches this.
    let blueprint = null;
    if (client) {
      try {
        const bpKey = client.blueprint_key
          || (client.industry
              ? String(client.industry).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
              : null);
        if (bpKey) {
          let bps = await base44.asServiceRole.entities.IndustryBlueprint.filter({ industry_key: bpKey, status: 'active' }).catch(() => []);
          if ((!bps || bps.length === 0)) {
            // Fallback: alias match on the raw label
            const rawLabel = String(client.industry || '').trim().toLowerCase();
            const all = await base44.asServiceRole.entities.IndustryBlueprint.filter({ status: 'active' }).catch(() => []);
            bps = (all || []).filter((b) => (b.aliases || []).some((a) => String(a).trim().toLowerCase() === rawLabel));
          }
          blueprint = bps?.[0] || null;
        }
      } catch (e) {
        console.error(`[buildAgentContext] blueprint resolve failed: ${e.message}`);
      }
    }

    // Check active marketplace integrations (flags only — no prose in prompt)
    const marketplaceInts = agent.client_id
      ? await base44.asServiceRole.entities.MarketplaceIntegration.filter({
          client_id: agent.client_id,
          status: 'active'
        }).catch(() => [])
      : [];

    const hasShopify = marketplaceInts.some(i => i.platform === 'shopify');
    const hasUniCommerce = marketplaceInts.some(i => i.platform === 'unicommerce');

    // Ensure KB file exists (lazy build if missing)
    const kbFileUri = await ensureKBFile(base44, agent);
    const hasKnowledgeBase = !!kbFileUri || !!(agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0);

    // Build lead snapshot (one-line summary with last-call one-liner)
    const lastCall = lastCallLogs && lastCallLogs[0] ? lastCallLogs[0] : null;
    const leadSnapshot = lead ? buildLeadSnapshot(lead, lastCall) : '';

    // Build the core prompt (capped at 1.5KB)
    let corePrompt = clipPrompt(agent.system_prompt || 'You are a helpful AI voice assistant.');

    if (leadSnapshot) {
      corePrompt += `\n\n--- LEAD SNAPSHOT ---\n${leadSnapshot}`;
      corePrompt += `\nThe customer's name is "${lead.name || 'Sir/Madam'}". Use their name naturally only once or twice — ideally near the greeting — NOT in every sentence. Repeating the name in each turn sounds robotic; avoid it.`;
      if (lastCall) {
        corePrompt += `\nIf the customer references past conversations or says "remember when...", CALL the get_call_history tool to fetch details.`;
      }
    }

    if (provider) {
      corePrompt += `\n\n--- CANDIDATE ---\nName: ${provider.name} | Category: ${(provider.category || '').replace(/_/g, ' ')} | Phone: ${provider.phone}`;
    }

    if (is_screening && screening_data) {
      corePrompt += `\n\n${screening_data}`;
    }

    if (extra_instructions) {
      corePrompt += `\n\n--- ADDITIONAL INSTRUCTIONS ---\n${extra_instructions}`;
    }

    // ── BLUEPRINT GOAL + TARGET FIELDS ──
    // Lightweight prompt addition (no tool, no extra round-trip). Tells the
    // agent its objective and what data points to naturally collect.
    if (blueprint) {
      const goal = blueprint.default_agent_goal;
      const fieldLabels = (blueprint.custom_fields || [])
        .map((f) => f.label)
        .filter(Boolean)
        .slice(0, 8);
      if (goal || fieldLabels.length) {
        corePrompt += `\n\n--- ${(blueprint.label || 'INDUSTRY').toUpperCase()} OBJECTIVE ---`;
        if (goal) corePrompt += `\nPrimary goal of this call: ${goal}.`;
        if (fieldLabels.length) {
          corePrompt += `\nWhere it fits naturally, try to learn: ${fieldLabels.join(', ')}. Do NOT interrogate — weave these into the conversation only when relevant.`;
        }
      }

      // ── PIPELINE STAGE AWARENESS ──
      // Map the lead's current status to a blueprint pipeline stage, then tell
      // the agent where the lead stands and what the next-stage objective is,
      // so it calls accordingly (e.g. a "Qualified" lead → push for a demo).
      const stages = (blueprint.pipeline_stages || [])
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      if (lead && lead.status && stages.length) {
        const idx = stages.findIndex((s) => s.key === lead.status);
        const current = idx >= 0 ? stages[idx] : null;
        const next = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null;
        if (current) {
          corePrompt += `\n\n--- PIPELINE STAGE ---`;
          corePrompt += `\nThis lead is currently at the "${current.label}" stage.`;
          if (next) {
            corePrompt += ` Your objective on this call is to move them toward the "${next.label}" stage.`;
          } else {
            corePrompt += ` This is the final stage — focus on retaining and delighting them.`;
          }
        }
      }
    }

    // ── WHATSAPP DELIVERY OPTIONS (campaign calls only) ──
    // Inject the curated list of intents the AI can offer over WhatsApp,
    // so it can confidently say "abhi WhatsApp pe bhej raha hoon" when asked.
    // The actual send happens post-call via dispatchPostCallWhatsApp.
    if (campaign_id) {
      try {
        const mappings = await base44.asServiceRole.entities.CampaignTemplateMapping.filter({
          campaign_id, enabled: true
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
        console.error(`[buildAgentContext] WhatsApp options inject failed: ${e.message}`);
      }
    }

    // Resolve greeting (interpolate {name} if lead/provider provided)
    const rawGreeting = agent.greeting_message || '';
    const greetingName = lead?.name || provider?.name || '';
    const greeting = rawGreeting.replace(/\{name\}/g, greetingName);

    // Build the slim cache object
    const cache = {
      // Required for tool/logic gating
      agent_name: agent.name,
      agent_id: agent.id,
      client_id: agent.client_id,
      lead_id: lead_id || null,
      provider_id: provider_id || null,

      // Core runtime content (≤1.5KB)
      core_prompt: corePrompt,
      greeting_message: greeting,
      lead_snapshot: leadSnapshot,

      // Voice persona
      persona: agent.persona || {},

      // Tool flags (no prose — streams generate tool descriptions themselves)
      tool_flags: {
        has_kb: hasKnowledgeBase,
        has_shopify: hasShopify,
        has_unicommerce: hasUniCommerce,
        has_call_history: !!(lead_id || provider_id),
        has_transfer: !!(agent.human_transfer_number || (client?.account_type === 'personal' && client?.phone)),
        has_end_call: true
      },

      // References (lazy-loaded by stream function)
      kb_file_uri: kbFileUri,

      // Transfer config
      human_transfer_number: agent.human_transfer_number
        || (client?.account_type === 'personal' ? client?.phone : '')
        || '',
      enable_auto_transfer: agent.enable_auto_transfer !== false,

      // Screening flag (so saveCallRecord triggers processScreeningResult)
      is_screening_call: !!is_screening
    };

    console.log(`[buildAgentContext] agent=${agent_id} core_prompt=${corePrompt.length}ch, kb_uri=${kbFileUri ? 'yes' : 'no'}, kb_ids=${agent.knowledge_base_ids?.length || 0}, flags=${JSON.stringify(cache.tool_flags)}`);

    return c.json({ data: { success: true, cache } });
  } catch (error) {
    console.error('[buildAgentContext] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};