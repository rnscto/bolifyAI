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

    console.log('[smartfloWebhook] Received:', payload.status, 'Call:', payload.call_id);

    const { call_id, status, duration, recording_url } = payload;

    if (!call_id) {
      return Response.json({ success: false, error: 'Missing call_id' }, { status: 400 });
    }

    // Validate status against known values
    const knownStatuses = ['ringing', 'answered', 'completed', 'failed', 'no_answer', 'busy', 'cancelled'];
    if (status && !knownStatuses.includes(status)) {
      console.warn('[smartfloWebhook] Unknown status:', status);
    }

    // Find call log by call_sid
    const callLogs = await base44.asServiceRole.entities.CallLog.filter({ 
      call_sid: call_id 
    });

    if (callLogs.length === 0) {
      console.log('[smartfloWebhook] Call log not found:', call_id);
      return Response.json({ success: true, message: 'Call log not found, but webhook received' });
    }

    const callLog = callLogs[0];
    const mappedStatus = STATUS_MAP[status] || status;

    // Update call log with status
    const updateData = {
      status: mappedStatus
    };

    if (duration) {
      updateData.duration = parseInt(duration);
    }

    if (status === 'completed') {
      updateData.call_end_time = new Date().toISOString();
    }

    await base44.asServiceRole.entities.CallLog.update(callLog.id, updateData);

    // Update lead status based on call completion
    if (status === 'answered' || status === 'completed') {
      await base44.asServiceRole.entities.Lead.update(callLog.lead_id, {
        status: 'interested'
      });
    } else if (status === 'no_answer' || status === 'failed') {
      await base44.asServiceRole.entities.Lead.update(callLog.lead_id, {
        status: 'callback'
      });
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