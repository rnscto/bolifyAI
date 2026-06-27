import { base44ORM as base44 } from "../db/orm.ts";

const CEO_EMAIL = 'yadavnand886@gmail.com';

export default async function submitPaymentApproval(c: any) {
  try {
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin' || (user.email || '').toLowerCase() !== CEO_EMAIL) {
      return c.json({ data: { error: 'Only the CEO admin may raise payment approval requests.' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const {
      request_type, client_id, amount, transaction_number,
      payment_method = 'bank_transfer', payment_date, screenshot_url,
      request_notes = '', request_metadata = {}
    } = body;

    if (!request_type || !client_id || !amount || !transaction_number) {
      return c.json({ data: { error: 'Missing required fields: request_type, client_id, amount, transaction_number' } }, 400);
    }

    const client = await base44.entities.Client.get(client_id).catch(() => null);
    if (!client) return c.json({ data: { error: 'Client not found' } }, 404);

    const reqRec = await base44.entities.PaymentApprovalRequest.create({
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

    if (request_type === 'client_activation' && client.account_status !== 'active') {
      try {
        await base44.entities.Client.update(client_id, { account_status: 'activation_pending' });
      } catch (e: any) {
        console.warn('[submitPaymentApproval] could not set activation_pending:', e.message);
      }
    }

    return c.json({ data: { success: true, id: reqRec.id, request: reqRec } });
  } catch (e: any) {
    console.error('[submitPaymentApproval]', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }
}
