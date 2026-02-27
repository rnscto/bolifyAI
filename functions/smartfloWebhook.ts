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

    // Webhook authentication: verify shared secret
    const url = new URL(req.url);
    const webhookSecret = url.searchParams.get('secret');
    const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
    if (expectedSecret && webhookSecret !== expectedSecret) {
      console.error('[smartfloWebhook] Invalid webhook secret');
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

    console.log('[smartfloWebhook] Received:', payload.status, 'Call:', payload.call_id, 'Direction:', payload.direction);

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

        // Match caller to registered client (scoped outside so unknown caller block can access it)
        const allClients = await base44.entities.Client.list();
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
    const callLogs = await base44.entities.CallLog.filter({ call_sid: call_id });

    if (callLogs.length === 0) {
      console.log('[smartfloWebhook] Call log not found:', call_id);
      return Response.json({ success: true, message: 'Call log not found, but webhook received' });
    }

    const callLog = callLogs[0];
    const mappedStatus = STATUS_MAP[status] || status;

    const updateData = { status: mappedStatus };
    if (duration) updateData.duration = parseInt(duration);
    if (recording_url) updateData.recording_url = recording_url;
    if (status === 'completed') updateData.call_end_time = new Date().toISOString();

    await base44.entities.CallLog.update(callLog.id, updateData);

    // Update lead status based on call outcome (only for outbound client calls with valid lead_id)
    // Note: For 'answered' we just mark 'contacted' — the real outcome is set later 
    // by processTranscript → campaignPostCall after AI analyzes the conversation
    if (callLog.lead_id && callLog.lead_id !== 'unknown') {
      if (status === 'answered') {
        await base44.entities.Lead.update(callLog.lead_id, { 
          status: 'contacted',
          last_call_date: new Date().toISOString()
        });
      } else if (status === 'no_answer') {
        await base44.entities.Lead.update(callLog.lead_id, { 
          status: 'callback',
          last_call_date: new Date().toISOString()
        });
      }
      // Don't update for 'completed' here — let processTranscript/campaignPostCall handle final status
    }

    // Handle terminal call statuses
    if (status === 'completed' || status === 'no_answer' || status === 'failed' || status === 'busy' || status === 'cancelled') {
      // Set end time
      if (!updateData.call_end_time) {
        updateData.call_end_time = new Date().toISOString();
        await base44.entities.CallLog.update(callLog.id, { call_end_time: new Date().toISOString() });
      }

      // If recording available, process transcript (this will update CallLog which triggers campaignPostCall)
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

      // For calls WITHOUT recording (no_answer, failed, busy, cancelled),
      // ensure CallLog status is set to a terminal value so campaignPostCall automation triggers
      if (!recording_url && (status === 'no_answer' || status === 'failed' || status === 'busy' || status === 'cancelled')) {
        // The CallLog update above already set the status, and the entity automation
        // on CallLog update will fire campaignPostCall. But we also set a summary.
        const statusLabel = status === 'no_answer' ? 'No Answer' : status === 'busy' ? 'Busy' : status === 'cancelled' ? 'Cancelled' : 'Failed';
        await base44.entities.CallLog.update(callLog.id, {
          conversation_summary: `Call ended: ${statusLabel}. No recording available.`,
          lead_status_updated: status === 'no_answer' ? 'no_answer' : 'callback'
        });
        console.log(`[smartfloWebhook] Terminal status ${status} without recording — updated CallLog for campaign processing`);
      }

      // === DIRECT CAMPAIGN LEAD UPDATE + NEXT BATCH TRIGGER ===
      // For faster campaign progression, directly update CampaignLead and trigger next batch
      // instead of waiting for the entity automation chain (CallLog update → campaignPostCall)
      try {
        const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: callLog.id });
        if (campaignLeads.length > 0) {
          const cl = campaignLeads[0];
          // Only handle no-recording terminal calls here (completed+recording is handled by processTranscript → campaignPostCall)
          if (!recording_url && cl.status === 'calling') {
            const directOutcome = (status === 'no_answer' || status === 'busy' || status === 'cancelled') ? 'no_answer' : 'no_answer';
            await base44.entities.CampaignLead.update(cl.id, {
              status: 'completed',
              outcome: directOutcome,
              conversation_summary: `Call ${status}. No recording available.`,
              call_duration: parseInt(duration) || 0
            });
            console.log(`[smartfloWebhook] Direct CampaignLead update: ${cl.lead_name} → ${directOutcome}`);
          }

          // Trigger next batch immediately
          const campaign = await base44.entities.Campaign.get(cl.campaign_id);
          if (campaign && campaign.status === 'running') {
            const allCampaignLeads = await base44.entities.CampaignLead.filter({ campaign_id: cl.campaign_id });
            const pendingCount = allCampaignLeads.filter(l => l.status === 'pending').length;
            const callingCount = allCampaignLeads.filter(l => l.status === 'calling').length;
            const maxConcurrent = campaign.max_concurrent_calls || 5;

            if (pendingCount > 0 && callingCount < maxConcurrent) {
              console.log(`[smartfloWebhook] 🚀 Triggering next batch: ${pendingCount} pending, ${callingCount}/${maxConcurrent} calling`);
              await base44.functions.invoke('executeCampaign', {
                campaign_id: cl.campaign_id,
                action: 'start',
                _internal: true
              });
            }
          }
        }
      } catch (nextBatchErr) {
        console.error(`[smartfloWebhook] Campaign batch trigger failed: ${nextBatchErr.message}`);
      }
    }

    return Response.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    console.error('[smartfloWebhook] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});