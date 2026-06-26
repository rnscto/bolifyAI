import { base44ORM as base44 } from '../db/orm.ts';

export async function distributeCommission(paymentId: string, clientId: string, amountPaid: number, channels: number = 1, isTopup: boolean = false) {
  try {
    let currentClientId = clientId;
    let currentAmount = amountPaid;
    let currentChannels = channels;

    // Determine the selling rate of the current node
    const clientRecord = await base44.entities.Client.get(currentClientId);
    if (!clientRecord) return;

    let currentRate = isTopup ? Number(clientRecord.per_minute_rate || 2.5) : Number(clientRecord.monthly_rate_per_channel || 6500);
    let uplineId = clientRecord.upline_id;

    while (uplineId) {
      const uplineRecord = await base44.entities.Client.get(uplineId);
      if (!uplineRecord) break;

      let uplineRate = isTopup ? Number(uplineRecord.per_minute_rate || 2.5) : Number(uplineRecord.monthly_rate_per_channel || 6500);

      let commissionAmount = 0;
      if (isTopup) {
        // Proportion of margin. E.g., rate 5, upline rate 2.5. Margin is 2.5/5.0 = 50% of the topup.
        const marginRatio = currentRate > 0 ? (currentRate - uplineRate) / currentRate : 0;
        if (marginRatio > 0) commissionAmount = currentAmount * marginRatio;
      } else {
        commissionAmount = (currentRate - uplineRate) * currentChannels;
      }

      if (commissionAmount > 0) {
        const newBalance = Number(uplineRecord.commission_balance || 0) + commissionAmount;
        await base44.entities.Client.update(uplineId, { commission_balance: newBalance });
        await base44.entities.CommissionLedger.create({
          transaction_id: paymentId,
          from_client_id: currentClientId,
          to_reseller_id: uplineId,
          amount: commissionAmount,
          status: 'credited',
          type: 'earning'
        });
      }

      // Move up the tree
      currentClientId = uplineId;
      currentRate = uplineRate;
      uplineId = uplineRecord.upline_id;
    }

    console.log(`Commission distribution complete for payment ${paymentId}`);

  } catch (err) {
    console.error("Error distributing commissions:", err);
  }
}