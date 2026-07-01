import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Centralized internal alerting for demo-flow issues.
// Sends a Telegram message to the Vaani Internal Sales tenant's owner chat
// (whoever configured telegram_chat_id on the Client). Best-effort.
//
// Payload: { severity: 'info'|'warning'|'critical', title, message, booking_id? }



const TG_API = 'https://api.telegram.org';
const VAANI_TENANT = 'Vaani Internal Sales';

const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

export default async function notifyDemoAlert(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const { severity = 'warning', title, message, booking_id } = await c.req.json();

    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token) return c.json({ data: { skipped: 'no_telegram_token' } });

    const clients = await svc.entities.Client.filter({ company_name: VAANI_TENANT }).catch(() => []);
    const chatId = clients[0]?.telegram_chat_id;
    if (!chatId) return c.json({ data: { skipped: 'no_chat_id' } });

    const lines = [`${ICON[severity] || '🔔'} *${title}*`, message || ''];
    if (booking_id) lines.push(`\nBooking: \`${booking_id}\``);

    const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' })
    });

    // Also email Support Team on warning + critical (not info — too noisy)
    if (severity === 'warning' || severity === 'critical') {
      svc.functions.invoke('notifySupportTeamDemo', {
        kind: 'alert',
        booking_id,
        severity,
        title,
        message
      }).catch(e => console.error('support team alert email failed', e?.message));
    }

    return c.json({ data: { success: res.ok } });
  } catch (error) {
    console.error('notifyDemoAlert error', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};