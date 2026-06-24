import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Check if client has sufficient balance for calling
// Used by campaigns before starting and by individual call initiation
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { client_id, estimated_calls, avg_duration_minutes } = await req.json();

    if (!client_id) {
      return Response.json({ error: 'client_id is required' }, { status: 400 });
    }

    const client = await base44.entities.Client.get(client_id);
    if (!client) {
      return Response.json({ error: 'Client not found' }, { status: 404 });
    }

    // ── ACCOUNT STATUS GATE ──
    // Blocked statuses cannot make calls regardless of wallet balance.
    const blockedStatuses = ['expired', 'suspended', 'activation_pending', 'cancelled'];
    if (blockedStatuses.includes(client.account_status)) {
      return Response.json({
        can_call: false,
        billing_type: client.billing_type,
        account_status: client.account_status,
        blocked_reason: 'account_not_active',
        message: `Account status is '${client.account_status}'. Renew or activate to resume calling.`
      });
    }

    // Unlimited plans always have sufficient balance
    if (client.billing_type === 'unlimited') {
      return Response.json({
        can_call: true,
        billing_type: 'unlimited',
        message: 'Unlimited plan — no balance check needed'
      });
    }

    const rate = client.per_minute_rate || 4;
    const freeMinutes = client.free_minutes_remaining || 0;
    const walletBalance = client.wallet_balance || 0;
    const minBalance = 100; // Minimum ₹100 to make calls

    // Calculate available minutes
    const freeMinutesAvail = freeMinutes;
    const paidMinutesAvail = Math.floor(walletBalance / rate);
    const totalMinutesAvail = freeMinutesAvail + paidMinutesAvail;

    // For single call check
    const canMakeSingleCall = freeMinutes > 0 || walletBalance >= minBalance;

    // For campaign estimate
    let campaignCheck = null;
    if (estimated_calls && avg_duration_minutes) {
      const totalMinutesNeeded = estimated_calls * avg_duration_minutes;
      const totalCostEstimate = Math.max(0, totalMinutesNeeded - freeMinutes) * rate;
      const hasEnough = freeMinutes >= totalMinutesNeeded || walletBalance >= totalCostEstimate;
      const shortfall = hasEnough ? 0 : totalCostEstimate - walletBalance;

      campaignCheck = {
        estimated_calls,
        avg_duration_minutes,
        total_minutes_needed: totalMinutesNeeded,
        estimated_cost: totalCostEstimate,
        has_sufficient_balance: hasEnough,
        shortfall: Math.ceil(shortfall),
        recommended_topup: hasEnough ? 0 : Math.max(500, Math.ceil(shortfall / 100) * 100) // Round up to nearest 100, min ₹500
      };
    }

    return Response.json({
      can_call: canMakeSingleCall,
      billing_type: 'per_minute',
      rate_per_minute: rate,
      wallet_balance: walletBalance,
      free_minutes_remaining: freeMinutes,
      total_minutes_available: totalMinutesAvail,
      min_balance_required: minBalance,
      campaign: campaignCheck
    });
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});