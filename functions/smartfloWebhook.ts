import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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
    // Enrich request with Base44 headers for external webhook calls
    let clientReq = req;
    if (!req.headers.has('Base44-App-Id')) {
      const enrichedHeaders = new Headers(req.headers);
      enrichedHeaders.set('Base44-App-Id', Deno.env.get('BASE44_APP_ID'));
      enrichedHeaders.set('Base44-Service-Token', Deno.env.get('BASE44_SERVICE_ROLE_KEY'));
      clientReq = new Request(req.url, {
        method: req.method,
        headers: enrichedHeaders,
        body: req.body
      });
    }
    const base44 = createClientFromRequest(clientReq);

    // Webhook authentication: verify shared secret
    const url = new URL(req.url);
    const webhookSecret = url.searchParams.get('secret');
    const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
    if (expectedSecret && webhookSecret !== expectedSecret) {
      console.error('[smartfloWebhook] Invalid webhook secret');
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const payload = await req.json();
    console.log('[smartfloWebhook] Received:', payload.status, 'Call:', payload.call_id, 'Direction:', payload.direction);

    const { call_id, status, duration, recording_url, direction, caller_number, called_number } = payload;

    if (!call_id) {
      return Response.json({ success: false, error: 'Missing call_id' }, { status: 400 });
    }

    // ===== INCOMING CALL IDENTIFICATION =====
    if (direction === 'inbound' || payload.type === 'inbound') {
      const incomingNumber = caller_number || payload.from || payload.caller_id;
      console.log('[smartfloWebhook] Incoming call from:', incomingNumber);

      if (incomingNumber) {
        // Clean number for matching
        const cleanNumber = incomingNumber.replace(/\D/g, '');
        const last10 = cleanNumber.slice(-10);

        // Search for client by phone number
        const allClients = await base44.asServiceRole.entities.Client.list();
        const matchedClient = allClients.find(c => {
          if (!c.phone) return false;
          const clientClean = c.phone.replace(/\D/g, '');
          return clientClean.slice(-10) === last10;
        });

        if (matchedClient) {
          console.log('[smartfloWebhook] Incoming call identified - Client:', matchedClient.company_name, 'Status:', matchedClient.account_status);

          // Create call log with client context
          const inboundLog = await base44.asServiceRole.entities.CallLog.create({
            client_id: matchedClient.id,
            agent_id: 'system',
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: called_number || payload.to || '',
            direction: 'inbound',
            status: 'ringing',
            call_start_time: new Date().toISOString(),
            conversation_summary: `Incoming call from known client: ${matchedClient.company_name} (${matchedClient.account_status}). Industry: ${matchedClient.industry || 'General'}`,
          });

          // Load retention config for incoming call handling
          const configs = await base44.asServiceRole.entities.RetentionConfig.list('-created_date', 1);
          const config = configs[0] || {};

          if (config.enable_incoming_identification !== false) {
            // Load client's agent & lead data for context
            const [clientAgents, clientLeads] = await Promise.all([
              base44.asServiceRole.entities.Agent.filter({ client_id: matchedClient.id }),
              base44.asServiceRole.entities.Lead.filter({ client_id: matchedClient.id }),
            ]);

            console.log('[smartfloWebhook] Client context loaded - Agents:', clientAgents.length, 'Leads:', clientLeads.length);
          }

          // Create activity
          await base44.asServiceRole.entities.Activity.create({
            client_id: matchedClient.id,
            type: 'call',
            title: `Incoming call from ${matchedClient.company_name}`,
            description: `Client called in. Account: ${matchedClient.account_status}. Phone: ${incomingNumber}`,
            scheduled_date: new Date().toISOString(),
            status: 'scheduled',
            priority: matchedClient.account_status === 'expired' ? 'high' : 'medium',
            auto_created: true,
          });

          return Response.json({
            success: true,
            identified: true,
            client_id: matchedClient.id,
            client_name: matchedClient.company_name,
            account_status: matchedClient.account_status,
            industry: matchedClient.industry,
            call_log_id: inboundLog.id,
          });
        } else {
          console.log('[smartfloWebhook] Incoming call from unknown number:', incomingNumber);

          // Log unidentified incoming call
          await base44.asServiceRole.entities.CallLog.create({
            client_id: 'unknown',
            agent_id: 'system',
            call_sid: call_id,
            caller_id: incomingNumber,
            callee_number: called_number || '',
            direction: 'inbound',
            status: 'ringing',
            call_start_time: new Date().toISOString(),
            conversation_summary: `Incoming call from unregistered number: ${incomingNumber}`,
          });

          return Response.json({
            success: true,
            identified: false,
            message: 'Caller not matched to any registered client',
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
    const callLogs = await base44.asServiceRole.entities.CallLog.filter({ call_sid: call_id });

    if (callLogs.length === 0) {
      console.log('[smartfloWebhook] Call log not found:', call_id);
      return Response.json({ success: true, message: 'Call log not found, but webhook received' });
    }

    const callLog = callLogs[0];
    const mappedStatus = STATUS_MAP[status] || status;

    const updateData = { status: mappedStatus };
    if (duration) updateData.duration = parseInt(duration);
    if (status === 'completed') updateData.call_end_time = new Date().toISOString();

    await base44.asServiceRole.entities.CallLog.update(callLog.id, updateData);

    // Update lead status based on call outcome (only for outbound client calls with valid lead_id)
    if (callLog.lead_id && callLog.lead_id !== 'unknown') {
      if (status === 'answered' || status === 'completed') {
        await base44.asServiceRole.entities.Lead.update(callLog.lead_id, { status: 'interested' });
      } else if (status === 'no_answer' || status === 'failed') {
        await base44.asServiceRole.entities.Lead.update(callLog.lead_id, { status: 'callback' });
      }
    }

    // If call is completed and has recording, trigger transcript processing
    if (status === 'completed' && recording_url) {
      try {
        await base44.asServiceRole.functions.invoke('processTranscript', {
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