import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

// Map Smartflo call statuses to internal statuses
const STATUS_MAP = {
  'ringing': 'ringing',
  'answered': 'answered',
  'completed': 'completed',
  'failed': 'failed',
  'no_answer': 'no_answer',
  'busy': 'failed',
  'cancelled': 'failed'
};

Deno.serve(async (req) => {
  try {
    // For webhooks, use a service-role client directly (no user session available)
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

    console.log('[smartfloWebhook] Received:', JSON.stringify(payload).substring(0, 500));

    const { call_id, status, duration, recording_url, direction, caller_number, called_number } = payload;

    if (!call_id) {
      return Response.json({ success: false, error: 'Missing call_id' }, { status: 400 });
    }

    // ===== INCOMING CALL IDENTIFICATION & AI ROUTING =====
    if (direction === 'inbound' || payload.type === 'inbound') {
      const incomingNumber = caller_number || payload.from || payload.caller_id;
      console.log('[smartfloWebhook] Incoming call from:', incomingNumber);

      if (incomingNumber) {
        const cleanNumber = incomingNumber.replace(/\D/g, '');
        const last10 = cleanNumber.slice(-10);

        // Match caller to registered client by phone number
        // Filter by status to avoid loading cancelled clients, then match by last 10 digits
        const activeClients = await base44.entities.Client.filter({ status: 'active' });
        const trialClients = await base44.entities.Client.filter({ account_status: 'trial' });
        const expiredClients = await base44.entities.Client.filter({ account_status: 'expired' });
        const allClients = [...activeClients, ...trialClients, ...expiredClients];
        const matchedClient = allClients.find(c => {
          if (!c.phone) return false;
          return c.phone.replace(/\D/g, '').slice(-10) === last10;
        });

        // Load retention config
        const configs = await base44.entities.RetentionConfig.list('-created_date', 1);
        const retentionConfig = configs[0] || {};

        // ----- KNOWN CLIENT -----
        if (matchedClient) {
          console.log('[smartfloWebhook] Identified client:', matchedClient.company_name, matchedClient.account_status);

          // Gather full client context in parallel
          const [clientAgents, clientLeads, clientSubs, clientCallHistory, clientActivities] = await Promise.all([
            base44.entities.Agent.filter({ client_id: matchedClient.id }),
            base44.entities.Lead.filter({ client_id: matchedClient.id }),
            base44.entities.Subscription.filter({ client_id: matchedClient.id }),
            base44.entities.CallLog.filter({ client_id: matchedClient.id }),
            base44.entities.Activity.filter({ client_id: matchedClient.id }),
          ]);

          const recentCalls = clientCallHistory
            .sort((a, b) => new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date))
            .slice(0, 5);
          const activeSub = clientSubs.find(s => s.status === 'active');
          const pendingActivities = clientActivities.filter(a => a.status === 'scheduled');

          // AI: classify intent + generate personalized greeting
          const aiAnalysis = await base44.integrations.Core.InvokeLLM({
            prompt: `You are VaaniAI's intelligent call routing assistant. An incoming call has been received from a KNOWN registered client. Analyze their context and generate an appropriate response.

CALLER CONTEXT:
- Company: ${matchedClient.company_name}
- Industry: ${matchedClient.industry || 'General'}
- Account Status: ${matchedClient.account_status}
- Has Active Subscription: ${activeSub ? 'Yes (₹' + activeSub.total_amount + ')' : 'No'}
- Total Agents: ${clientAgents.length} (Active: ${clientAgents.filter(a => a.status === 'active').length})
- Total Leads: ${clientLeads.length}
- Recent Call Count: ${recentCalls.length}
- Pending Activities: ${pendingActivities.length}
- Has CRM: ${matchedClient.has_custom_crm ? 'Yes' : 'No'}
- Trial End Date: ${matchedClient.trial_end_date || 'N/A'}

RECENT CALL SUMMARIES:
${recentCalls.map(c => `- ${c.direction} | ${c.status} | ${c.conversation_summary || 'No summary'}`).join('\n') || 'No recent calls'}

${retentionConfig.active_offer ? `ACTIVE OFFER: ${retentionConfig.active_offer}${retentionConfig.offer_code ? ' (Code: ' + retentionConfig.offer_code + ')' : ''}` : ''}

${retentionConfig.custom_instructions ? `CUSTOM INSTRUCTIONS: ${retentionConfig.custom_instructions}` : ''}

Based on the context, determine:
1. The most likely INTENT of the call (sales_inquiry, support, billing, retention, feature_question, complaint, general)
2. The best ROUTING action (self_serve, retention_agent, support_team, sales_team, account_manager)
3. A warm, personalized GREETING acknowledging who they are
4. KEY CONTEXT the handling agent needs to know
5. SUGGESTED TALKING POINTS based on their situation

Be specific and Indian business context aware. If the account is expired, prioritize retention. If active, prioritize support/value.`,
            response_json_schema: {
              type: "object",
              properties: {
                intent: {
                  type: "string",
                  enum: ["sales_inquiry", "support", "billing", "retention", "feature_question", "complaint", "general"]
                },
                confidence: { type: "number" },
                routing: {
                  type: "string",
                  enum: ["self_serve", "retention_agent", "support_team", "sales_team", "account_manager"]
                },
                greeting: { type: "string" },
                agent_context: { type: "string" },
                talking_points: {
                  type: "array",
                  items: { type: "string" }
                },
                priority: {
                  type: "string",
                  enum: ["low", "medium", "high", "urgent"]
                },
                follow_up_needed: { type: "boolean" },
                follow_up_reason: { type: "string" }
              }
            }
          });

          console.log('[smartfloWebhook] AI Analysis - Intent:', aiAnalysis.intent, 'Routing:', aiAnalysis.routing, 'Priority:', aiAnalysis.priority);

          // Create detailed call log
          const inboundLog = await base44.entities.CallLog.create({
            client_id: matchedClient.id,
            agent_id: 'system_inbound',
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: called_number || payload.to || '',
            direction: 'inbound',
            status: 'answered',
            call_start_time: new Date().toISOString(),
            conversation_summary: `[INBOUND - IDENTIFIED] ${matchedClient.company_name} | Intent: ${aiAnalysis.intent} | Routed to: ${aiAnalysis.routing} | Priority: ${aiAnalysis.priority}\n\nGreeting: ${aiAnalysis.greeting}\n\nAgent Context: ${aiAnalysis.agent_context}\n\nTalking Points:\n${(aiAnalysis.talking_points || []).map(tp => '• ' + tp).join('\n')}`,
          });

          // Create activity with routing info
          await base44.entities.Activity.create({
            client_id: matchedClient.id,
            type: 'call',
            title: `Inbound: ${aiAnalysis.intent.replace('_', ' ')} — ${matchedClient.company_name}`,
            description: `Routed to: ${aiAnalysis.routing.replace('_', ' ')}. ${aiAnalysis.agent_context || ''}\n${aiAnalysis.follow_up_needed ? 'FOLLOW-UP NEEDED: ' + aiAnalysis.follow_up_reason : ''}`,
            scheduled_date: new Date().toISOString(),
            status: aiAnalysis.follow_up_needed ? 'scheduled' : 'completed',
            priority: aiAnalysis.priority === 'urgent' ? 'high' : aiAnalysis.priority || 'medium',
            auto_created: true,
          });

          // If follow-up needed, create a separate follow-up activity
          if (aiAnalysis.follow_up_needed) {
            const followUpDate = new Date();
            followUpDate.setDate(followUpDate.getDate() + 1);
            await base44.entities.Activity.create({
              client_id: matchedClient.id,
              type: 'followup',
              title: `Follow-up: ${aiAnalysis.follow_up_reason || aiAnalysis.intent}`,
              description: `Auto-created after inbound call. Original intent: ${aiAnalysis.intent}. Client: ${matchedClient.company_name}`,
              scheduled_date: followUpDate.toISOString(),
              status: 'scheduled',
              priority: 'high',
              auto_created: true,
            });
          }

          return Response.json({
            success: true,
            identified: true,
            call_log_id: inboundLog.id,
            greeting: aiAnalysis.greeting,
            routing: aiAnalysis.routing,
          });

        // ----- UNKNOWN CALLER -----
        } else {
          console.log('[smartfloWebhook] Unknown caller:', incomingNumber);

          // AI: handle unknown caller with general greeting + lead qualification
          const unknownAnalysis = await base44.integrations.Core.InvokeLLM({
            prompt: `You are VaaniAI's intelligent call routing assistant. An incoming call has been received from an UNKNOWN number (not a registered client).

Caller Number: ${incomingNumber}
${retentionConfig.active_offer ? `Active Offer: ${retentionConfig.active_offer}` : ''}

Generate:
1. A professional greeting for an unknown caller to VaaniAI
2. The most likely intent (new_lead, wrong_number, partner_inquiry, media, general)
3. Key qualifying questions to ask
4. Routing recommendation
5. Whether this should be flagged as a potential new lead

VaaniAI is an AI voice calling platform for Indian businesses. Pricing starts at ₹6,500/month per channel.`,
            response_json_schema: {
              type: "object",
              properties: {
                greeting: { type: "string" },
                likely_intent: {
                  type: "string",
                  enum: ["new_lead", "wrong_number", "partner_inquiry", "media", "general"]
                },
                qualifying_questions: {
                  type: "array",
                  items: { type: "string" }
                },
                routing: {
                  type: "string",
                  enum: ["sales_team", "support_team", "auto_response", "voicemail"]
                },
                is_potential_lead: { type: "boolean" },
                suggested_response: { type: "string" }
              }
            }
          });

          console.log('[smartfloWebhook] Unknown caller AI - Intent:', unknownAnalysis.likely_intent, 'Potential lead:', unknownAnalysis.is_potential_lead);

          // Log the unknown call
          const unknownLog = await base44.entities.CallLog.create({
            client_id: 'unknown',
            agent_id: 'system_inbound',
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: called_number || '',
            direction: 'inbound',
            status: 'answered',
            call_start_time: new Date().toISOString(),
            conversation_summary: `[INBOUND - UNIDENTIFIED] Number: ${incomingNumber} | Likely intent: ${unknownAnalysis.likely_intent} | Potential lead: ${unknownAnalysis.is_potential_lead ? 'YES' : 'No'} | Routed to: ${unknownAnalysis.routing}\n\nGreeting: ${unknownAnalysis.greeting}\n\nQualifying Questions:\n${(unknownAnalysis.qualifying_questions || []).map(q => '• ' + q).join('\n')}`,
          });

          // If potential lead, create a system-level activity for admin follow-up
          if (unknownAnalysis.is_potential_lead) {
            // Find any admin client record to attach the activity, or use first client
            const adminActivity = {
              client_id: allClients[0]?.id || 'system',
              type: 'call',
              title: `New inbound lead: ${incomingNumber}`,
              description: `Unknown caller identified as potential lead. Intent: ${unknownAnalysis.likely_intent}. Routed to: ${unknownAnalysis.routing}.\n\nSuggested response: ${unknownAnalysis.suggested_response || 'Standard sales pitch'}`,
              scheduled_date: new Date().toISOString(),
              status: 'scheduled',
              priority: 'high',
              auto_created: true,
            };
            await base44.entities.Activity.create(adminActivity);
          }

          return Response.json({
            success: true,
            identified: false,
            call_log_id: unknownLog.id,
            greeting: unknownAnalysis.greeting,
            routing: unknownAnalysis.routing,
          });
        }
      }
    }

    // ===== EXISTING OUTBOUND/STATUS UPDATE LOGIC =====
    const knownStatuses = ['ringing', 'answered', 'completed', 'failed', 'no_answer', 'busy', 'cancelled'];
    if (status && !knownStatuses.includes(status)) {
      console.warn('[smartfloWebhook] Unknown status:', status);
    }

    // Find call log by call_sid
    let callLogs = await base44.entities.CallLog.filter({ call_sid: call_id });

    // Fallback: if call_sid doesn't match (Smartflo often returns null call_id at originate time),
    // search by callee_number + recent ringing/initiated status
    if (callLogs.length === 0) {
      const calledNum = called_number || payload.to || '';
      const callerNum = caller_number || payload.from || '';
      // Try finding by the number that was called (outbound) — look at recent ringing/initiated calls
      const recentRinging = await base44.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 10);
      const recentInitiated = await base44.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 10);
      const allRecent = [...recentRinging, ...recentInitiated];
      
      // Match by callee_number (the number we called)
      const cleanCalledNum = (calledNum || '').replace(/\D/g, '').slice(-10);
      const cleanCallerNum = (callerNum || '').replace(/\D/g, '').slice(-10);
      
      for (const cl of allRecent) {
        const clCallee = (cl.callee_number || '').replace(/\D/g, '').slice(-10);
        const clCaller = (cl.caller_id || '').replace(/\D/g, '').slice(-10);
        // Match: same callee number AND same caller DID AND call is < 10 min old
        const callAge = Date.now() - new Date(cl.created_date).getTime();
        if (callAge < 10 * 60 * 1000 && clCallee && 
            (clCallee === cleanCalledNum || clCallee === cleanCallerNum) &&
            cl.call_sid?.startsWith('camp_')) {
          callLogs = [cl];
          // Update the call_sid to Smartflo's call_id for future webhook matching
          await base44.entities.CallLog.update(cl.id, { call_sid: call_id });
          console.log(`[smartfloWebhook] Matched by callee_number fallback: ${cl.id}, callee=${clCallee}, updated call_sid to ${call_id}`);
          break;
        }
      }
    }

    if (callLogs.length === 0) {
      console.log('[smartfloWebhook] Call log not found:', call_id, 'called_number:', called_number, 'caller_number:', caller_number);
      return Response.json({ success: true, message: 'Call log not found, but webhook received' });
    }

    const callLog = callLogs[0];
    const mappedStatus = STATUS_MAP[status] || status;

    // Idempotency guard: don't regress a terminal status
    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    if (terminalStatuses.includes(callLog.status) && !terminalStatuses.includes(mappedStatus)) {
      console.log(`[smartfloWebhook] Ignoring status ${status} — CallLog already terminal (${callLog.status})`);
      return Response.json({ success: true, message: 'Ignoring — call already terminal' });
    }

    // For non-terminal statuses (ringing, answered), do a simple update
    if (!['completed', 'no_answer', 'failed', 'busy', 'cancelled'].includes(status)) {
      const updateData = { status: mappedStatus };
      if (duration) updateData.duration = parseInt(duration);
      await base44.entities.CallLog.update(callLog.id, updateData);

      // Mark lead as contacted when answered
      if (callLog.lead_id && callLog.lead_id !== 'unknown' && status === 'answered') {
        await base44.entities.Lead.update(callLog.lead_id, { 
          status: 'contacted',
          last_call_date: new Date().toISOString()
        });
      }

      return Response.json({ success: true, message: 'Status updated' });
    }

    // ─── TERMINAL STATUSES: Do a SINGLE update with all data to trigger campaignPostCall once ───
    const terminalUpdate = {
      status: mappedStatus,
      call_end_time: new Date().toISOString()
    };
    if (duration) terminalUpdate.duration = parseInt(duration);
    if (recording_url) terminalUpdate.recording_url = recording_url;

    // For calls WITHOUT recording (no_answer, failed, busy, cancelled), add context immediately
    if (!recording_url) {
      const statusLabel = status === 'no_answer' ? 'No Answer' : status === 'busy' ? 'Busy' : status === 'cancelled' ? 'Cancelled' : 'Failed';
      terminalUpdate.conversation_summary = `Call ended: ${statusLabel}. No recording available.`;
      terminalUpdate.lead_status_updated = status === 'no_answer' ? 'no_answer' : 'callback';
    }

    // Make ONE update — this triggers campaignPostCall entity automation
    await base44.entities.CallLog.update(callLog.id, terminalUpdate);
    console.log(`[smartfloWebhook] Terminal update: ${status}, recording=${!!recording_url}`);

    // Update lead for no_answer
    if (callLog.lead_id && callLog.lead_id !== 'unknown' && (status === 'no_answer' || status === 'failed')) {
      await base44.entities.Lead.update(callLog.lead_id, { 
        status: 'callback',
        last_call_date: new Date().toISOString()
      });
    }

    // If recording available, process transcript (this makes its own CallLog update which
    // triggers campaignPostCall again — but the idempotency guard prevents double-processing)
    if (recording_url) {
      try {
        await base44.functions.invoke('processTranscript', {
          call_log_id: callLog.id,
          recording_url: recording_url
        });
        console.log('[smartfloWebhook] Transcript processing triggered');
      } catch (error) {
        console.error('[smartfloWebhook] Error triggering transcript:', error);
      }
    }

    return Response.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    console.error('[smartfloWebhook] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});