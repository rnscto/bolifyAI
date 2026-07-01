import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends a branded HTML email via Resend, using the PLATFORM from-address.
// Pulls from_email/from_name from PlatformMessagingConfig if set, else falls back to env defaults.
//
// Payload: { to, subject, html, recipient_client_id?, broadcast_id? }



export default async function sendPlatformEmail(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const base44 = client.asServiceRole;
    const { to, subject, html, recipient_client_id = null, broadcast_id = null } = await c.req.json();
    if (!to || !subject || !html) return c.json({ data: { error: 'to, subject, html required' } }, 400);

    const configs = await base44.entities.PlatformMessagingConfig.list();
    const config = configs[0] || {};
    const fromEmail = config.from_email || 'noreply@vaaniai.io';
    const fromName = config.from_name || 'VaaniAI';

    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (!apiKey) return c.json({ data: { error: 'RESEND_API_KEY not configured' } }, 500);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[sendPlatformEmail] failed:', data);
      await base44.entities.OutreachLog.create({
        client_id: recipient_client_id || 'platform',
        channel: 'email', recipient_email: Array.isArray(to) ? to[0] : to,
        subject, body: html.substring(0, 500),
        outreach_type: broadcast_id ? 'platform_broadcast' : 'lead_followup',
        status: 'failed', error_message: data?.message || `HTTP ${res.status}`
      }).catch(() => {});
      return c.json({ data: { error: data?.message || `HTTP ${res.status}` } }, 400);
    }

    await base44.entities.OutreachLog.create({
      client_id: recipient_client_id || 'platform',
      channel: 'email', recipient_email: Array.isArray(to) ? to[0] : to,
      subject, body: html.substring(0, 500),
      outreach_type: broadcast_id ? 'platform_broadcast' : 'lead_followup',
      status: 'sent'
    }).catch(() => {});

    return c.json({ data: { success: true, message_id: data?.id || null } });
  } catch (e) {
    console.error('[sendPlatformEmail] exception:', e);
    return c.json({ data: { error: e.message } }, 500);
  }

};