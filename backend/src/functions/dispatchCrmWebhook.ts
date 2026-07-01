import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// dispatchCrmWebhook — outbound call-outcome webhook sender
// ═══════════════════════════════════════════════════════════════════════
// Pushes a completed call's outcome to the client's configured CRM webhook
// URL (CRMIntegration.webhook_url, webhook_enabled=true). Payload is signed
// with HMAC-SHA256 using webhook_secret → header `X-Vaani-Signature`.
// Retries up to 3 times on non-2xx / network error.
//
// Invoke (internal): base44.functions.invoke('dispatchCrmWebhook', { call_log_id })
// Triggered automatically by an entity automation on CallLog updates.
// ═══════════════════════════════════════════════════════════════════════


async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function dispatchCrmWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));
    // Accept either a direct { call_log_id } or an entity-automation payload
    // ({ event: { entity_id }, data: {...} }).
    const callLogId = body.call_log_id || body?.event?.entity_id || body?.data?.id;
    if (!callLogId) return c.json({ data: { error: 'call_log_id required' } }, 400);

    const call = await svc.entities.CallLog.get(callLogId).catch(() => null);
    if (!call) return c.json({ data: { error: 'CallLog not found' } }, 404);

    const clientId = call.client_id;

    // Only deliver when the client has an enabled webhook integration with a URL.
    const integrations = await svc.entities.CRMIntegration.filter({ client_id: clientId, webhook_enabled: true });
    const integration = integrations.find(i => i.webhook_url);
    if (!integration) {
      return c.json({ data: { success: true, skipped: 'no enabled webhook for client' } });
    }

    // Resolve the lead (optional)
    let lead = null;
    if (call.lead_id) lead = await svc.entities.Lead.get(call.lead_id).catch(() => null);

    const payload = {
      event: 'call_completed',
      sent_at: new Date().toISOString(),
      lead: lead ? {
        id: lead.id,
        crm_id: lead.crm_id || null,
        name: lead.name || '',
        phone: lead.phone || '',
        status: lead.status,
        score: lead.score || 0,
        qualification_tier: lead.qualification_tier || null,
        custom_fields: lead.custom_fields || {}
      } : null,
      outcome: {
        call_log_id: call.id,
        call_status: call.status,
        direction: call.direction || null,
        duration: call.duration || 0,
        summary: call.conversation_summary || '',
        lead_status_updated: call.lead_status_updated || null,
        recording_url: call.recording_url || null,
        call_time: call.call_start_time || call.created_date
      }
    };

    const bodyStr = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (integration.webhook_secret) {
      headers['X-Vaani-Signature'] = await hmacSha256Hex(integration.webhook_secret, bodyStr);
    }

    // Deliver with up to 3 attempts (1s, 2s backoff)
    let delivered = false;
    let lastError = '';
    let statusCode = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await fetch(integration.webhook_url, { method: 'POST', headers, body: bodyStr });
        statusCode = resp.status;
        if (resp.ok) { delivered = true; break; }
        lastError = `HTTP ${resp.status}`;
      } catch (e) {
        lastError = e.message;
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
    }

    await svc.entities.CRMIntegration.update(integration.id, delivered
      ? { last_webhook_at: new Date().toISOString(), last_webhook_error: '', status: 'active' }
      : { last_webhook_error: lastError, status: 'error' }
    ).catch(() => {});

    if (!delivered) {
      console.error('dispatchCrmWebhook delivery failed:', lastError);
      return c.json({ data: { success: false, error: lastError, status_code: statusCode } }, 502);
    }
    return c.json({ data: { success: true, status_code: statusCode } });
  } catch (error) {
    console.error('dispatchCrmWebhook error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};