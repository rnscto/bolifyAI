import { createClient } from 'npm:@base44/sdk@0.8.31';

// Public webhook endpoint for RCS Digital (Meta-compatible).
// Configure RCS Digital console → webhook → this function URL.
// Handles:
//   GET  ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...  → verification
//   POST { entry: [{ changes: [{ value: { messages, statuses } }] }] }  → events
Deno.serve(async (req) => {
  // Verification handshake (Meta-compatible)
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const expected = Deno.env.get('SMARTFLO_WEBHOOK_SECRET'); // reuse existing shared secret
    if (mode === 'subscribe' && token === expected) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = createClient({ appId, asServiceRole: true });
    const payload = await req.json();
    console.log('[rcsDigitalWebhook] Received:', JSON.stringify(payload).substring(0, 500));

    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};

        // Delivery / status receipts
        const statuses = value.statuses || [];
        for (const s of statuses) {
          const msgId = s.id;
          const newStatus = s.status; // sent, delivered, read, failed
          if (!msgId) continue;
          try {
            const logs = await svc.entities.OutreachLog.filter({ vendor_message_id: msgId }, '-created_date', 1);
            if (logs.length > 0) {
              const mappedStatus = ['delivered', 'read', 'failed'].includes(newStatus) ? newStatus : logs[0].status;
              await svc.entities.OutreachLog.update(logs[0].id, {
                status: mappedStatus,
                error_message: s.errors?.[0]?.title || logs[0].error_message || ''
              });
            }
          } catch (e) {
            console.warn('[rcsDigitalWebhook] Status update failed:', e.message);
          }
        }

        // Inbound messages (replies)
        const messages = value.messages || [];
        for (const m of messages) {
          const fromPhone = m.from;
          const msgText = m.text?.body || m.button?.text || `[${m.type}]`;
          const msgId = m.id;
          // Find the lead by phone (across clients) — best-effort
          let lead = null, clientId = 'PLATFORM';
          try {
            const cleanPhone = fromPhone.replace(/[^0-9]/g, '');
            const leads = await svc.entities.Lead.filter({ phone: cleanPhone }, '-created_date', 1);
            if (leads.length > 0) { lead = leads[0]; clientId = lead.client_id; }
            else {
              // Try last-10-digit match
              const allLeads = await svc.entities.Lead.list('-created_date', 1000);
              const match = allLeads.find(l => (l.phone || '').replace(/\D/g, '').endsWith(cleanPhone.slice(-10)));
              if (match) { lead = match; clientId = match.client_id; }
            }
          } catch (_) {}

          try {
            await svc.entities.OutreachLog.create({
              client_id: clientId,
              lead_id: lead?.id || null,
              channel: 'whatsapp',
              direction: 'inbound',
              vendor: 'rcs_digital',
              vendor_message_id: msgId,
              recipient_phone: fromPhone,
              body: msgText,
              outreach_type: 'inbound_reply',
              status: 'replied'
            });
            // Update lead status to engaged if found
            if (lead) {
              await svc.entities.Lead.update(lead.id, {
                last_engagement_date: new Date().toISOString(),
                engagement_count: (lead.engagement_count || 0) + 1,
                status: lead.status === 'new' ? 'contacted' : lead.status
              });
            }
          } catch (e) {
            console.warn('[rcsDigitalWebhook] Inbound log failed:', e.message);
          }
        }
      }
    }

    return Response.json({ success: true });
  } catch (e) {
    console.error('[rcsDigitalWebhook]', e);
    // Return 200 to prevent vendor retry storms — log internally
    return Response.json({ received: true, error: e.message });
  }
});