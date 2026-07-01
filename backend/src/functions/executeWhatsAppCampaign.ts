import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// executeWhatsAppCampaign — Sends one batch for a running WhatsAppCampaign.
//
// Called by whatsappCampaignPoller. Picks `batch_size` queued recipients,
// sends each via sendWhatsAppTemplate, updates per-recipient + campaign
// stats. On provider rate-limit / quota error, the campaign is auto-paused
// and quota_warning is set so the UI can show a clear notification.
//
// Payload: { campaign_id }
// Returns: { success, sent, failed, paused, quota_warning? }
// ═══════════════════════════════════════════════════════════════════



const QUOTA_KEYWORDS = [
  'rate limit', 'rate-limit', 'too many requests', '429',
  'limit exceeded', 'quota', 'throttle', 'spam', 'blocked',
  'messaging limit', 'tier limit', '#130429', '#131056', '#368',
  'insufficient credits', 'insufficient balance', 'insufficient funds',
  'available credits', 'wallet', 'account suspended'
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

export default async function executeWhatsAppCampaign(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const svc = client.asServiceRole;
    const { campaign_id } = await c.req.json();
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const campaign = await svc.entities.WhatsAppCampaign.get(campaign_id);
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    if (campaign.status !== 'running') {
      return c.json({ data: { skipped: true, reason: `status=${campaign.status}` } });
    }

    // Gate: require client WhatsApp config
    const cfgList = await svc.entities.ClientMessagingConfig.filter({ client_id: campaign.client_id }).catch(() => []);
    const cfg = cfgList[0] || null;
    const wsConnected = !!(cfg && cfg.whatsapp_status === 'connected' && cfg.whatsapp_api_key && cfg.whatsapp_phone_number_id);
    if (!wsConnected) {
      const msg = 'Client WhatsApp is not connected. Configure WhatsApp under Integrations before running bulk campaigns.';
      await svc.entities.WhatsAppCampaign.update(campaign_id, {
        status: 'paused',
        quota_warning: { message: msg, provider: cfg?.whatsapp_provider || 'none', occurred_at: new Date().toISOString() }
      });
      return c.json({ data: { skipped: true, paused: true, reason: msg } });
    }

    // Validate template still approved
    const template = await svc.entities.MessageTemplate.get(campaign.template_id).catch(() => null);
    if (!template) {
      await svc.entities.WhatsAppCampaign.update(campaign_id, {
        status: 'failed', last_error: 'Template not found'
      });
      return c.json({ data: { error: 'Template not found' } }, 404);
    }
    if (template.approval_status !== 'approved') {
      const msg = `Template "${template.name}" is "${template.approval_status}" — must be approved before sending.`;
      await svc.entities.WhatsAppCampaign.update(campaign_id, {
        status: 'paused',
        quota_warning: { message: msg, provider: cfg.whatsapp_provider || 'unknown', occurred_at: new Date().toISOString() }
      });
      return c.json({ data: { skipped: true, paused: true, reason: msg } });
    }

    // Honor scheduled_at
    if (campaign.scheduled_at && Date.now() < new Date(campaign.scheduled_at).getTime()) {
      return c.json({ data: { skipped: true, reason: 'Scheduled for future' } });
    }

    const batchSize = Math.max(1, Math.min(campaign.batch_size || 50, 500));
    const intervalSec = Math.max(0, campaign.send_interval_seconds || 0);

    const queued = await svc.entities.WhatsAppCampaignRecipient.filter(
      { campaign_id, status: 'queued' }, 'created_date', batchSize
    );

    if (queued.length === 0) {
      const stillSending = await svc.entities.WhatsAppCampaignRecipient.filter({ campaign_id, status: 'sending' });
      if (stillSending.length === 0) {
        await svc.entities.WhatsAppCampaign.update(campaign_id, {
          status: 'completed', completed_at: new Date().toISOString()
        });
      }
      return c.json({ data: { success: true, sent: 0, failed: 0, completed: true } });
    }

    // Mark batch as sending (prevents double-pick on overlapping polls)
    await Promise.all(queued.map(r =>
      svc.entities.WhatsAppCampaignRecipient.update(r.id, {
        status: 'sending', attempt_count: (r.attempt_count || 0) + 1
      }).catch(() => {})
    ));

    let sent = 0, failed = 0, quotaHit = null;
    // Clean template variables — empty strings default to {{name}} so the template gets a real value
    const rawVars = Array.isArray(campaign.template_variables) ? campaign.template_variables : [];
    const variables = rawVars.map(v => {
      const s = String(v || '').trim();
      return s.length === 0 ? '{{name}}' : s;
    });

    for (const recipient of queued) {
      if (quotaHit) break;

      try {
        const r = await svc.functions.invoke('sendWhatsAppTemplate', {
          client_id: campaign.client_id,
          template_id: campaign.template_id,
          to: recipient.recipient_phone,
          variables,
          lead_id: recipient.lead_id,
          outreach_type: 'lead_followup'
        });

        const data = r?.data || {};
        if (data.success) {
          await svc.entities.WhatsAppCampaignRecipient.update(recipient.id, {
            status: 'sent',
            sent_at: new Date().toISOString(),
            provider_message_id: data.message_id || null
          }).catch(() => {});
          sent++;
        } else {
          const errMsg = data.error || 'send failed';
          if (looksLikeQuota(errMsg)) {
            quotaHit = { message: errMsg, provider: cfg.whatsapp_provider || 'unknown' };
            await svc.entities.WhatsAppCampaignRecipient.update(recipient.id, {
              status: 'queued', error_message: errMsg
            }).catch(() => {});
          } else {
            await svc.entities.WhatsAppCampaignRecipient.update(recipient.id, {
              status: 'failed', error_message: errMsg
            }).catch(() => {});
            failed++;
          }
        }
      } catch (e) {
        const errMsg = e.message || 'unknown';
        if (looksLikeQuota(errMsg)) {
          quotaHit = { message: errMsg, provider: cfg.whatsapp_provider || 'unknown' };
          await svc.entities.WhatsAppCampaignRecipient.update(recipient.id, {
            status: 'queued', error_message: errMsg
          }).catch(() => {});
        } else {
          await svc.entities.WhatsAppCampaignRecipient.update(recipient.id, {
            status: 'failed', error_message: errMsg
          }).catch(() => {});
          failed++;
        }
      }

      if (intervalSec > 0 && !quotaHit) await sleep(intervalSec * 1000);
    }

    // On quota hit — re-queue any still-sending rows
    if (quotaHit) {
      const stillSending = await svc.entities.WhatsAppCampaignRecipient.filter({ campaign_id, status: 'sending' });
      await Promise.all(stillSending.map(r =>
        svc.entities.WhatsAppCampaignRecipient.update(r.id, { status: 'queued' }).catch(() => {})
      ));
    }

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
      console.warn(`[executeWhatsAppCampaign] ${campaign_id} paused on quota: ${quotaHit.message}`);
    } else {
      const remaining = await svc.entities.WhatsAppCampaignRecipient.filter({ campaign_id, status: 'queued' });
      const stillSending2 = await svc.entities.WhatsAppCampaignRecipient.filter({ campaign_id, status: 'sending' });
      if (remaining.length === 0 && stillSending2.length === 0) {
        patch.status = 'completed';
        patch.completed_at = new Date().toISOString();
      }
    }

    await svc.entities.WhatsAppCampaign.update(campaign_id, patch);

    return c.json({ data: {
      success: true,
      sent, failed,
      paused: !!quotaHit,
      quota_warning: quotaHit || null
    } });
  } catch (error) {
    console.error('[executeWhatsAppCampaign] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};