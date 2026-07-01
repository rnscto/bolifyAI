import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Executes an admin-created Broadcast: resolves audience, sends Email and/or WhatsApp,
// updates broadcast.status + stats. Admin-only.



const LOGO_URL = 'https://media.base44.com/images/public/698823c19043e168a5daaa86/00fe0d8ce_vaani-removebg-preview.png';
const APP_URL = 'https://app.vaaniai.io';

const THEMES = {
  announcement: { gradient: 'linear-gradient(135deg,#4facfe,#00f2fe)', accent: '#0284c7', emoji: '📢', label: 'Announcement' },
  downtime: { gradient: 'linear-gradient(135deg,#434343,#000000)', accent: '#1f2937', emoji: '🛠️', label: 'Service Notice' },
  feature_update: { gradient: 'linear-gradient(135deg,#a18cd1,#fbc2eb)', accent: '#7c3aed', emoji: '✨', label: 'New Feature' },
  promotion: { gradient: 'linear-gradient(135deg,#fa709a,#fee140)', accent: '#db2777', emoji: '🎁', label: 'Special Offer' },
};

function renderBroadcastEmail({ kind, heading, body, ctaLabel, ctaUrl, recipientName }) {
  const t = THEMES[kind] || THEMES.announcement;
  const ctaBtn = ctaLabel && ctaUrl ? `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto;"><tr><td style="background:${t.accent};border-radius:8px;"><a href="${ctaUrl}" style="display:inline-block;padding:14px 32px;color:#fff;font-weight:600;font-size:15px;text-decoration:none;">${ctaLabel}</a></td></tr></table>` : '';
  const greeting = recipientName ? `<p>Hi ${recipientName},</p>` : '';
  const bodyHtml = (body || '').split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:32px 16px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);"><tr><td style="background:${t.gradient};padding:40px 32px;text-align:center;"><img src="${LOGO_URL}" alt="VaaniAI" style="height:48px;margin-bottom:16px;filter:brightness(0) invert(1);"/><div style="font-size:48px;line-height:1;margin-bottom:8px;">${t.emoji}</div><div style="color:#fff;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;opacity:0.9;">${t.label}</div><h1 style="color:#fff;font-size:28px;font-weight:700;margin:8px 0 0 0;line-height:1.3;">${heading}</h1></td></tr><tr><td style="padding:40px 40px 24px 40px;color:#1f2937;font-size:16px;line-height:1.6;">${greeting}${bodyHtml}${ctaBtn}</td></tr><tr><td style="padding:24px 40px 32px 40px;border-top:1px solid #e5e7eb;text-align:center;color:#6b7280;font-size:13px;line-height:1.6;"><p style="margin:0;"><strong style="color:#111827;">VaaniAI</strong><br/><a href="${APP_URL}" style="color:${t.accent};text-decoration:none;">app.vaaniai.io</a> · <a href="mailto:support@vaaniai.io" style="color:${t.accent};text-decoration:none;">support@vaaniai.io</a></p><p style="margin:12px 0 0 0;color:#9ca3af;font-size:11px;">© ${new Date().getFullYear()} VaaniAI. All rights reserved.</p></td></tr></table></td></tr></table></body></html>`;
}

async function resolveAudience(base44, audience, audienceFilter) {
  const all = await base44.asServiceRole.entities.Client.list('-created_date', 2000);
  const f = audienceFilter || {};
  switch (audience) {
    case 'trial_only': return all.filter(c => c.account_status === 'trial');
    case 'active_only': return all.filter(c => c.account_status === 'active');
    case 'expired_only': return all.filter(c => c.account_status === 'expired');
    case 'onboarding_incomplete': return all.filter(c => !c.onboarding_completed);
    case 'by_plan': return all.filter(c => !f.pricing_plan || c.pricing_plan === f.pricing_plan);
    case 'all_clients':
    default: return all;
  }
}

export default async function sendBroadcast(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);

    const { broadcast_id } = await c.req.json();
    if (!broadcast_id) return c.json({ data: { error: 'broadcast_id required' } }, 400);

    const b = await base44.asServiceRole.entities.Broadcast.get(broadcast_id);
    if (!b) return c.json({ data: { error: 'Broadcast not found' } }, 404);
    if (b.status === 'sent') return c.json({ data: { error: 'Already sent' } }, 400);

    await base44.asServiceRole.entities.Broadcast.update(broadcast_id, { status: 'sending' });

    const recipients = await resolveAudience(base44, b.audience, b.audience_filter);
    const stats = { recipients: recipients.length, email_sent: 0, email_failed: 0, whatsapp_sent: 0, whatsapp_failed: 0 };

    for (const c of recipients) {
      // Email
      if (b.channels?.includes('email') && c.email) {
        const html = renderBroadcastEmail({
          kind: b.email_template_kind || 'announcement',
          heading: b.email_heading || b.email_subject,
          body: b.email_body || '',
          ctaLabel: b.email_cta_label,
          ctaUrl: b.email_cta_url,
          recipientName: c.company_name,
        });
        try {
          const r = await base44.asServiceRole.functions.invoke('sendPlatformEmail', {
            to: c.email, subject: b.email_subject, html, recipient_client_id: c.id, broadcast_id: b.id
          });
          if (r?.data?.success) stats.email_sent++; else stats.email_failed++;
        } catch (_) { stats.email_failed++; }
      }

      // WhatsApp
      if (b.channels?.includes('whatsapp') && b.whatsapp_template_id && c.phone) {
        try {
          const r = await base44.asServiceRole.functions.invoke('sendPlatformWhatsApp', {
            template_id: b.whatsapp_template_id, to: c.phone,
            variables: b.whatsapp_variables || [],
            recipient_client_id: c.id, broadcast_id: b.id
          });
          if (r?.data?.success) stats.whatsapp_sent++;
          else {
            stats.whatsapp_failed++;
            console.error(`[sendBroadcast] WhatsApp failed for ${c.phone}:`, r?.data?.error || r?.data);
          }
        } catch (e) {
          stats.whatsapp_failed++;
          console.error(`[sendBroadcast] WhatsApp threw for ${c.phone}:`, e.message);
        }
      }
    }

    await base44.asServiceRole.entities.Broadcast.update(broadcast_id, {
      status: 'sent', sent_at: new Date().toISOString(), stats
    });
    return c.json({ data: { success: true, stats } });
  } catch (e) {
    console.error('[sendBroadcast] error:', e);
    return c.json({ data: { error: e.message } }, 500);
  }

};