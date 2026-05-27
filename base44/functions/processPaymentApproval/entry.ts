import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const MAIN_ADMIN_EMAIL = 'neerajyrns@gmail.com';

/**
 * Process (approve/reject) a PaymentApprovalRequest.
 * Only neerajyrns@gmail.com (main admin) may call this.
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
          const trialEnd = new Date();
          trialEnd.setDate(trialEnd.getDate() + (meta.trial_days || 7));
          await svc.entities.Client.update(client.id, {
            status: 'active',
            account_status: 'active',
            trial_start_date: new Date().toISOString(),
            trial_end_date: trialEnd.toISOString(),
            ...(meta.billing_type ? { billing_type: meta.billing_type } : {}),
            ...(meta.total_channels ? { total_channels: meta.total_channels } : {}),
            ...(meta.per_minute_rate ? { per_minute_rate: meta.per_minute_rate } : {}),
            ...(meta.monthly_rate_per_channel ? { monthly_rate_per_channel: meta.monthly_rate_per_channel } : {}),
            ...(meta.next_billing_date ? { next_billing_date: meta.next_billing_date } : {})
          });
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