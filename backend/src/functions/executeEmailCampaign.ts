import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// executeEmailCampaign — Sends one batch for a running EmailCampaign.
//
// Called by the scheduled poller (emailCampaignPoller) or manually.
// Picks `batch_size` queued recipients, sends each via sendEmailFromTemplate,
// updates per-recipient + campaign stats. If the provider rejects with a
// quota / rate-limit error, the campaign is auto-paused and quota_warning
// is set so the UI can show a clear notification.
//
// Payload: { campaign_id }
// Returns: { success, sent, failed, paused, quota_warning? }
// ═══════════════════════════════════════════════════════════════════



const QUOTA_KEYWORDS = [
  'quota', 'rate limit', 'rate-limit', 'rate_limited', 'too many requests',
  'daily limit', 'monthly limit', 'sending limit', 'limit exceeded', '429',
  'exceeded the', 'over limit', 'plan limit'
];

function looksLikeQuota(msg) {
  if (!msg) return false;
  const lower = String(msg).toLowerCase();
  return QUOTA_KEYWORDS.some(k => lower.includes(k));
}

async function sleep(ms) {
  if (!ms || ms <= 0) return;
  return new Promise(r => setTimeout(r, ms));
}

export default async function executeEmailCampaign(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const svc = client.asServiceRole;
    const { campaign_id } = await c.req.json();
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const campaign = await svc.entities.EmailCampaign.get(campaign_id);
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    if (campaign.status !== 'running') {
      return c.json({ data: { skipped: true, reason: `status=${campaign.status}` } });
    }

    // ── Gate: require client's own configured email provider (no platform fallback for bulk) ──
    const cfgList = await svc.entities.ClientMessagingConfig.filter({ client_id: campaign.client_id }).catch(() => []);
    const cfg = cfgList[0] || null;
    const provider = cfg?.email_provider || 'none';
    const hasApiKey = ['resend', 'sendgrid', 'mailgun', 'postmark'].includes(provider) && !!cfg?.email_api_key
      && (provider !== 'mailgun' || !!cfg?.email_domain);
    const hasSmtp = (provider === 'smtp' || provider === 'ses') && !!cfg?.email_smtp_host && !!cfg?.email_smtp_user && !!cfg?.email_smtp_pass;
    const hasFrom = !!cfg?.email_from_address;
    const providerConfigured = (hasApiKey || hasSmtp) && hasFrom;

    if (!providerConfigured) {
      const msg = !hasFrom
        ? 'Client email provider is not configured: missing From address.'
        : `Client email provider is not configured (provider=${provider}). Bulk Email Campaigns require the client's own email provider — platform email is not used for campaigns.`;
      await svc.entities.EmailCampaign.update(campaign_id, {
        status: 'paused',
        quota_warning: { message: msg, provider, occurred_at: new Date().toISOString() }
      });
      console.warn(`[executeEmailCampaign] ${campaign_id} paused — no client provider`);
      return c.json({ data: { skipped: true, paused: true, reason: msg } });
    }

    // Honor scheduled_at
    if (campaign.scheduled_at) {
      const startAt = new Date(campaign.scheduled_at).getTime();
      if (Date.now() < startAt) {
        return c.json({ data: { skipped: true, reason: 'Scheduled for future' } });
      }
    }

    const batchSize = Math.max(1, Math.min(campaign.batch_size || 50, 500));
    const intervalSec = Math.max(0, campaign.send_interval_seconds || 0);

    const queued = await svc.entities.EmailCampaignRecipient.filter(
      { campaign_id, status: 'queued' }, 'created_date', batchSize
    );

    if (queued.length === 0) {
      // Nothing left — mark complete if no sending rows either
      const stillSending = await svc.entities.EmailCampaignRecipient.filter({ campaign_id, status: 'sending' });
      if (stillSending.length === 0) {
        await svc.entities.EmailCampaign.update(campaign_id, {
          status: 'completed', completed_at: new Date().toISOString()
        });
      }
      return c.json({ data: { success: true, sent: 0, failed: 0, completed: true } });
    }

    // Mark current batch as 'sending' to avoid double-pick on overlapping polls
    await Promise.all(queued.map(r =>
      svc.entities.EmailCampaignRecipient.update(r.id, { status: 'sending', attempt_count: (r.attempt_count || 0) + 1 })
        .catch(() => {})
    ));

    let sent = 0, failed = 0, quotaHit = null;

    for (const recipient of queued) {
      if (quotaHit) break; // stop the batch immediately on quota error

      try {
        const r = await svc.functions.invoke('sendEmailFromTemplate', {
          client_id: campaign.client_id,
          template_id: campaign.template_id,
          to_email: recipient.recipient_email,
          lead_id: recipient.lead_id,
          outreach_type: 'lead_followup',
          // Campaign-level extra attachments uploaded in the create dialog
          extra_attachment_ids: Array.isArray(campaign.extra_attachment_ids) ? campaign.extra_attachment_ids : [],
          // Headers for bulk: pass campaign_id so sendViaClientProvider can add List-Unsubscribe
          email_campaign_id: campaign_id,
          require_client_provider: true
        });

        const data = r?.data || {};
        // Reject any send that fell back to platform ACS — bulk must use client provider
        if (data.success && data.provider_used === 'azure_acs') {
          const msg = 'Send fell back to platform email — bulk campaigns require the client\'s own provider. Configure your email provider under Integrations.';
          quotaHit = { message: msg, provider: 'azure_acs' };
          await svc.entities.EmailCampaignRecipient.update(recipient.id, {
            status: 'queued', error_message: msg
          }).catch(() => {});
          break;
        }
        if (data.success) {
          await svc.entities.EmailCampaignRecipient.update(recipient.id, {
            status: 'sent', sent_at: new Date().toISOString()
          }).catch(() => {});
          sent++;
        } else {
          const errMsg = data.error || 'send failed';
          if (looksLikeQuota(errMsg)) {
            quotaHit = { message: errMsg, provider: data.provider_attempted || data.provider_used || 'unknown' };
            // Re-queue this recipient (it wasn't sent)
            await svc.entities.EmailCampaignRecipient.update(recipient.id, {
              status: 'queued', error_message: errMsg
            }).catch(() => {});
          } else {
            await svc.entities.EmailCampaignRecipient.update(recipient.id, {
              status: 'failed', error_message: errMsg
            }).catch(() => {});
            failed++;
          }
        }
      } catch (e) {
        const errMsg = e.message || 'unknown';
        if (looksLikeQuota(errMsg)) {
          quotaHit = { message: errMsg, provider: 'unknown' };
          await svc.entities.EmailCampaignRecipient.update(recipient.id, {
            status: 'queued', error_message: errMsg
          }).catch(() => {});
        } else {
          await svc.entities.EmailCampaignRecipient.update(recipient.id, {
            status: 'failed', error_message: errMsg
          }).catch(() => {});
          failed++;
        }
      }

      if (intervalSec > 0 && !quotaHit) await sleep(intervalSec * 1000);
    }

    // Re-queue any leftover 'sending' rows from this batch (defensive — shouldn't happen)
    const stuck = queued.filter(r => quotaHit && r.id);
    if (quotaHit) {
      // Any rows we hadn't reached yet are still 'sending' — re-queue them
      const stillSending = await svc.entities.EmailCampaignRecipient.filter({ campaign_id, status: 'sending' });
      await Promise.all(stillSending.map(r =>
        svc.entities.EmailCampaignRecipient.update(r.id, { status: 'queued' }).catch(() => {})
      ));
    }

    // Update campaign stats
    const stats = campaign.stats || {};
    const updatedStats = {
      ...stats,
      queued: Math.max(0, (stats.queued || 0) - sent - failed),
      sent: (stats.sent || 0) + sent,
      failed: (stats.failed || 0) + failed
    };

    const patch = { stats: updatedStats };

    if (quotaHit) {
      patch.status = 'paused';
      patch.quota_warning = {
        message: quotaHit.message,
        provider: quotaHit.provider,
        occurred_at: new Date().toISOString()
      };
      console.warn(`[executeEmailCampaign] ${campaign_id} paused on quota: ${quotaHit.message}`);
    } else {
      // If queue is now empty AND nothing sending, mark complete
      const remaining = await svc.entities.EmailCampaignRecipient.filter({ campaign_id, status: 'queued' });
      const stillSending2 = await svc.entities.EmailCampaignRecipient.filter({ campaign_id, status: 'sending' });
      if (remaining.length === 0 && stillSending2.length === 0) {
        patch.status = 'completed';
        patch.completed_at = new Date().toISOString();
      }
    }

    await svc.entities.EmailCampaign.update(campaign_id, patch);

    return c.json({ data: {
      success: true,
      sent, failed,
      paused: !!quotaHit,
      quota_warning: quotaHit || null
    } });
  } catch (error) {
    console.error('[executeEmailCampaign] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};