import { base44ORM as base44 } from "../db/orm.ts";

const MAIN_ADMIN_EMAIL = 'neerajyrns@gmail.com';

export default async function processPaymentApproval(c: any) {
  try {
    const user = c.get('user');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin' || (user.email || '').toLowerCase() !== MAIN_ADMIN_EMAIL) {
      return c.json({ data: { error: 'Only the main admin may approve/reject payment requests.' } }, 403);
    }

    const { request_id, decision, review_notes = '' } = await c.req.json().catch(() => ({}));
    if (!request_id || !['approve', 'reject'].includes(decision)) {
      return c.json({ data: { error: 'Missing or invalid request_id / decision' } }, 400);
    }

    const reqRec = await base44.entities.PaymentApprovalRequest.get(request_id).catch(() => null);
    if (!reqRec) return c.json({ data: { error: 'Request not found' } }, 404);
    if (reqRec.status !== 'pending') {
      return c.json({ data: { error: `Request already \${reqRec.status}` } }, 400);
    }

    const nowISO = new Date().toISOString();

    if (decision === 'reject') {
      if (reqRec.request_type === 'client_activation') {
        try {
          const client = await base44.entities.Client.get(reqRec.client_id);
          if (client && client.account_status === 'activation_pending') {
            await base44.entities.Client.update(reqRec.client_id, { account_status: 'expired' });
          }
        } catch (e: any) {
          console.warn('[processPaymentApproval] could not revert client to expired:', e.message);
        }
      }
      const updated = await base44.entities.PaymentApprovalRequest.update(request_id, {
        status: 'rejected',
        reviewed_by: user.email,
        reviewed_at: nowISO,
        review_notes
      });
      return c.json({ data: { success: true, request: updated } });
    }

    let applyError = '';
    try {
      const client = await base44.entities.Client.get(reqRec.client_id);
      const meta = reqRec.request_metadata || {};
      const amount = Number(reqRec.amount) || 0;
      const auditNote = `Approved by \${user.email} via PaymentApprovalRequest \${request_id} (txn \${reqRec.transaction_number})`;

      switch (reqRec.request_type) {
        case 'client_activation': {
          const targetAccountStatus = meta.account_status || 'active';
          const patch: any = {
            status: meta.status || 'active',
            account_status: targetAccountStatus,
            ...(meta.billing_type ? { billing_type: meta.billing_type } : {}),
            ...(meta.subscription_plan ? { subscription_plan: meta.subscription_plan } : {}),
            ...(meta.total_channels ? { total_channels: Number(meta.total_channels) } : {}),
            ...(meta.per_minute_rate != null ? { per_minute_rate: Number(meta.per_minute_rate) } : {}),
            ...(meta.monthly_rate_per_channel != null ? { monthly_rate_per_channel: Number(meta.monthly_rate_per_channel) } : {}),
            ...(meta.next_billing_date ? { next_billing_date: meta.next_billing_date } : {}),
            ...(meta.free_minutes_remaining != null ? { free_minutes_remaining: Number(meta.free_minutes_remaining) } : {})
          };
          const walletCredit = Number(meta.wallet_credit) || 0;
          if (walletCredit > 0) {
            patch.wallet_balance = (Number(client.wallet_balance) || 0) + walletCredit;
          } else if (meta.wallet_balance != null) {
            patch.wallet_balance = Number(meta.wallet_balance);
          }
          if (targetAccountStatus === 'trial') {
            const trialEnd = new Date();
            trialEnd.setDate(trialEnd.getDate() + (Number(meta.trial_days) || 7));
            patch.trial_start_date = new Date().toISOString();
            patch.trial_end_date = trialEnd.toISOString();
          }
          await base44.entities.Client.update(client.id, patch);

          if (amount > 0) {
            try {
              await base44.entities.Payment.create({
                client_id: client.id,
                amount,
                status: 'paid',
                paid_at: nowISO,
                description: JSON.stringify({
                  type: 'client_activation',
                  account_status: targetAccountStatus,
                  billing_type: patch.billing_type || client.billing_type,
                  transaction_number: reqRec.transaction_number,
                  approval_request_id: request_id,
                  metadata: meta
                })
              });
            } catch (_) {}
          }
          break;
        }
        case 'wallet_topup': {
          const base = Number(meta.base_amount) || amount;
          const gst = Number(meta.gst) || 0;
          const total = Number(meta.total) || amount;
          await base44.entities.Client.update(client.id, {
            wallet_balance: (Number(client.wallet_balance) || 0) + base
          });
          try {
            await base44.entities.Payment.create({
              client_id: client.id,
              amount: total,
              status: 'paid',
              paid_at: nowISO,
              description: JSON.stringify({
                type: 'wallet_topup',
                amount: base,
                gst,
                total,
                transaction_number: reqRec.transaction_number,
                approval_request_id: request_id
              })
            });
          } catch (_) {}
          break;
        }
        case 'crm_integration_access': {
          await base44.entities.Client.update(client.id, {
            crm_api_access_status: 'active',
            crm_api_access_fee: amount,
            crm_api_access_activated_at: nowISO,
            crm_api_access_activated_by: user.email,
            crm_api_access_notes: auditNote
          });
          break;
        }
        case 'social_media_access': {
          await base44.entities.Client.update(client.id, {
            social_media_access_status: 'active',
            social_media_access_fee: amount,
            social_media_access_activated_at: nowISO,
            social_media_access_activated_by: user.email,
            social_media_access_notes: auditNote
          });
          break;
        }
        case 'subscription_renewal':
        case 'channel_addition':
        case 'other':
        default:
          try {
            await base44.entities.Payment.create({
              client_id: client.id,
              amount,
              status: 'paid',
              paid_at: nowISO,
              description: JSON.stringify({
                type: reqRec.request_type,
                transaction_number: reqRec.transaction_number,
                approval_request_id: request_id,
                metadata: meta
              })
            });
          } catch (_) {}
          break;
      }
    } catch (e: any) {
      console.error('[processPaymentApproval] apply error:', e.message);
      applyError = e.message;
    }

    const updated = await base44.entities.PaymentApprovalRequest.update(request_id, {
      status: 'approved',
      reviewed_by: user.email,
      reviewed_at: nowISO,
      review_notes,
      applied: !applyError,
      apply_error: applyError || ''
    });

    return c.json({ data: { success: true, applied: !applyError, apply_error: applyError, request: updated } });
  } catch (e: any) {
    console.error('[processPaymentApproval]', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }
}
