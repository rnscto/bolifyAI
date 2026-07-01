import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// ═══════════════════════════════════════════════════════════════════════
// smartfloInboundRouter — extracted from smartfloWebhook to keep that file
// maintainable. Handles ONLY inbound-call identification & AI routing:
//   • Inbound concurrency cap
//   • DID → Agent → Client resolution
//   • PATH A: known lead calling back
//   • PATH B: unknown caller on a client DID
//   • PATH C: platform client calling VaaniAI support
//   • PATH D: completely unknown caller
//
// Invoked by smartfloWebhook (service-role, _internal) with the already-parsed
// webhook fields. Returns the same JSON shape smartfloWebhook used to return
// inline, plus an `early_return` flag so the caller knows to forward it as-is.
// ═══════════════════════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

async function sendTelegramDirect(client, { caller_number, caller_name, category, urgency, summary, type, recording_url }) {
  if (!client || !client.telegram_connected || !client.telegram_chat_id || !TELEGRAM_BOT_TOKEN) return;
  if (client.owner_notification_channel !== 'telegram' || client.dnd_enabled) return;
  try {
    let emoji = '📞';
    if (category === 'spam') emoji = '🚫';
    else if (category === 'family') emoji = '👨‍👩‍👧';
    else if (category === 'business') emoji = '💼';
    else if (category === 'promotional') emoji = '📢';
    else if (urgency === 'urgent') emoji = '🚨';

    const notifType = type || 'call';
    let message = notifType === 'summary' ? `📋 <b>Call Summary</b>\n\n` : `${emoji} <b>Incoming Call</b>\n\n`;
    message += `📱 From: <b>${caller_name || caller_number || 'Unknown'}</b>\n`;
    if (caller_name && caller_number) message += `📞 Number: ${caller_number}\n`;
    if (category) message += `🏷️ Category: ${category}\n`;
    if (urgency && urgency !== 'medium') message += `⚡ Urgency: ${urgency.toUpperCase()}\n`;
    if (summary) message += `\n💬 ${summary}`;
    if (recording_url) message += `\n\n🎧 <a href="${recording_url}">Play Recording</a>`;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: client.telegram_chat_id, text: message, parse_mode: 'HTML' })
    });
    const result = await res.json();
    console.log(`[smartfloInboundRouter] Telegram sent to ${client.company_name}: ok=${result.ok}`);
  } catch (e) {
    console.error(`[smartfloInboundRouter] Telegram send failed: ${e.message}`);
  }
}

