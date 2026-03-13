import { createClient } from 'npm:@base44/sdk@0.8.20';

// Map Smartflo call statuses to internal statuses
// Smartflo webhook sends statuses like "Answered", "Missed", "completed" etc.
const STATUS_MAP = {
  'ringing': 'ringing',
  'answered': 'completed',
  'Answered': 'completed',
  'completed': 'completed',
  'Completed': 'completed',
  'missed': 'no_answer',
  'Missed': 'no_answer',
  'failed': 'failed',
  'Failed': 'failed',
  'no_answer': 'no_answer',
  'No Answer': 'no_answer',
  'busy': 'failed',
  'Busy': 'failed',
  'cancelled': 'failed',
  'Cancelled': 'failed',
  'not_connected': 'no_answer',
  'Not Connected': 'no_answer'
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

    // Find call log by call_sid — try multiple ID formats
    let callLogs = await base44.entities.CallLog.filter({ call_sid: call_id });

    // Fallback: if Smartflo sends a different ID format, try matching by phone number
    if (callLogs.length === 0) {
      // Collect all phone numbers from webhook payload for matching
      const phoneHints = [called_number, caller_number, customer_number, payload.customer_number].filter(Boolean);
      if (phoneHints.length > 0) {
        console.log(`[smartfloWebhook] No match for call_sid=${call_id}, trying phone fallback with: ${phoneHints.join(', ')}`);
        
        // Look for recent calls (last 5 min) across ringing and initiated statuses
        const [ringingLogs, initiatedLogs] = await Promise.all([
          base44.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 20),
          base44.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 20)
        ]);
        const allRecent = [...ringingLogs, ...initiatedLogs];
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
    if (terminalStatuses.includes(callLog.status) && !terminalStatuses.includes(mappedStatus)) {
      console.log(`[smartfloWebhook] Ignoring status ${status} — CallLog already terminal (${callLog.status})`);
      return Response.json({ success: true, message: 'Ignoring — call already terminal' });
    }

    const updateData = { status: mappedStatus };
    if (duration) updateData.duration = parseInt(duration);
    if (recording_url) updateData.recording_url = recording_url;
    if (status === 'completed') updateData.call_end_time = new Date().toISOString();

    await base44.entities.CallLog.update(callLog.id, updateData);

    // Update lead status based on call outcome (only for outbound client calls with valid lead_id)
    // Note: For 'answered' we just mark 'contacted' — the real outcome is set later 
    // by processTranscript → campaignPostCall after AI analyzes the conversation
    if (callLog.lead_id && callLog.lead_id !== 'unknown') {
      if (mappedStatus === 'completed') {
        // Answered call — mark contacted, let processTranscript/campaignPostCall handle final status
        await base44.entities.Lead.update(callLog.lead_id, { 
          status: 'contacted',
          last_call_date: new Date().toISOString()
        });
      } else if (mappedStatus === 'no_answer' || mappedStatus === 'failed') {
        await base44.entities.Lead.update(callLog.lead_id, { 
          status: 'callback',
          last_call_date: new Date().toISOString()
        });
      }
    }

    // Handle terminal call statuses (use mappedStatus which normalizes Smartflo values like "Missed", "Answered")
    if (mappedStatus === 'completed' || mappedStatus === 'no_answer' || mappedStatus === 'failed') {
      // Set end time
      if (!updateData.call_end_time) {
        updateData.call_end_time = new Date().toISOString();
        await base44.entities.CallLog.update(callLog.id, { call_end_time: new Date().toISOString() });
      }

      // WebSocket-only approach: transcripts are captured by streamAudio in real-time.
      // No recording_url processing needed. For calls that ended without WebSocket
      // (no_answer, failed, busy, cancelled), add a status summary so campaignPostCall
      // entity automation can process them.
      if (mappedStatus === 'no_answer' || mappedStatus === 'failed') {
        const statusLabel = status; // preserve original Smartflo status for clarity
        // Only update summary if streamAudio hasn't already saved one
        const freshLog = await base44.entities.CallLog.get(callLog.id);
        if (!freshLog.transcript) {
          await base44.entities.CallLog.update(callLog.id, {
            conversation_summary: `Call ended: ${statusLabel}. No conversation captured.`,
            lead_status_updated: mappedStatus === 'no_answer' ? 'no_answer' : 'callback'
          });
          console.log(`[smartfloWebhook] Terminal ${statusLabel} (mapped: ${mappedStatus}) — updated for campaign processing`);
        } else {
          console.log(`[smartfloWebhook] Terminal ${statusLabel} — WebSocket transcript already present, skipping summary override`);
        }

        // Update CampaignLead if this call belongs to a campaign (so campaign doesn't get stuck)
        try {
          const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: callLog.id });
          for (const cl of campaignLeads) {
            if (cl.status === 'calling') {
              await base44.entities.CampaignLead.update(cl.id, {
                status: 'completed',
                outcome: 'not_answered',
                call_status: 'not_answered',
                conversation_summary: `Call ${statusLabel}. No conversation.`,
                call_duration: parseInt(duration) || 0
              });
              console.log(`[smartfloWebhook] Updated CampaignLead ${cl.id} to completed/no_answer`);
            }
          }
        } catch (e) {
          console.log(`[smartfloWebhook] CampaignLead update failed: ${e.message}`);
        }
      }

      // NOTE: For answered+completed calls, streamAudio's saveCallRecord handles
      // transcript, summary, AI scoring, activities, and sequence enrollment.
      // campaignPostCall entity automation triggers on CallLog update for campaign calls.
    }

    return Response.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    console.error('[smartfloWebhook] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});