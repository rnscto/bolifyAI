import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Called after each call completes to deduct from wallet/free minutes
// This is an ENTITY AUTOMATION on CallLog updates (status → completed)
Deno.serve(async (req) => {
  try {
    const base44_client = createClientFromRequest(req);
    const base44 = base44_client.asServiceRole;
    const payload = await req.json();
    const { event, data } = payload;

    if (!event || event.entity_name !== 'CallLog') {
      return Response.json({ success: true, skipped: 'not_call_log' });
    }

    // Only process completed calls with duration
    if (data.status !== 'completed' || !data.duration || data.duration <= 0) {
      return Response.json({ success: true, skipped: 'not_completed_or_no_duration' });
    }

    const callLogId = event.entity_id;
    const clientId = data.client_id;
    if (!clientId) {
      return Response.json({ success: true, skipped: 'no_client_id' });
    }

    // Check if already deducted (idempotency)
    const existingUsage = await base44.entities.UsageLog.filter({ call_log_id: callLogId, type: 'call_charge' });
    if (existingUsage.length > 0) {
      return Response.json({ success: true, skipped: 'already_deducted' });
    }

    let client = null;
    try {
      client = await base44.entities.Client.get(clientId);
    } catch (e) {
      console.warn(`[deductCallUsage] Client.get failed: ${e.message}, trying filter`);
      const clients = await base44.entities.Client.filter({ id: clientId });
      client = clients.length > 0 ? clients[0] : null;
    }
    if (!client) {
      console.log(`[deductCallUsage] Client ${clientId} not found, skipping`);
      return Response.json({ success: true, skipped: 'client_not_found' });
    }

    // Only deduct for per_minute billing (unlimited plans skip deduction)
    if (client.billing_type === 'unlimited') {
      return Response.json({ success: true, skipped: 'unlimited_plan' });
    }

    const durationSeconds = Math.max(1, Math.round(data.duration));
    const billableMinutes = Math.ceil(durationSeconds / 60); // 0-60s = 1 min
    const ratePerMinute = client.per_minute_rate || 4;
    const freeMinutes = client.free_minutes_remaining || 0;
    const walletBalance = client.wallet_balance || 0;

    let freeMinutesUsed = 0;
    let paidMinutes = billableMinutes;
    let chargeAmount = 0;

    // Use free minutes first
    if (freeMinutes > 0) {
      freeMinutesUsed = Math.min(freeMinutes, billableMinutes);
      paidMinutes = billableMinutes - freeMinutesUsed;
    }

    chargeAmount = paidMinutes * ratePerMinute;

    const newFreeMinutes = freeMinutes - freeMinutesUsed;
    const newBalance = walletBalance - chargeAmount;
    const newTotalMinutes = (client.total_minutes_used || 0) + billableMinutes;
    const newTotalSpent = (client.total_amount_spent || 0) + chargeAmount;

    // Create usage log
    await base44.entities.UsageLog.create({
      client_id: clientId,
      call_log_id: callLogId,
      type: 'call_charge',
      direction: 'debit',
      call_duration_seconds: durationSeconds,
      billable_minutes: billableMinutes,
      rate_per_minute: ratePerMinute,
      amount: -chargeAmount,
      balance_before: walletBalance,
      balance_after: newBalance,
      free_minutes_before: freeMinutes,
      free_minutes_after: newFreeMinutes,
      description: `Call ${billableMinutes} min (${durationSeconds}s)${freeMinutesUsed > 0 ? ` — ${freeMinutesUsed} free min used` : ''} — ₹${chargeAmount} charged`
    });

    // Update client wallet
    await base44.entities.Client.update(clientId, {
      wallet_balance: newBalance,
      free_minutes_remaining: newFreeMinutes,
      total_minutes_used: newTotalMinutes,
      total_amount_spent: newTotalSpent
    });

    console.log(`[deductCallUsage] ✅ Client ${clientId}: ${billableMinutes} min (${freeMinutesUsed} free + ${paidMinutes} paid @ ₹${ratePerMinute}), charged ₹${chargeAmount}, balance ₹${newBalance}`);

    return Response.json({
      success: true,
      billable_minutes: billableMinutes,
      free_minutes_used: freeMinutesUsed,
      charged: chargeAmount,
      new_balance: newBalance,
      new_free_minutes: newFreeMinutes
    });
  } catch (error) {
    console.error('[deductCallUsage] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});