export default async function smartfloInboundRouter(c: any) {
  const req = c.req.raw || c.req;
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    /* const base44 = ... */;

    const body = await c.req.json();
    const {
      call_id, status, incomingNumber, calledDID
    } = body;

    if (!incomingNumber) {
      return c.json({ data: { handled: false } });
    }

    // ═══ INBOUND CONCURRENCY CAP ═══
    if (calledDID && (status === 'ringing' || status === 'Ringing' || !status)) {
      try {
        const cleanCalledDID = calledDID.replace(/\D/g, '').slice(-10);
        const allDIDs = await base44.entities.DID.list('-created_date', 200);
        const didRec = allDIDs.find((d) => (d.number || '').replace(/\D/g, '').slice(-10) === cleanCalledDID);
        if (didRec) {
          const cap = didRec.max_inbound_concurrent_calls || 1;
          const recentInbound = await base44.entities.CallLog.filter({ direction: 'inbound' }, '-created_date', 100);
          const activeStatuses = new Set(['initiated', 'ringing', 'answered']);
          const activeOnDID = recentInbound.filter((c) => {
            if (!activeStatuses.has(c.status)) return false;
            const calleeLast10 = (c.callee_number || '').replace(/\D/g, '').slice(-10);
            return calleeLast10 === cleanCalledDID;
          }).length;
          if (activeOnDID >= cap) {
            console.log(`[smartfloInboundRouter] 🚫 Inbound cap hit on DID ${calledDID}: ${activeOnDID}/${cap} — rejecting call`);
            return c.json({ data: {
              early_return: true, http_status: 429,
              body: { success: false, rejected: true, reason: 'inbound_cap_reached',
                message: `DID at capacity (${activeOnDID}/${cap}). Call will follow Smartflo failover.`, did: calledDID }
            } });
          }
        }
      } catch (capErr) {
        console.error(`[smartfloInboundRouter] Inbound cap check failed (allowing call): ${capErr.message}`);
      }
    }

    const cleanNumber = incomingNumber.replace(/\D/g, '');
    const last10 = cleanNumber.slice(-10);
    const cleanDID = (calledDID || '').replace(/\D/g, '').slice(-10);

    // ═══ STEP 1: Resolve DID → Agent → Client ═══
    let resolvedAgent = null;
    let resolvedClient = null;
    let resolvedDID = null;

    if (cleanDID) {
      // Reuse the DID list already fetched during the inbound-cap check when
      // possible; otherwise fetch once here (single scan instead of two).
      const allDIDs = await base44.entities.DID.list('-created_date', 200);
      resolvedDID = allDIDs.find(d => (d.number || '').replace(/\D/g, '').slice(-10) === cleanDID);
      if (resolvedDID && resolvedDID.agent_id) {
        try {
          resolvedAgent = await base44.entities.Agent.get(resolvedDID.agent_id);
          console.log(`[smartfloInboundRouter] DID ${calledDID} → Agent "${resolvedAgent.name}" (${resolvedAgent.id})`);
        } catch (e) {
          console.warn(`[smartfloInboundRouter] Agent ${resolvedDID.agent_id} not found: ${e.message}`);
        }
      }
      if (resolvedDID && resolvedDID.client_id) {
        try {
          resolvedClient = await base44.entities.Client.get(resolvedDID.client_id);
          console.log(`[smartfloInboundRouter] DID ${calledDID} → Client "${resolvedClient.company_name}" (${resolvedClient.id})`);
        } catch (e) {
          console.warn(`[smartfloInboundRouter] Client ${resolvedDID.client_id} not found: ${e.message}`);
        }
      }
    }

    if (!resolvedAgent && cleanDID) {
      const allAgents = await base44.entities.Agent.list('-created_date', 100);
      resolvedAgent = allAgents.find(a => {
        const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []);
        return dids.some(d => (d || '').replace(/\D/g, '').slice(-10) === cleanDID);
      });
      if (resolvedAgent) {
        console.log(`[smartfloInboundRouter] Fallback: DID ${calledDID} → Agent "${resolvedAgent.name}" via assigned_dids`);
        if (!resolvedClient && resolvedAgent.client_id) {
          try { resolvedClient = await base44.entities.Client.get(resolvedAgent.client_id); } catch (_) {}
        }
      }
    }

    // ═══ STEP 2: Identify the CALLER as a Lead ═══
    let matchedLead = null;
    if (resolvedClient) {
      const clientLeads = await base44.entities.Lead.filter({ client_id: resolvedClient.id });
      matchedLead = clientLeads.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === last10);
      if (matchedLead) {
        console.log(`[smartfloInboundRouter] Caller identified as Lead: "${matchedLead.name}" (${matchedLead.id}), status=${matchedLead.status}, score=${matchedLead.score}`);
      }
      try {
        const clientProviders = await base44.entities.ServiceProvider.filter({ client_id: resolvedClient.id });
        const matchedProvider = clientProviders.find(p => p.phone && p.phone.replace(/\D/g, '').slice(-10) === last10);
        if (matchedProvider) {
          console.log(`[smartfloInboundRouter] Caller identified as ServiceProvider: "${matchedProvider.name}" (${matchedProvider.id})`);
        }
      } catch (_) {}
    }

    // ═══ PERSONAL ACCOUNT screening instructions ═══
    let personalScreeningInstructions = '';
    if (resolvedClient && resolvedClient.account_type === 'personal') {
      const aiMode = resolvedClient.ai_response_mode || 'screen_all';
      const dndEnabled = resolvedClient.dnd_enabled || false;
      let isTrusted = false;
      let trustedName = '';
      try {
        const trustedContacts = await base44.entities.TrustedContact.filter({ client_id: resolvedClient.id });
        const match = trustedContacts.find(tc => tc.phone && tc.phone.replace(/\D/g, '').slice(-10) === last10);
        if (match) { isTrusted = true; trustedName = match.name || ''; }
      } catch (_) {}

      personalScreeningInstructions = '\n\n--- PERSONAL AI ASSISTANT MODE ---';
      if (aiMode === 'block_all') {
        personalScreeningInstructions += '\nMODE: BLOCK ALL. Politely tell the caller the owner is unavailable. End quickly.';
      } else if (aiMode === 'take_messages') {
        personalScreeningInstructions += '\nMODE: TAKE MESSAGES. Take a message from every caller.';
      } else if (aiMode === 'allow_contacts' && isTrusted) {
        personalScreeningInstructions += `\nMODE: ALLOW CONTACTS. Caller "${trustedName}" is TRUSTED. Be warm and helpful.`;
      } else if (aiMode === 'allow_contacts' && !isTrusted) {
        personalScreeningInstructions += '\nMODE: ALLOW CONTACTS (unknown). Screen this unknown caller carefully.';
      } else {
        personalScreeningInstructions += '\nMODE: SCREEN ALL. Screen this call. Classify as family/business/promotional/spam.';
        if (isTrusted) personalScreeningInstructions += ` NOTE: Known contact "${trustedName}".`;
      }
      if (dndEnabled) personalScreeningInstructions += '\nDND ON: Handle everything silently.';
      personalScreeningInstructions += '\nClassify call in your summary as family/business/promotional/spam/unknown.';
      console.log(`[smartfloInboundRouter] Personal mode: ${aiMode}, dnd=${dndEnabled}, trusted=${isTrusted}`);
    }

    // ─── PATH A: Lead calling back on a client's DID ───
    if (resolvedClient && resolvedAgent && matchedLead) {
      console.log(`[smartfloInboundRouter] LEAD CALLBACK: ${matchedLead.name} → DID ${calledDID} → Agent "${resolvedAgent.name}" → Client "${resolvedClient.company_name}"`);

      const existingLogs = await base44.entities.CallLog.filter({ client_id: resolvedClient.id }, '-created_date', 10);
      const cutoffMs = Date.now() - 120000;
      const existingInbound = existingLogs.find(l =>
        l.direction === 'inbound' &&
        new Date(l.created_date).getTime() > cutoffMs &&
        ((l.caller_id || '').replace(/\D/g, '').slice(-10) === last10 ||
         (l.callee_number || '').replace(/\D/g, '').slice(-10) === cleanDID)
      );

      if (existingInbound) {
        await base44.entities.CallLog.update(existingInbound.id, { call_sid: call_id, lead_id: matchedLead.id });
        console.log(`[smartfloInboundRouter] ✅ Found existing inbound CallLog ${existingInbound.id} — updated call_sid + lead_id`);
        await base44.entities.Lead.update(matchedLead.id, {
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString(),
          engagement_count: (matchedLead.engagement_count || 0) + 1
        });
        let earlyCallerName = matchedLead.name || '';
        if (!earlyCallerName) { try { const tc = await base44.entities.TrustedContact.filter({ client_id: resolvedClient.id }); const m = tc.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === last10); if (m?.name) earlyCallerName = m.name; } catch (_) {} }
        sendTelegramDirect(resolvedClient, { caller_number: incomingNumber, caller_name: earlyCallerName, category: 'business', summary: `Returning lead "${earlyCallerName || 'Unknown'}" is calling back.` });
        return c.json({ data: { early_return: true, http_status: 200, body: { success: true, identified: true, type: 'lead_callback', call_log_id: existingInbound.id, agent_name: resolvedAgent.name, lead_name: matchedLead.name, client_name: resolvedClient.company_name } } });
      }

      const leadCallLogs = await base44.entities.CallLog.filter({ lead_id: matchedLead.id });
      const recentLeadCalls = leadCallLogs
        .sort((a, b) => new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date))
        .slice(0, 3);

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
        `CRITICAL: This is an INBOUND callback. The customer is calling YOU back. Address them by name "${matchedLead.name || 'Sir/Madam'}". Be warm and acknowledge they are returning.`,
        recentLeadCalls.length > 0 ? `\nLAST CALL HISTORY:` : null,
        ...recentLeadCalls.map(c => `- ${c.direction} | ${c.status} | ${new Date(c.call_start_time || c.created_date).toLocaleDateString('en-IN')} | ${(c.conversation_summary || 'No summary').substring(0, 150)}`)
      ].filter(Boolean).join('\n');

      let personalizedPrompt = resolvedAgent.system_prompt || 'You are a helpful AI voice assistant.';
      personalizedPrompt += `\n\n--- INBOUND CALL - LEAD CONTEXT ---\n${leadContext}`;
      if (personalScreeningInstructions) personalizedPrompt += personalScreeningInstructions;

      let kbContent = '';
      if (resolvedAgent.knowledge_base_ids?.length > 0) {
        for (const kbId of resolvedAgent.knowledge_base_ids) {
          try { const doc = await base44.entities.KnowledgeBase.get(kbId); if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`; } catch (_) {}
        }
      }

      const inboundLog = await base44.entities.CallLog.create({
        client_id: resolvedClient.id, agent_id: resolvedAgent.id, lead_id: matchedLead.id,
        call_sid: call_id, caller_id: incomingNumber, callee_number: calledDID,
        direction: 'inbound', status: 'ringing', call_start_time: new Date().toISOString(),
        agent_config_cache: {
          agent_name: resolvedAgent.name, system_prompt: personalizedPrompt, persona: resolvedAgent.persona || {},
          knowledge_base_content: kbContent, lead_context: leadContext,
          greeting_message: resolvedAgent.greeting_message || '', human_transfer_number: resolvedAgent.human_transfer_number || '',
          enable_auto_transfer: resolvedAgent.enable_auto_transfer !== false
        }
      });

      await base44.entities.Lead.update(matchedLead.id, {
        last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString(),
        engagement_count: (matchedLead.engagement_count || 0) + 1
      });

      console.log(`[smartfloInboundRouter] ✅ Inbound CallLog ${inboundLog.id} created with Agent "${resolvedAgent.name}"`);

      let resolvedCallerName = matchedLead.name || '';
      if (!resolvedCallerName) {
        const cleanNum = incomingNumber.replace(/\D/g, '').slice(-10);
        const allTC = await base44.entities.TrustedContact.filter({ client_id: resolvedClient.id });
        const tcMatch = allTC.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === cleanNum);
        if (tcMatch?.name) resolvedCallerName = tcMatch.name;
      }
      sendTelegramDirect(resolvedClient, { caller_number: incomingNumber, caller_name: resolvedCallerName, category: 'business', summary: `Returning lead "${resolvedCallerName || 'Unknown'}" is calling back. Status: ${matchedLead.status || 'new'}, Score: ${matchedLead.score || 0}/100` });

      return c.json({ data: { early_return: true, http_status: 200, body: { success: true, identified: true, type: 'lead_callback', call_log_id: inboundLog.id, agent_name: resolvedAgent.name, lead_name: matchedLead.name, client_name: resolvedClient.company_name } } });
    }

    // ─── PATH B: Unknown caller on a client's DID ───
    if (resolvedClient && resolvedAgent && !matchedLead) {
      console.log(`[smartfloInboundRouter] NEW CALLER on client DID: ${incomingNumber} → Agent "${resolvedAgent.name}" → Client "${resolvedClient.company_name}"`);

      const existingLogs = await base44.entities.CallLog.filter({ client_id: resolvedClient.id }, '-created_date', 10);
      const cutoffMs = Date.now() - 120000;
      const existingInbound = existingLogs.find(l =>
        l.direction === 'inbound' &&
        new Date(l.created_date).getTime() > cutoffMs &&
        ((l.caller_id || '').replace(/\D/g, '').slice(-10) === last10 ||
         (l.callee_number || '').replace(/\D/g, '').slice(-10) === cleanDID)
      );

      if (existingInbound) {
        await base44.entities.CallLog.update(existingInbound.id, { call_sid: call_id });
        console.log(`[smartfloInboundRouter] ✅ Found existing inbound CallLog ${existingInbound.id} — updated call_sid`);
        let existingUnknownName = '';
        try { const tc3 = await base44.entities.TrustedContact.filter({ client_id: resolvedClient.id }); const m3 = tc3.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === last10); if (m3?.name) existingUnknownName = m3.name; } catch (_) {}
        sendTelegramDirect(resolvedClient, { caller_number: incomingNumber, caller_name: existingUnknownName, summary: existingUnknownName ? `${existingUnknownName} is calling.` : `New unknown caller from ${incomingNumber}. AI is screening the call.` });
        return c.json({ data: { early_return: true, http_status: 200, body: { success: true, identified: false, type: 'new_caller_on_client_did', call_log_id: existingInbound.id, agent_name: resolvedAgent.name, client_name: resolvedClient.company_name } } });
      }

      let personalizedPrompt = resolvedAgent.system_prompt || 'You are a helpful AI voice assistant.';
      personalizedPrompt += `\n\n--- INBOUND CALL - NEW CALLER ---\nThis is an INBOUND call from a NEW number (${incomingNumber}). This person is NOT in the lead database yet.\nIMPORTANT: Greet them professionally, identify their needs, and collect their name and contact details if possible.\nThis is the client's inbound line, so handle them as a potential customer for "${resolvedClient.company_name}".`;
      if (personalScreeningInstructions) personalizedPrompt += personalScreeningInstructions;

      let kbContent = '';
      if (resolvedAgent.knowledge_base_ids?.length > 0) {
        for (const kbId of resolvedAgent.knowledge_base_ids) {
          try { const doc = await base44.entities.KnowledgeBase.get(kbId); if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`; } catch (_) {}
        }
      }

      const inboundLog = await base44.entities.CallLog.create({
        client_id: resolvedClient.id, agent_id: resolvedAgent.id, call_sid: call_id,
        caller_id: incomingNumber, callee_number: calledDID, direction: 'inbound', status: 'ringing',
        call_start_time: new Date().toISOString(),
        agent_config_cache: {
          agent_name: resolvedAgent.name, system_prompt: personalizedPrompt, persona: resolvedAgent.persona || {},
          knowledge_base_content: kbContent, greeting_message: resolvedAgent.greeting_message || '',
          human_transfer_number: resolvedAgent.human_transfer_number || '', enable_auto_transfer: resolvedAgent.enable_auto_transfer !== false
        }
      });

      console.log(`[smartfloInboundRouter] ✅ Inbound CallLog ${inboundLog.id} created for new caller with Agent "${resolvedAgent.name}"`);

      let unknownCallerName = '';
      try {
        const cleanNum2 = incomingNumber.replace(/\D/g, '').slice(-10);
        const allTC2 = await base44.entities.TrustedContact.filter({ client_id: resolvedClient.id });
        const tcMatch2 = allTC2.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === cleanNum2);
        if (tcMatch2?.name) unknownCallerName = tcMatch2.name;
      } catch (_) {}
      sendTelegramDirect(resolvedClient, { caller_number: incomingNumber, caller_name: unknownCallerName, summary: unknownCallerName ? `${unknownCallerName} is calling.` : `New unknown caller from ${incomingNumber}. AI is screening the call.` });

      return c.json({ data: { early_return: true, http_status: 200, body: { success: true, identified: false, type: 'new_caller_on_client_did', call_log_id: inboundLog.id, agent_name: resolvedAgent.name, client_name: resolvedClient.company_name } } });
    }

    // ═══ STEP 3: Platform client check (deferred — only runs when PATH A/B
    // didn't match, so the common client-DID path skips these full scans). ═══
    const activeClients = await base44.entities.Client.filter({ status: 'active' });
    const trialClients = await base44.entities.Client.filter({ account_status: 'trial' });
    const expiredClients = await base44.entities.Client.filter({ account_status: 'expired' });
    const allClients = [...activeClients, ...trialClients, ...expiredClients];
    const matchedPlatformClient = allClients.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === last10);

    // ─── PATH C: Platform client calling VaaniAI's own DID ───
    // Create the CallLog instantly and run the heavy AI routing analysis OFF
    // the answer path (fire-and-forget inboundAiAnalyze) so the webhook
    // returns in milliseconds instead of waiting on the LLM.
    if (matchedPlatformClient) {
      console.log('[smartfloInboundRouter] PLATFORM CLIENT call:', matchedPlatformClient.company_name, matchedPlatformClient.account_status);

      const inboundLog = await base44.entities.CallLog.create({
        client_id: matchedPlatformClient.id, agent_id: 'system_inbound', call_sid: call_id,
        caller_id: incomingNumber, callee_number: calledDID, direction: 'inbound', status: 'answered',
        call_start_time: new Date().toISOString(),
        conversation_summary: `[INBOUND - PLATFORM CLIENT] ${matchedPlatformClient.company_name} | AI routing analysis in progress…`,
      });

      base44.functions.invoke('inboundAiAnalyze', {
        mode: 'platform', call_log_id: inboundLog.id, client_id: matchedPlatformClient.id,
        incomingNumber, calledDID
      }).catch(e => console.error('[smartfloInboundRouter] inboundAiAnalyze (platform) dispatch failed:', e.message));

      return c.json({ data: { early_return: true, http_status: 200, body: { success: true, identified: true, type: 'platform_client', call_log_id: inboundLog.id } } });
    }

    // ─── PATH D: Completely unknown caller ───
    // Same pattern — instant log, AI analysis runs in the background.
    console.log('[smartfloInboundRouter] UNKNOWN caller on DID:', calledDID);

    const unknownLog = await base44.entities.CallLog.create({
      client_id: 'unknown', agent_id: 'system_inbound', call_sid: call_id,
      caller_id: incomingNumber, callee_number: calledDID, direction: 'inbound', status: 'answered',
      call_start_time: new Date().toISOString(),
      conversation_summary: `[INBOUND - UNKNOWN] Number: ${incomingNumber} | AI routing analysis in progress…`,
    });

    base44.functions.invoke('inboundAiAnalyze', {
      mode: 'unknown', call_log_id: unknownLog.id, incomingNumber, calledDID
    }).catch(e => console.error('[smartfloInboundRouter] inboundAiAnalyze (unknown) dispatch failed:', e.message));

    return c.json({ data: { early_return: true, http_status: 200, body: { success: true, identified: false, type: 'unknown_caller', call_log_id: unknownLog.id } } });

  } catch (error) {
    console.error('[smartfloInboundRouter] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};