import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { call_log_id, status, transcript, duration, call_end_time } = await req.json();

    if (!call_log_id) {
      return Response.json({ error: 'call_log_id required' }, { status: 400 });
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (transcript) updateData.transcript = transcript;
    if (duration !== undefined) updateData.duration = duration;
    if (call_end_time) updateData.call_end_time = call_end_time;

    await base44.asServiceRole.entities.CallLog.update(call_log_id, updateData);

    return Response.json({ success: true });
  } catch (error) {
    console.error('updateCallLog error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});