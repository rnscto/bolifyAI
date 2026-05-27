import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const CEO_EMAIL = 'ceo@getwaygroup.com';

/**
 * Submit a payment approval request.
 * Only ceo@getwaygroup.com may call this.
 * Body:
 * {
 *   request_type: "client_activation" | "wallet_topup" | "crm_integration_access" | "social_media_access" | "subscription_renewal" | "channel_addition" | "other",
 *   client_id, amount, transaction_number, payment_method, payment_date, screenshot_url,
 *   request_notes, request_metadata
 * }
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin' || (user.email || '').toLowerCase() !== CEO_EMAIL) {
      return Response.json({ error: 'Only the CEO admin may raise payment approval requests.' }, { status: 403 });
    }

    const body = await req.json();
    const {
      request_type, client_id, amount, transaction_number,
      payment_method = 'bank_transfer', payment_date, screenshot_url,
      request_notes = '', request_metadata = {}
    } = body || {};

    if (!request_type || !client_id || !amount || !transaction_number) {
      return Response.json({ error: 'Missing required fields: request_type, client_id, amount, transaction_number' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const client = await svc.entities.Client.get(client_id).catch(() => null);
    if (!client) return Response.json({ error: 'Client not found' }, { status: 404 });

    const reqRec = await svc.entities.PaymentApprovalRequest.create({
      request_type,
      client_id,
      client_name: client.company_name,
      client_email: client.email,
      amount: Number(amount),
      transaction_number,
      payment_method,
      payment_date: payment_date || new Date().toISOString().split('T')[0],
      screenshot_url: screenshot_url || '',
      requested_by: user.email,
      request_notes,
      request_metadata,
      status: 'pending',
      applied: false
    });

    // Reflect pending state on the client for activation-type requests so the UI
    // shows "Activation in progress" until the main admin approves/rejects.
    if (request_type === 'client_activation' && client.account_status !== 'active') {
      try {
        await svc.entities.Client.update(client_id, { account_status: 'activation_pending' });
      } catch (e) {
        console.warn('[submitPaymentApproval] could not set activation_pending:', e.message);
      }
    }

    return Response.json({ success: true, id: reqRec.id, request: reqRec });
  } catch (e) {
    console.error('[submitPaymentApproval]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
});