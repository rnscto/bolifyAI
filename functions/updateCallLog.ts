import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    // Inject Base44-App-Id if missing (called from streamAudio WebSocket context)
    let base44Req = req;
    if (!req.headers.get('Base44-App-Id')) {
      const appId = Deno.env.get('BASE44_APP_ID');
      if (appId) {
        const newHeaders = new Headers(req.headers);
        newHeaders.set('Base44-App-Id', appId);
        base44Req = new Request(req.url, {
          method: req.method,
          headers: newHeaders,
          body: req.body,
          duplex: 'half'
        });
      }
    }
    const base44 = createClientFromRequest(base44Req);

    const { call_log_id, status, transcript, duration, call_end_time, conversation_summary } = await req.json();

    if (!call_log_id) {
      return Response.json({ error: 'call_log_id required' }, { status: 400 });
    }

    // Validate status if provided
    const validStatuses = ['initiated', 'ringing', 'answered', 'completed', 'failed', 'no_answer'];
    if (status && !validStatuses.includes(status)) {
      return Response.json({ error: 'Invalid status' }, { status: 400 });
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (transcript) updateData.transcript = transcript;
    if (duration !== undefined) updateData.duration = duration;
    if (call_end_time) updateData.call_end_time = call_end_time;
    if (conversation_summary) updateData.conversation_summary = conversation_summary;

    await base44.asServiceRole.entities.CallLog.update(call_log_id, updateData);

    return Response.json({ success: true });
  } catch (error) {
    console.error('updateCallLog error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});