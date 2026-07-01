import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function verifyAddonPayment(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { order_id } = await c.req.json();
    if (!order_id) return c.json({ data: { error: 'order_id required' } }, 400);

    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';

    const cfResponse = await fetch(`${baseUrl}/pg/orders/${order_id}`, {
      headers: {
        'x-client-id': Deno.env.get('CASHFREE_APP_ID'),
        'x-client-secret': Deno.env.get('CASHFREE_SECRET_KEY'),
        'x-api-version': '2023-08-01',
      },
    });
    const cfData = await cfResponse.json();
    if (!cfResponse.ok) return c.json({ data: { error: 'Verify failed', details: cfData } }, 500);

    const purchases = await base44.asServiceRole.entities.AddonPurchase.filter({ cashfree_order_id: order_id });
    if (purchases.length === 0) return c.json({ data: { error: 'Purchase not found' } }, 404);
    const purchase = purchases[0];

    if (cfData.order_status !== 'PAID') {
      const newStatus = cfData.order_status === 'EXPIRED' ? 'failed' : 'pending';
      await base44.asServiceRole.entities.AddonPurchase.update(purchase.id, { status: newStatus });
      return c.json({ data: { status: newStatus, order_status: cfData.order_status } });
    }

    // Already processed?
    if (purchase.status === 'paid') {
      return c.json({ data: { status: 'paid', already_processed: true } });
    }

    await base44.asServiceRole.entities.AddonPurchase.update(purchase.id, {
      status: 'paid',
      cashfree_payment_id: cfData.cf_order_id?.toString(),
      paid_at: new Date().toISOString(),
    });

    // Activate the add-on on the client
    const client = await base44.asServiceRole.entities.Client.get(purchase.client_id);
    if (!client) return c.json({ data: { error: 'Client missing' } }, 404);

    const updates = {};
    const now = new Date();
    const newPeriodEnd = new Date(purchase.period_end);
    const addonKey = purchase.addon_key;

    // Build / update addon_subscriptions object
    const subs = { ...(client.addon_subscriptions || {}) };

    if (addonKey === 'call_transfer') {
      updates.call_transfer_enabled = true;
      updates.call_transfer_enabled_at = now.toISOString();
      subs.call_transfer = { active_until: newPeriodEnd.toISOString(), monthly_rate: 1250 };
    } else if (addonKey === 'incoming_calls') {
      subs.incoming_calls = {
        active_until: newPeriodEnd.toISOString(),
        monthly_rate: 2000,
        activation_status: 'pending_backend',
        purchased_at: now.toISOString(),
      };
    } else if (addonKey === 'additional_did') {
      const existing = subs.additional_did || { quantity: 0, monthly_rate: 200 };
      subs.additional_did = {
        quantity: (existing.quantity || 0) + (purchase.quantity || 1),
        active_until: newPeriodEnd.toISOString(),
        monthly_rate: 200,
      };
    } else if (addonKey === 'extra_agent') {
      const existing = subs.extra_agent || { quantity: 0, monthly_rate: 4999 };
      const qty = purchase.quantity || 1;
      subs.extra_agent = {
        quantity: (existing.quantity || 0) + qty,
        active_until: newPeriodEnd.toISOString(),
        monthly_rate: 4999,
        activation_status: 'pending_backend',
      };
      // Create AgentSlot rows — one per purchased seat — so admin sees a queue
      for (let i = 0; i < qty; i++) {
        await base44.asServiceRole.entities.AgentSlot.create({
          client_id: client.id,
          addon_purchase_id: purchase.id,
          status: 'pending_provision',
          active_until: newPeriodEnd.toISOString(),
          monthly_rate: 4999,
        });
      }
    } else {
      // Module add-ons → toggle enabled_modules
      const moduleKeyMap = {
        email_campaigns: 'email_campaigns',
        whatsapp_bulk: 'whatsapp_bulk',
        screening: 'screening',
        google_sheets_sync: 'google_sheets_sync',
        social_media: 'social_media',
      };
      const moduleKey = moduleKeyMap[addonKey];
      if (moduleKey) {
        const enabled = Array.isArray(client.enabled_modules) ? [...client.enabled_modules] : [];
        if (!enabled.includes(moduleKey)) enabled.push(moduleKey);
        updates.enabled_modules = enabled;
        subs[addonKey] = { active_until: newPeriodEnd.toISOString(), monthly_rate: purchase.base_amount };
      }
    }

    updates.addon_subscriptions = subs;
    await base44.asServiceRole.entities.Client.update(client.id, updates);

    // Auto-provision Smartflo agents for call_transfer
    if (addonKey === 'call_transfer') {
      try {
        await base44.asServiceRole.functions.invoke('smartfloAgentProvisioner', { client_id: client.id });
      } catch (e) {
        console.error('Smartflo provision failed (non-blocking):', e?.message);
      }
    }

    // Fire invoice email (best-effort)
    try {
      await base44.asServiceRole.functions.invoke('sendInvoiceEmail', {
        addon_purchase_id: purchase.id,
      });
    } catch (e) {
      console.error('Invoice email failed (non-blocking):', e?.message);
    }

    return c.json({ data: {
      status: 'paid',
      addon_key: addonKey,
      activated: true,
      activation_status: purchase.activation_status,
      requires_backend_activation: addonKey === 'incoming_calls',
    } });
  } catch (error) {
    console.error('verifyAddonPayment error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};