import { createClient } from 'npm:@base44/sdk@0.8.20';

// v3: Bypass Base44 automations — directly invoke post-call functions inline.
// This eliminates dependency on Base44 entity automations (which consume credits).
// Also replaced InvokeLLM with Azure OpenAI for inbound call analysis.

// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
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
      max_completion_tokens: 800,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// Map Smartflo call statuses to internal statuses
const STATUS_MAP = {
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

Deno.serve(async (req) => {
  try {
    // Use createClient with asServiceRole — same pattern as streamAudio which works
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    // Webhook authentication: verify shared secret (always required)
    const url = new URL(req.url);
    const webhookSecret = url.searchParams.get('secret');
    const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
    if (!expectedSecret || webhookSecret !== expectedSecret) {
      console.error('[smartfloWebhook] Invalid or missing webhook secret');
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Handle non-POST or empty body requests (health checks, GET pings)
    if (req.method === 'GET') {
      return Response.json({ success: true, message: 'Smartflo webhook is active' });
    }

    let payload;
    try {
      const bodyText = await req.text();
      if (!bodyText || bodyText.trim() === '') {
        return Response.json({ success: true, message: 'Empty body received, ignoring' });
      }
      payload = JSON.parse(bodyText);
    } catch (e) {
      console.error('[smartfloWebhook] Invalid JSON body:', e.message);
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Smartflo webhook field mapping: Smartflo sends call_status, caller_id_number, call_to_number, etc.
    // Normalize to our internal names
    const call_id = payload.call_id || payload.uuid;
    const status = payload.call_status || payload.status;
    const duration = payload.duration || payload.billsec;
    const recording_url = payload.recording_url;
    const direction = payload.direction;
    const caller_number = payload.caller_id_number || payload.caller_number || payload.from;
    const called_number = payload.call_to_number || payload.called_number || payload.to;
    const customer_number = payload.customer_no_with_prefix || payload.customer_number || '';
    const hangup_cause = payload.hangup_cause_description || payload.reason_key || '';
    const customer_ring_time = payload.customer_ring_time || '';

    console.log(`[smartfloWebhook] Received: status=${status}, call_id=${call_id}, direction=${direction}, caller=${caller_number}, callee=${called_number}, customer=${customer_number}, duration=${duration}, hangup=${hangup_cause}, ring_time=${customer_ring_time}`);

    if (!call_id) {
      return Response.json({ success: false, error: 'Missing call_id' }, { status: 400 });
    }

    // ===== INCOMING CALL IDENTIFICATION & AI ROUTING =====
    if (direction === 'inbound' || payload.type === 'inbound') {
      const incomingNumber = caller_number || payload.from || payload.caller_id;
      const calledDID = called_number || payload.to || payload.called_number || '';
      console.log(`[smartfloWebhook] Incoming call from: ${incomingNumber}, to DID: ${calledDID}`);

      if (incomingNumber) {
        const cleanNumber = incomingNumber.replace(/\D/g, '');
        const last10 = cleanNumber.slice(-10);
        const cleanDID = calledDID.replace(/\D/g, '').slice(-10);

        // ═══ STEP 1: Resolve DID → Agent → Client ═══
        // This is the PRIMARY resolution path for inbound calls.
        // When a customer calls back on a DID, we find which agent owns it.
        let resolvedAgent = null;
        let resolvedClient = null;
        let resolvedDID = null;

        if (cleanDID) {
          // Find the DID entity
          const allDIDs = await base44.entities.DID.list('-created_date', 200);
          resolvedDID = allDIDs.find(d => {
            const dNum = (d.number || '').replace(/\D/g, '').slice(-10);
            return dNum === cleanDID;
          });

          if (resolvedDID && resolvedDID.agent_id) {
            try {
              resolvedAgent = await base44.entities.Agent.get(resolvedDID.agent_id);
              console.log(`[smartfloWebhook] DID ${calledDID} → Agent "${resolvedAgent.name}" (${resolvedAgent.id})`);
            } catch (e) {
              console.warn(`[smartfloWebhook] Agent ${resolvedDID.agent_id} not found: ${e.message}`);
            }
          }

          if (resolvedDID && resolvedDID.client_id) {
            try {
              resolvedClient = await base44.entities.Client.get(resolvedDID.client_id);
              console.log(`[smartfloWebhook] DID ${calledDID} → Client "${resolvedClient.company_name}" (${resolvedClient.id})`);
            } catch (e) {
              console.warn(`[smartfloWebhook] Client ${resolvedDID.client_id} not found: ${e.message}`);
            }
          }
        }

        // Fallback: if DID not found, try agent's assigned_dids array
        if (!resolvedAgent && cleanDID) {
          const allAgents = await base44.entities.Agent.list('-created_date', 100);
          resolvedAgent = allAgents.find(a => {
            const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []);
            return dids.some(d => (d || '').replace(/\D/g, '').slice(-10) === cleanDID);
          });
          if (resolvedAgent) {
            console.log(`[smartfloWebhook] Fallback: DID ${calledDID} → Agent "${resolvedAgent.name}" via assigned_dids`);
            if (!resolvedClient && resolvedAgent.client_id) {
              try { resolvedClient = await base44.entities.Client.get(resolvedAgent.client_id); } catch (_) {}
            }
          }
        }

        // ═══ STEP 2: Identify the CALLER as a Lead (callback scenario) ═══
        let matchedLead = null;
        if (resolvedClient) {
          const clientLeads = await base44.entities.Lead.filter({ client_id: resolvedClient.id });
          matchedLead = clientLeads.find(l => {
            if (!l.phone) return false;
            return l.phone.replace(/\D/g, '').slice(-10) === last10;
          });
          if (matchedLead) {
            console.log(`[smartfloWebhook] Caller identified as Lead: "${matchedLead.name}" (${matchedLead.id}), status=${matchedLead.status}, score=${matchedLead.score}`);
          }
        }

        // ═══ STEP 3: Also check if caller is a platform client (owner calling support) ═══
        const activeClients = await base44.entities.Client.filter({ status: 'active' });
        const trialClients = await base44.entities.Client.filter({ account_status: 'trial' });
        const expiredClients = await base44.entities.Client.filter({ account_status: 'expired' });
        const allClients = [...activeClients, ...trialClients, ...expiredClients];
        const matchedPlatformClient = allClients.find(c => {
          if (!c.phone) return false;
          return c.phone.replace(/\D/g, '').slice(-10) === last10;
        });

        // Load retention config
        const configs = await base44.entities.RetentionConfig.list('-created_date', 1);
        const retentionConfig = configs[0] || {};

        // ═══════════════════════════════════════════════════════════════
        // PATH A: Lead calling back on a client's DID (most common inbound)
        // The AI agent assigned to this DID handles the call with lead context.
        // ═══════════════════════════════════════════════════════════════
        if (resolvedClient && resolvedAgent && matchedLead) {
          console.log(`[smartfloWebhook] LEAD CALLBACK: ${matchedLead.name} → DID ${calledDID} → Agent "${resolvedAgent.name}" → Client "${resolvedClient.company_name}"`);

          // Get last call history for this lead
          const leadCallLogs = await base44.entities.CallLog.filter({ lead_id: matchedLead.id });
          const recentLeadCalls = leadCallLogs
            .sort((a, b) => new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date))
            .slice(0, 3);

          // Build lead context for AI agent
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

          // Build personalized system prompt with lead context
          let personalizedPrompt = resolvedAgent.system_prompt || 'You are a helpful AI voice assistant.';
          personalizedPrompt += `\n\n--- INBOUND CALL - LEAD CONTEXT ---\n${leadContext}`;

          // Load knowledge base
          let kbContent = '';
          if (resolvedAgent.knowledge_base_ids?.length > 0) {
            for (const kbId of resolvedAgent.knowledge_base_ids) {
              try {
                const doc = await base44.entities.KnowledgeBase.get(kbId);
                if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
              } catch (_) {}
            }
          }

          // Create CallLog with agent_config_cache so streamAudio picks up the right agent
          const inboundLog = await base44.entities.CallLog.create({
            client_id: resolvedClient.id,
            agent_id: resolvedAgent.id,
            lead_id: matchedLead.id,
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: calledDID,
            direction: 'inbound',
            status: 'ringing',
            call_start_time: new Date().toISOString(),
            agent_config_cache: {
              agent_name: resolvedAgent.name,
              system_prompt: personalizedPrompt,
              persona: resolvedAgent.persona || {},
              knowledge_base_content: kbContent,
              lead_context: leadContext,
              greeting_message: resolvedAgent.greeting_message || '',
              human_transfer_number: resolvedAgent.human_transfer_number || '',
              enable_auto_transfer: resolvedAgent.enable_auto_transfer !== false
            }
          });

          // Update lead engagement
          await base44.entities.Lead.update(matchedLead.id, {
            last_call_date: new Date().toISOString(),
            last_engagement_date: new Date().toISOString(),
            engagement_count: (matchedLead.engagement_count || 0) + 1
          });

          console.log(`[smartfloWebhook] ✅ Inbound CallLog ${inboundLog.id} created with Agent "${resolvedAgent.name}" config cached for streamAudio`);

          return Response.json({
            success: true,
            identified: true,
            type: 'lead_callback',
            call_log_id: inboundLog.id,
            agent_name: resolvedAgent.name,
            lead_name: matchedLead.name,
            client_name: resolvedClient.company_name,
          });
        }

        // ═══════════════════════════════════════════════════════════════
        // PATH B: Unknown caller on a client's DID (new lead or wrong number)
        // Still route to the DID's assigned agent for the client's business context.
        // ═══════════════════════════════════════════════════════════════
        if (resolvedClient && resolvedAgent && !matchedLead) {
          console.log(`[smartfloWebhook] NEW CALLER on client DID: ${incomingNumber} → Agent "${resolvedAgent.name}" → Client "${resolvedClient.company_name}"`);

          let personalizedPrompt = resolvedAgent.system_prompt || 'You are a helpful AI voice assistant.';
          personalizedPrompt += `\n\n--- INBOUND CALL - NEW CALLER ---\nThis is an INBOUND call from a NEW number (${incomingNumber}). This person is NOT in the lead database yet.\nIMPORTANT: Greet them professionally, identify their needs, and collect their name and contact details if possible.\nThis is the client's inbound line, so handle them as a potential customer for "${resolvedClient.company_name}".`;

          let kbContent = '';
          if (resolvedAgent.knowledge_base_ids?.length > 0) {
            for (const kbId of resolvedAgent.knowledge_base_ids) {
              try {
                const doc = await base44.entities.KnowledgeBase.get(kbId);
                if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
              } catch (_) {}
            }
          }

          const inboundLog = await base44.entities.CallLog.create({
            client_id: resolvedClient.id,
            agent_id: resolvedAgent.id,
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: calledDID,
            direction: 'inbound',
            status: 'ringing',
            call_start_time: new Date().toISOString(),
            agent_config_cache: {
              agent_name: resolvedAgent.name,
              system_prompt: personalizedPrompt,
              persona: resolvedAgent.persona || {},
              knowledge_base_content: kbContent,
              greeting_message: resolvedAgent.greeting_message || '',
              human_transfer_number: resolvedAgent.human_transfer_number || '',
              enable_auto_transfer: resolvedAgent.enable_auto_transfer !== false
            }
          });

          console.log(`[smartfloWebhook] ✅ Inbound CallLog ${inboundLog.id} created for new caller with Agent "${resolvedAgent.name}"`);

          return Response.json({
            success: true,
            identified: false,
            type: 'new_caller_on_client_did',
            call_log_id: inboundLog.id,
            agent_name: resolvedAgent.name,
            client_name: resolvedClient.company_name,
          });
        }

        // ═══════════════════════════════════════════════════════════════
        // PATH C: Platform client calling VaaniAI's own DID (support/billing)
        // Original logic for identified platform clients.
        // ═══════════════════════════════════════════════════════════════
        if (matchedPlatformClient) {
          console.log('[smartfloWebhook] PLATFORM CLIENT call:', matchedPlatformClient.company_name, matchedPlatformClient.account_status);

          const [clientAgents, clientLeads, clientSubs, clientCallHistory, clientActivities] = await Promise.all([
            base44.entities.Agent.filter({ client_id: matchedPlatformClient.id }),
            base44.entities.Lead.filter({ client_id: matchedPlatformClient.id }),
            base44.entities.Subscription.filter({ client_id: matchedPlatformClient.id }),
            base44.entities.CallLog.filter({ client_id: matchedPlatformClient.id }),
            base44.entities.Activity.filter({ client_id: matchedPlatformClient.id }),
          ]);

          const recentCalls = clientCallHistory
            .sort((a, b) => new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date))
            .slice(0, 5);
          const activeSub = clientSubs.find(s => s.status === 'active');
          const pendingActivities = clientActivities.filter(a => a.status === 'scheduled');

          const aiAnalysis = await azureLLM(
            `You are VaaniAI's intelligent call routing assistant. An incoming call has been received from a KNOWN registered client on VaaniAI's platform DID.

CALLER CONTEXT:
- Company: ${matchedPlatformClient.company_name}
- Industry: ${matchedPlatformClient.industry || 'General'}
- Account Status: ${matchedPlatformClient.account_status}
- Has Active Subscription: ${activeSub ? 'Yes (₹' + activeSub.total_amount + ')' : 'No'}
- Total Agents: ${clientAgents.length} (Active: ${clientAgents.filter(a => a.status === 'active').length})
- Total Leads: ${clientLeads.length}
- Recent Call Count: ${recentCalls.length}
- Pending Activities: ${pendingActivities.length}
- Has CRM: ${matchedPlatformClient.has_custom_crm ? 'Yes' : 'No'}
- Trial End Date: ${matchedPlatformClient.trial_end_date || 'N/A'}

RECENT CALL SUMMARIES:
${recentCalls.map(c => `- ${c.direction} | ${c.status} | ${c.conversation_summary || 'No summary'}`).join('\n') || 'No recent calls'}

${retentionConfig.active_offer ? `ACTIVE OFFER: ${retentionConfig.active_offer}${retentionConfig.offer_code ? ' (Code: ' + retentionConfig.offer_code + ')' : ''}` : ''}
${retentionConfig.custom_instructions ? `CUSTOM INSTRUCTIONS: ${retentionConfig.custom_instructions}` : ''}

Determine: intent, routing, greeting, agent_context, talking_points, priority, follow_up_needed, follow_up_reason.
Respond with JSON.`,
            'You are VaaniAI call routing AI. Always respond in valid JSON.',
            {
              type: "object",
              properties: {
                intent: { type: "string" }, confidence: { type: "number" },
                routing: { type: "string" }, greeting: { type: "string" },
                agent_context: { type: "string" },
                talking_points: { type: "array", items: { type: "string" } },
                priority: { type: "string" },
                follow_up_needed: { type: "boolean" }, follow_up_reason: { type: "string" }
              }
            }
          );

          console.log('[smartfloWebhook] Platform client AI - Intent:', aiAnalysis.intent, 'Routing:', aiAnalysis.routing);

          const inboundLog = await base44.entities.CallLog.create({
            client_id: matchedPlatformClient.id,
            agent_id: 'system_inbound',
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: calledDID,
            direction: 'inbound',
            status: 'answered',
            call_start_time: new Date().toISOString(),
            conversation_summary: `[INBOUND - PLATFORM CLIENT] ${matchedPlatformClient.company_name} | Intent: ${aiAnalysis.intent} | Routed to: ${aiAnalysis.routing} | Priority: ${aiAnalysis.priority}\n\nGreeting: ${aiAnalysis.greeting}\n\nAgent Context: ${aiAnalysis.agent_context}`,
          });

          await base44.entities.Activity.create({
            client_id: matchedPlatformClient.id,
            type: 'call',
            title: `Inbound: ${aiAnalysis.intent.replace('_', ' ')} — ${matchedPlatformClient.company_name}`,
            description: `Routed to: ${aiAnalysis.routing.replace('_', ' ')}. ${aiAnalysis.agent_context || ''}`,
            scheduled_date: new Date().toISOString(),
            status: aiAnalysis.follow_up_needed ? 'scheduled' : 'completed',
            priority: aiAnalysis.priority === 'urgent' ? 'high' : aiAnalysis.priority || 'medium',
            auto_created: true,
          });

          if (aiAnalysis.follow_up_needed) {
            const followUpDate = new Date();
            followUpDate.setDate(followUpDate.getDate() + 1);
            await base44.entities.Activity.create({
              client_id: matchedPlatformClient.id,
              type: 'followup',
              title: `Follow-up: ${aiAnalysis.follow_up_reason || aiAnalysis.intent}`,
              description: `Auto-created after inbound platform call.`,
              scheduled_date: followUpDate.toISOString(),
              status: 'scheduled',
              priority: 'high',
              auto_created: true,
            });
          }

          return Response.json({
            success: true,
            identified: true,
            type: 'platform_client',
            call_log_id: inboundLog.id,
            greeting: aiAnalysis.greeting,
            routing: aiAnalysis.routing,
          });
        }

        // ═══════════════════════════════════════════════════════════════
        // PATH D: Completely unknown caller on unknown/platform DID
        // ═══════════════════════════════════════════════════════════════
        console.log('[smartfloWebhook] UNKNOWN caller on DID:', calledDID);

        const unknownAnalysis = await azureLLM(
          `You are VaaniAI's call routing assistant. Unknown caller on number ${incomingNumber}.
${retentionConfig.active_offer ? `Active Offer: ${retentionConfig.active_offer}` : ''}
VaaniAI is an AI voice calling platform for Indian businesses. Pricing starts at ₹6,500/month.
Generate: greeting, likely_intent, qualifying_questions, routing, is_potential_lead, suggested_response.`,
          'You are VaaniAI call routing AI. Always respond in valid JSON.',
          {
            type: "object",
            properties: {
              greeting: { type: "string" }, likely_intent: { type: "string" },
              qualifying_questions: { type: "array", items: { type: "string" } },
              routing: { type: "string" }, is_potential_lead: { type: "boolean" },
              suggested_response: { type: "string" }
            }
          }
        );

        const unknownLog = await base44.entities.CallLog.create({
          client_id: 'unknown',
          agent_id: 'system_inbound',
          call_sid: call_id,
          caller_id: incomingNumber,
          callee_number: calledDID,
          direction: 'inbound',
          status: 'answered',
          call_start_time: new Date().toISOString(),
          conversation_summary: `[INBOUND - UNKNOWN] Number: ${incomingNumber} | Intent: ${unknownAnalysis.likely_intent} | Potential lead: ${unknownAnalysis.is_potential_lead ? 'YES' : 'No'}`,
        });

        if (unknownAnalysis.is_potential_lead) {
          await base44.entities.Activity.create({
            client_id: allClients[0]?.id || 'system',
            type: 'call',
            title: `New inbound lead: ${incomingNumber}`,
            description: `Unknown caller. Intent: ${unknownAnalysis.likely_intent}. ${unknownAnalysis.suggested_response || ''}`,
            scheduled_date: new Date().toISOString(),
            status: 'scheduled',
            priority: 'high',
            auto_created: true,
          });
        }

        return Response.json({
          success: true,
          identified: false,
          type: 'unknown_caller',
          call_log_id: unknownLog.id,
          greeting: unknownAnalysis.greeting,
          routing: unknownAnalysis.routing,
        });
      }
    }

    // ===== EXISTING OUTBOUND/STATUS UPDATE LOGIC =====
    const knownStatuses = ['ringing', 'answered', 'completed', 'failed', 'no_answer', 'busy', 'cancelled', 'missed', 'not_connected'];
    if (status && !knownStatuses.includes(status)) {
      console.warn('[smartfloWebhook] Unknown status:', status);
    }

    // Find call log by call_sid — try multiple ID formats
    let callLogs = await base44.entities.CallLog.filter({ call_sid: call_id });

    // Fallback: if Smartflo sends a different ID format, try matching by phone number
    if (callLogs.length === 0) {
      // Collect all phone numbers from webhook payload for matching
      const phoneHints = [called_number, caller_number, customer_number, payload.customer_number].filter(Boolean);
      if (phoneHints.length > 0) {
        console.log(`[smartfloWebhook] No match for call_sid=${call_id}, trying phone fallback with: ${phoneHints.join(', ')}`);
        
        // Look for recent calls (last 5 min) across ringing, initiated, and answered statuses
        const [ringingLogs, initiatedLogs, answeredLogs] = await Promise.all([
          base44.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 20),
          base44.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 20),
          base44.entities.CallLog.filter({ status: 'answered' }, '-created_date', 20)
        ]);
        const allRecent = [...ringingLogs, ...initiatedLogs, ...answeredLogs];
        const cutoff = Date.now() - 5 * 60 * 1000;
        
        const match = allRecent.find(l => {
          if (new Date(l.created_date).getTime() < cutoff) return false;
          const logCallee = (l.callee_number || '').replace(/\D/g, '').slice(-10);
          if (!logCallee) return false;
          return phoneHints.some(hint => {
            const hintClean = hint.replace(/\D/g, '').slice(-10);
            return hintClean && logCallee === hintClean;
          });
        });
        
        if (match) {
          callLogs = [match];
          await base44.entities.CallLog.update(match.id, { call_sid: call_id });
          console.log(`[smartfloWebhook] Matched by phone number: CallLog ${match.id} (callee=${match.callee_number}), updated call_sid to ${call_id}`);
        }
      }
    }

    if (callLogs.length === 0) {
      console.log('[smartfloWebhook] Call log not found:', call_id);
      return Response.json({ success: true, message: 'Call log not found, but webhook received' });
    }

    const callLog = callLogs[0];
    const mappedStatus = STATUS_MAP[status] || status;

    // Idempotency guard: don't regress a terminal status
    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    if (terminalStatuses.includes(callLog.status)) {
      if (!terminalStatuses.includes(mappedStatus)) {
        console.log(`[smartfloWebhook] Ignoring status ${status} — CallLog already terminal (${callLog.status})`);
        return Response.json({ success: true, message: 'Ignoring — call already terminal' });
      }
      // Also skip if already same terminal status
      if (callLog.status === mappedStatus) {
        console.log(`[smartfloWebhook] Ignoring duplicate terminal ${status}`);
        return Response.json({ success: true, message: 'Ignoring — duplicate terminal' });
      }
    }

    // CRITICAL FIX: Smartflo sometimes sends "answered" with hangup_cause + duration
    // as the FINAL webhook (never sends a separate "completed" event).
    // Detect this: if status is "answered" but hangup_cause is present, the call is actually done.
    let effectiveStatus = mappedStatus;
    if (mappedStatus === 'answered' && hangup_cause && parseInt(duration) > 0) {
      console.log(`[smartfloWebhook] Detected "answered" with hangup_cause="${hangup_cause}" + duration=${duration} — treating as COMPLETED`);
      effectiveStatus = 'completed';
    }

    const updateData = { status: effectiveStatus };
    if (duration) updateData.duration = parseInt(duration);
    if (recording_url) updateData.recording_url = recording_url;
    if (effectiveStatus === 'completed') updateData.call_end_time = new Date().toISOString();

    await base44.entities.CallLog.update(callLog.id, updateData);

    // If this webhook delivers a recording_url for an already-completed transferred call,
    // trigger the full recording analysis now (the terminal-status block below may have already fired)
    if (recording_url && callLog.transferred_to && terminalStatuses.includes(callLog.status)) {
      console.log(`[smartfloWebhook] Recording URL arrived for already-completed transferred call ${callLog.id} — triggering analysis`);
      base44.functions.invoke('processTransferRecording', { call_log_id: callLog.id })
        .then(() => console.log(`[smartfloWebhook] processTransferRecording triggered (late recording)`))
        .catch(e => console.error(`[smartfloWebhook] processTransferRecording (late) failed: ${e.message}`));
    }

    // NOTE: Lead status updates are handled EXCLUSIVELY by campaignPostCall (for campaign calls)
    // or streamAudio.saveCallRecord (for answered calls with transcripts).
    // smartfloWebhook only updates CallLog to avoid race conditions.

    // Handle terminal call statuses
    if (effectiveStatus === 'completed' || effectiveStatus === 'no_answer' || effectiveStatus === 'failed') {
      // Set end time
      if (!updateData.call_end_time) {
        updateData.call_end_time = new Date().toISOString();
        await base44.entities.CallLog.update(callLog.id, { call_end_time: new Date().toISOString() });
      }

      // WebSocket-only approach: transcripts are captured by streamAudio in real-time.
      // No recording_url processing needed. For calls that ended without WebSocket
      // (no_answer, failed, busy, cancelled), add a status summary so campaignPostCall
      // entity automation can process them.
      if (effectiveStatus === 'no_answer' || effectiveStatus === 'failed') {
        const statusLabel = status; // preserve original Smartflo status for clarity
        // Only update summary if streamAudio hasn't already saved one
        const freshLog = await base44.entities.CallLog.get(callLog.id);
        if (!freshLog.transcript) {
          // For no-answer: set lead_status_updated to 'no_answer' — processTranscript/campaignPostCall
          // will preserve the lead's existing score and status when they see this
          await base44.entities.CallLog.update(callLog.id, {
            conversation_summary: `Call ended: ${statusLabel}${hangup_cause ? ' (' + hangup_cause + ')' : ''}${customer_ring_time ? '. Customer rang for ' + customer_ring_time + 's' : ''}. No conversation captured.`,
            lead_status_updated: 'no_answer'
          });
          console.log(`[smartfloWebhook] Terminal ${statusLabel} (effective: ${effectiveStatus}) — updated for campaign processing`);
        } else {
          console.log(`[smartfloWebhook] Terminal ${statusLabel} — WebSocket transcript already present, skipping summary override`);
        }

        // NOTE: CampaignLead updates are handled EXCLUSIVELY by campaignPostCall entity automation
        // which triggers when this CallLog update is saved. No direct CampaignLead writes here
        // to avoid race conditions with campaignPostCall doing the same update.
      }

      // NOTE: For answered+completed calls, streamAudio's saveCallRecord handles
      // transcript, summary, AI scoring, activities, and sequence enrollment.

      // ═══════════════════════════════════════════════════════════════════
      // DIRECT INVOCATION: Bypass entity automations (saves Base44 credits)
      // Previously, updating CallLog would trigger entity automations for
      // campaignPostCall and postCallFollowup. Now we call them directly.
      // ═══════════════════════════════════════════════════════════════════
      
      // Re-read fresh CallLog to pass complete data
      const freshCallLog = await base44.entities.CallLog.get(callLog.id);
      
      // 1. Campaign post-call processing — handles lead progression + triggers next call
      //    IMPORTANT: We do this INLINE instead of via functions.invoke() because:
      //    - functions.invoke() adds latency and can timeout
      //    - Service-role clients can't always invoke functions reliably
      //    - Inline execution ensures the next call triggers immediately
      try {
        console.log(`[smartfloWebhook] Processing campaign post-call for CallLog ${callLog.id}`);
        
        // Check if this is a campaign call
        const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: callLog.id });
        
        if (campaignLeads.length > 0) {
          const campaignLead = campaignLeads[0];
          
          // Skip if already processed
          if (!['calling'].includes(campaignLead.status)) {
            console.log(`[smartfloWebhook] CampaignLead ${campaignLead.id} already ${campaignLead.status} — skipping`);
          } else {
            // Lock it
            await base44.entities.CampaignLead.update(campaignLead.id, { status: 'processing' });
            
            // Wait briefly for streamAudio to finish saving transcript
            // (streamAudio may still be writing when Smartflo fires the webhook)
            await new Promise(r => setTimeout(r, 2000));
            
            // Re-read CallLog to get latest data (streamAudio may have updated it)
            const latestCallLog = await base44.entities.CallLog.get(callLog.id);
            
            // Determine basic outcome (fast, no LLM)
            let outcome = 'neutral';
            let clCallStatus = 'answered';
            let clSummary = latestCallLog.conversation_summary || '';
            
            if (latestCallLog.status === 'no_answer' || freshCallLog.status === 'no_answer') {
              outcome = 'not_answered'; clCallStatus = 'not_answered';
              clSummary = clSummary || 'Call was not answered.';
            } else if (latestCallLog.status === 'failed' || freshCallLog.status === 'failed') {
              outcome = 'not_answered'; clCallStatus = 'not_answered';
              clSummary = clSummary || 'Call failed to connect.';
            } else if (latestCallLog.lead_status_updated) {
              // streamAudio already analyzed — map its outcome
              const statusToOutcome = {
                'interested': 'interested', 'not_interested': 'not_interested', 'callback': 'callback',
                'no_answer': 'not_answered', 'converted': 'converted', 'contacted': 'neutral', 'do_not_call': 'do_not_call'
              };
              outcome = statusToOutcome[latestCallLog.lead_status_updated] || 'neutral';
              clSummary = latestCallLog.conversation_summary || clSummary;
            }
            
            // Mark completed — include transcript/recording from latest CallLog
            await base44.entities.CampaignLead.update(campaignLead.id, {
              status: 'completed', outcome, call_status: clCallStatus,
              conversation_summary: clSummary,
              transcript: latestCallLog.transcript || '',
              call_duration: latestCallLog.duration || parseInt(duration) || 0
            });
            console.log(`[smartfloWebhook] CampaignLead ${campaignLead.lead_name} → ${outcome}`);
            
            // Handle no-answer retry — do NOT change lead status/score for unanswered calls
            if (outcome === 'not_answered') {
              // Only update engagement metadata on the lead, preserve status/score
              if (campaignLead.lead_id) {
                try {
                  await base44.entities.Lead.update(campaignLead.lead_id, {
                    last_call_date: new Date().toISOString(),
                    last_engagement_date: new Date().toISOString()
                  });
                  console.log(`[smartfloWebhook] Lead ${campaignLead.lead_id} — not_answered, preserved existing status/score`);
                } catch (_) {}
              }
              
              const campaign = await base44.entities.Campaign.get(campaignLead.campaign_id);
              const rules = campaign?.followup_rules || {};
              if (rules.no_answer_retry !== false) {
                const maxRetries = rules.no_answer_max_retries || 3;
                const currentAttempts = (campaignLead.attempt_count || 0) + 1;
                if (currentAttempts < maxRetries) {
                  const retryHours = rules.no_answer_retry_hours || 4;
                  await base44.entities.CampaignLead.update(campaignLead.id, {
                    status: 'pending', outcome: 'not_answered',
                    attempt_count: currentAttempts, call_log_id: null,
                    followup_call_date: new Date(Date.now() + retryHours * 3600000).toISOString()
                  });
                  console.log(`[smartfloWebhook] No-answer retry ${currentAttempts}/${maxRetries} queued`);
                }
              }
            }
            
            // TRIGGER NEXT CALL IMMEDIATELY (inline — no function invoke)
            await triggerNextCampaignCall(base44, campaignLead.campaign_id);
            
            // Update campaign stats
            const allCLs = await base44.entities.CampaignLead.filter({ campaign_id: campaignLead.campaign_id });
            const outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
            allCLs.forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
            const completedCount = allCLs.filter(l => l.status === 'completed').length;
            const failedCount = allCLs.filter(l => l.status === 'failed').length;
            await base44.entities.Campaign.update(campaignLead.campaign_id, {
              outcomes_summary: outcomes, calls_completed: completedCount, calls_failed: failedCount
            });
          }
        } else {
          console.log(`[smartfloWebhook] Not a campaign call — skipping campaign processing`);
        }
        
        // Invoke campaignPostCall for SLOW AI analysis (emails, scoring, sequences)
        // This runs async — next call is already triggered above
        try {
          base44.functions.invoke('campaignPostCall', {
            event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
            data: freshCallLog,
            old_data: { ...freshCallLog, status: callLog.status }
          }).catch(e => console.error(`[smartfloWebhook] campaignPostCall async failed: ${e.message}`));
        } catch (_) {}
        
      } catch (pcErr) {
        console.error(`[smartfloWebhook] Campaign processing failed: ${pcErr.message}`);
      }

      // 2. Invoke postCallFollowup — handles email/RCS outreach for non-campaign calls
      try {
        console.log(`[smartfloWebhook] Direct-invoking postCallFollowup for CallLog ${callLog.id}`);
        const followupResult = await base44.functions.invoke('postCallFollowup', {
          event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
          data: freshCallLog,
          old_data: { ...freshCallLog, status: callLog.status }
        });
        console.log(`[smartfloWebhook] postCallFollowup result:`, JSON.stringify(followupResult?.data || followupResult).substring(0, 300));
      } catch (pfErr) {
        console.error(`[smartfloWebhook] postCallFollowup invoke failed: ${pfErr.message}`);
      }

      // 3. Invoke postCallActionExtractor — extracts action items from transcripts
      if (freshCallLog.transcript && freshCallLog.transcript.length > 50) {
        try {
          console.log(`[smartfloWebhook] Direct-invoking postCallActionExtractor for CallLog ${callLog.id}`);
          await base44.functions.invoke('postCallActionExtractor', {
            event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
            data: freshCallLog,
            old_data: { ...freshCallLog, transcript: null }
          });
        } catch (aeErr) {
          console.error(`[smartfloWebhook] postCallActionExtractor invoke failed: ${aeErr.message}`);
        }
      }

      // 4. Invoke crmAutomation — creates follow-up tasks on call completion
      try {
        console.log(`[smartfloWebhook] Direct-invoking crmAutomation for CallLog ${callLog.id}`);
        await base44.functions.invoke('crmAutomation', {
          event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
          data: freshCallLog,
          old_data: { ...freshCallLog, status: callLog.status }
        });
      } catch (crmErr) {
        console.error(`[smartfloWebhook] crmAutomation invoke failed: ${crmErr.message}`);
      }

      // 5. For TRANSFERRED calls: fetch full Smartflo recording and re-analyze
      // Smartflo records the entire call (AI + human portions).
      // The WebSocket only captured the pre-transfer AI transcript.
      // This re-analyzes with the full recording to get the real outcome.
      if (freshCallLog.transferred_to && freshCallLog.recording_url) {
        console.log(`[smartfloWebhook] Transferred call detected with recording — triggering full recording analysis`);
        // Delay 10s to ensure Smartflo recording is fully processed/available
        setTimeout(async () => {
          try {
            await base44.functions.invoke('processTransferRecording', {
              call_log_id: callLog.id
            });
            console.log(`[smartfloWebhook] processTransferRecording triggered for ${callLog.id}`);
          } catch (trErr) {
            console.error(`[smartfloWebhook] processTransferRecording failed: ${trErr.message}`);
          }
        }, 10000);
      } else if (freshCallLog.transferred_to && !freshCallLog.recording_url) {
        console.log(`[smartfloWebhook] Transferred call but no recording_url yet — recording may arrive in a later webhook`);
      }
    }

    return Response.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    console.error('[smartfloWebhook] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});


// ═══════════════════════════════════════════════════════════════════
// INLINE: Trigger next campaign call immediately after current completes.
// This avoids the delay of waiting for campaignPoller cron.
// ═══════════════════════════════════════════════════════════════════
async function triggerNextCampaignCall(base44, campaignId) {
  try {
    const campaign = await base44.entities.Campaign.get(campaignId);
    if (!campaign || campaign.status !== 'running') {
      console.log(`[smartfloWebhook] Campaign ${campaignId} not running (${campaign?.status})`);
      return;
    }

    const now = new Date();
    const allLeads = await base44.entities.CampaignLead.filter({ campaign_id: campaignId }, 'created_date', 1000);
    const callingLeads = allLeads.filter(l => l.status === 'calling');
    const pendingLeads = allLeads.filter(l => l.status === 'pending');
    const processingLeads = allLeads.filter(l => l.status === 'processing');
    const maxConcurrent = campaign.max_concurrent_calls || 5;

    const readyPending = pendingLeads.filter(l => !l.followup_call_date || new Date(l.followup_call_date) <= now);
    const retryLaterPending = pendingLeads.filter(l => l.followup_call_date && new Date(l.followup_call_date) > now);

    // Check if campaign should complete
    if (readyPending.length === 0 && callingLeads.length === 0 && retryLaterPending.length === 0 && processingLeads.length === 0) {
      const completedCount = allLeads.filter(l => l.status === 'completed').length;
      const failedCount = allLeads.filter(l => l.status === 'failed').length;
      await base44.entities.Campaign.update(campaignId, {
        status: 'completed', completed_at: now.toISOString(),
        calls_completed: completedCount, calls_failed: failedCount
      });
      console.log(`[smartfloWebhook] Campaign "${campaign.name}" completed`);
      return;
    }

    const slotsAvailable = Math.max(0, maxConcurrent - callingLeads.length);
    if (slotsAvailable === 0 || readyPending.length === 0) {
      console.log(`[smartfloWebhook] No slots (${callingLeads.length}/${maxConcurrent}) or no ready leads (${readyPending.length})`);
      return;
    }

    // Get agent + DIDs
    const agent = await base44.entities.Agent.get(campaign.agent_id);
    const agentDIDs = (agent?.assigned_dids?.length > 0)
      ? agent.assigned_dids : (agent?.assigned_did ? [agent.assigned_did] : []);
    if (!agent || agentDIDs.length === 0) {
      console.log(`[smartfloWebhook] No agent/DIDs for campaign`);
      return;
    }

    // Knowledge base
    let kbContent = '';
    if (agent.knowledge_base_ids?.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.entities.KnowledgeBase.get(kbId);
          if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
        } catch (_) {}
      }
    }

    // Pick the next lead
    const cl = readyPending[0];
    const freshCL = await base44.entities.CampaignLead.get(cl.id);
    if (freshCL.status !== 'pending') {
      console.log(`[smartfloWebhook] Lead ${cl.lead_name} already ${freshCL.status} — race avoided`);
      return;
    }

    const selectedDID = agentDIDs[0];
    await base44.entities.CampaignLead.update(cl.id, {
      status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
    });

    const cleanPhone = (cl.lead_phone || '').replace(/[^0-9]/g, '');
    const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // Build lead context
    let leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
    try {
      if (cl.lead_id) {
        const lead = await base44.entities.Lead.get(cl.lead_id);
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

    const newCallLog = await base44.entities.CallLog.create({
      client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
      call_sid: callSid, caller_id: selectedDID, callee_number: cl.lead_phone,
      direction: 'outbound', status: 'initiated', call_start_time: now.toISOString(),
      agent_config_cache: {
        agent_name: agent.name, system_prompt: personalizedPrompt,
        persona: agent.persona || {}, knowledge_base_content: kbContent,
        lead_context: leadContext, greeting_message: agent.greeting_message || '',
        human_transfer_number: agent.human_transfer_number || '',
        enable_auto_transfer: agent.enable_auto_transfer !== false
      }
    });

    await base44.entities.CampaignLead.update(cl.id, { call_log_id: newCallLog.id });

    // Smartflo API call
    let smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    try {
      const clientData = await base44.entities.Client.get(campaign.client_id);
      if (clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding')) {
        smartfloApiKey = Deno.env.get('SMARTFLO_API_KEY');
      }
    } catch (_) {}

    const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: smartfloApiKey,
        customer_number: cleanPhone,
        caller_id: selectedDID.replace(/^\+/, ''),
        async: 1
      })
    });

    const smartfloData = await smartfloResp.json();
    if (smartfloResp.ok && smartfloData.success !== false) {
      const newCallSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id || callSid;
      await base44.entities.CallLog.update(newCallLog.id, { call_sid: newCallSid, status: 'ringing' });
      console.log(`[smartfloWebhook] ✅ Next call initiated: ${cl.lead_name} → ${cleanPhone}`);
    } else {
      await base44.entities.CallLog.update(newCallLog.id, { status: 'failed' });
      await base44.entities.CampaignLead.update(cl.id, {
        status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
        conversation_summary: `Smartflo error: ${smartfloData.message || 'Unknown'}`
      });
      console.error(`[smartfloWebhook] Next call failed: ${smartfloData.message}`);
    }
  } catch (err) {
    console.error(`[smartfloWebhook] triggerNextCampaignCall error: ${err.message}`);
  }
}