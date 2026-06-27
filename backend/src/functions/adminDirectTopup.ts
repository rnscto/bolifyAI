import { base44ORM as base44 } from "../db/orm.ts";
import { distributeCommission } from "../utils/commissionDistributor.ts";
import { writeAuditLog } from "../utils/auditLog.ts";

export default async function adminDirectTopup(c: any) {
  try {
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin' && user.role !== 'master_admin') {
      return c.json({ data: { error: 'Only admins and master admins can perform direct top-ups.' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const { client_id, amount, transaction_number, notes } = body;

    if (!client_id || !amount || amount <= 0) {
      return c.json({ data: { error: 'Missing required fields or invalid amount: client_id, amount' } }, 400);
    }

    const client = await base44.entities.Client.get(client_id).catch(() => null);
    if (!client) return c.json({ data: { error: 'Client not found' } }, 404);

    const oldBalance = Number(client.wallet_balance) || 0;
    const newBalance = oldBalance + Number(amount);

    // Update client balance
    await base44.entities.Client.update(client_id, {
      wallet_balance: newBalance
    });

    // Log the transaction
    const payment = await base44.entities.Payment.create({
      client_id,
      amount: Number(amount),
      status: 'paid',
      cashfree_order_id: transaction_number || `DIRECT-${Date.now()}`,
      description: JSON.stringify({
        type: 'wallet_topup',
        amount: Number(amount),
        gst: 0,
        total: Number(amount),
        notes: notes || 'Direct top-up by Admin'
      }),
      paid_at: new Date().toISOString()
    });

    await base44.entities.UsageLog.create({
      client_id,
      type: "topup",
      direction: "credit",
      amount: Number(amount),
      balance_before: oldBalance,
      balance_after: newBalance,
      description: `Direct wallet top-up by Admin: ₹${amount}`,
      payment_id: payment.id
    });

    await writeAuditLog({
      client_id,
      action_type: 'WALLET_TOPUP',
      entity_type: 'client',
      entity_id: client_id,
      actor_email: user.email,
      actor_role: user.role,
      details: `Admin ${user.email} directly topped up client wallet by ₹${amount}`,
      metadata: { amount, transaction_number, notes }
    });

    // Distribute commission for the top-up
    await distributeCommission(payment.id, client_id, Number(amount), 1, true);

    return c.json({ data: { success: true, new_balance: newBalance, payment_id: payment.id } });
  } catch (e: any) {
    console.error('[adminDirectTopup]', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }
}
