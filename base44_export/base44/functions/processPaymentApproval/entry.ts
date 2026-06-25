import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAIN_ADMIN_EMAIL = 'yadavnand886@gmail.com';

/**
 * Process (approve/reject) a PaymentApprovalRequest.
 * Only yadavnand886@gmail.com (main admin) may call this.
 * On approval, the underlying change is applied to the client (e.g. activate account, top up wallet, activate CRM, activate Social Media).
 * Body: { request_id: string, decision: "approve" | "reject", review_notes?: string }
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin' || (user.email || '').toLowerCase() !== MAIN_ADMIN_EMAIL) {
      return Response.json({ error: 'Only the main admin may approve/reject payment requests.' }, { status: 403 });
    }

    const { request_id, decision, review_notes = '' } = await req.json();
    if (!request_id || !['approve', 'reject'].includes(decision)) {
      return Response.json({ error: 'Missing or invalid request_id / decision' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const reqRec = await svc.entities.PaymentApprovalRequest.get(request_id).catch(() => null);
    if (!reqRec) return Response.json({ error: 'Request not found' }, { status: 404 });
    if (reqRec.status !== 'pending') {
      return Response.json({ error: `Request already ${reqRec.status}` }, { status: 400 });
    }

    const nowISO = new Date().toISOString();

    if (decision === 'reject') {
      // For client_activation rejections, revert the client back to 'expired'
      // (it was flipped to 'activation_pending' when the CEO raised the request).
      if (reqRec.request_type === 'client_activation') {
        try {
          const client = await svc.entities.Client.get(reqRec.client_id);
          if (client && client.account_status === 'activation_pending') {
            await svc.entities.Client.update(reqRec.client_id, { account_status: 'expired' });
          }
        } catch (e) {
          console.warn('[processPaymentApproval] could not revert client to expired:', e.message);
        }
      }
      const updated = await svc.entities.PaymentApprovalRequest.update(request_id, {
        status: 'rejected',
        reviewed_by: user.email,
        reviewed_at: nowISO,
        review_notes
      });
      return Response.json({ success: true, request: updated });
    }

    // ── Apply the change for approved requests ──
    let applyError = '';
    try {
      const client = await svc.entities.Client.get(reqRec.client_id);
      const meta = reqRec.request_metadata || {};
      const amount = Number(reqRec.amount) || 0;
      const auditNote = `Approved by ${user.email} via PaymentApprovalRequest ${request_id} (txn ${reqRec.transaction_number})`;

      switch (reqRec.request_type) {
        case 'client_activation': {
          // Intended target status + billing config carried in request_metadata
          const targetAccountStatus = meta.account_status || 'active';
          const patch = {
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
          // Wallet credit (delta on top of existing balance)
          const walletCredit = Number(meta.wallet_credit) || 0;
          if (walletCredit > 0) {
            patch.wallet_balance = (Number(client.wallet_balance) || 0) + walletCredit;
          } else if (meta.wallet_balance != null) {
            patch.wallet_balance = Number(meta.wallet_balance);
          }
          // Trial dates only when explicitly activating a trial
          if (targetAccountStatus === 'trial') {
            const trialEnd = new Date();
            trialEnd.setDate(trialEnd.getDate() + (Number(meta.trial_days) || 7));
            patch.trial_start_date = new Date().toISOString();
            patch.trial_end_date = trialEnd.toISOString();
          }
          await svc.entities.Client.update(client.id, patch);

          // Record the payment if money changed hands
          if (amount > 0) {
            try {
              await svc.entities.Payment.create({
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
          await svc.entities.Client.update(client.id, {
            wallet_balance: (Number(client.wallet_balance) || 0) + base
          });
          // Record Payment for invoicing/history
          try {
            await svc.entities.Payment.create({
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
          await svc.entities.Client.update(client.id, {
            crm_api_access_status: 'active',
            crm_api_access_fee: amount,
            crm_api_access_activated_at: nowISO,
            crm_api_access_activated_by: user.email,
            crm_api_access_notes: auditNote
          });
          break;
        }
        case 'social_media_access': {
          await svc.entities.Client.update(client.id, {
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
          // For these, the change is purely a payment record. Log a Payment entry.
          try {
            await svc.entities.Payment.create({
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
    } catch (e) {
      console.error('[processPaymentApproval] apply error:', e.message);
      applyError = e.message;
    }

    const updated = await svc.entities.PaymentApprovalRequest.update(request_id, {
      status: 'approved',
      reviewed_by: user.email,
      reviewed_at: nowISO,
      review_notes,
      applied: !applyError,
      apply_error: applyError || ''
    });

    return Response.json({ success: true, applied: !applyError, apply_error: applyError, request: updated });
  } catch (e) {
    console.error('[processPaymentApproval]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
});