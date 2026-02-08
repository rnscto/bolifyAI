import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Validate Smartflo signature (basic validation)
    const smartfloSignature = req.headers.get('X-Smartflo-Signature');
    if (!smartfloSignature) {
      return Response.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const webhookData = await req.json();
    const { call_sid, status, duration, recording_url } = webhookData;

    if (!call_sid) {
      return Response.json({ error: 'Missing call_sid' }, { status: 400 });
    }

    // Find call log by call_sid
    const callLogs = await base44.asServiceRole.entities.CallLog.filter({ call_sid });
    
    if (callLogs.length === 0) {
      return Response.json({ error: 'Call not found' }, { status: 404 });
    }

    const callLog = callLogs[0];
    const updateData = { status };

    // Map Smartflo status to our status
    const statusMap = {
      'ringing': 'ringing',
      'in-progress': 'answered',
      'completed': 'completed',
      'failed': 'failed',
      'no-answer': 'no_answer',
      'busy': 'no_answer',
      'canceled': 'failed'
    };

    updateData.status = statusMap[status] || status;

    if (status === 'completed') {
      updateData.duration = duration;
      updateData.call_end_time = new Date().toISOString();

      // If recording available, process transcript
      if (recording_url) {
        // Trigger async transcript processing
        base44.asServiceRole.functions.invoke('processTranscript', {
          call_log_id: callLog.id,
          recording_url
        }).catch(err => console.error('Transcript processing error:', err));
      }
    }

    // Update call log
    await base44.asServiceRole.entities.CallLog.update(callLog.id, updateData);

    return Response.json({ success: true });

  } catch (error) {
    console.error('Webhook error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});