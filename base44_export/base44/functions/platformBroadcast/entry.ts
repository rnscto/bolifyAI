import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Admin-only: send a one-off broadcast to a target audience using a platform template.
// Payload: { template_id, audience: 'all' | 'trial' | 'active' | 'expired' | string[], variables_per_client?: {} }
// Audience can also be an array of client IDs.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }
    const svc = base44.asServiceRole;

    const { template_id, audience, default_variables } = await req.json();
    if (!template_id || !audience) {
      return Response.json({ error: 'template_id and audience required' }, { status: 400 });
    }

    const template = await svc.entities.WhatsAppTemplate.get(template_id);
    if (!template || template.status !== 'APPROVED') {
      return Response.json({ error: 'Template not found or not approved' }, { status: 400 });
    }

    // Resolve audience
    let clients = [];
    if (Array.isArray(audience)) {
      clients = await Promise.all(audience.map(id => svc.entities.Client.get(id).catch(() => null)));
      clients = clients.filter(Boolean);
    } else {
      const all = await svc.entities.Client.list('-created_at', 5000);
      if (audience === 'all') clients = all;
      else if (audience === 'trial') clients = all.filter(c => c.account_status === 'trial');
      else if (audience === 'active') clients = all.filter(c => c.account_status === 'active');
      else if (audience === 'expired') clients = all.filter(c => c.account_status === 'expired');
      else clients = [];
    }

    let sent = 0, skipped = 0, failed = 0;
    const errors = [];
    for (const c of clients) {
      if (!c.phone) { skipped++; continue; }
      try {
        const r = await svc.functions.invoke('sendPlatformWhatsApp', {
          template_id, to: c.phone, variables: default_variables || [c.company_name || 'there'],
          client_id: c.id, outreach_type: 'broadcast'
        });
        if (r?.data?.success) sent++;
        else { failed++; errors.push(`${c.id}: ${r?.data?.error}`); }
        // Small throttle to stay under vendor rate limits
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        failed++; errors.push(`${c.id}: ${e.message}`);
      }
    }

    return Response.json({ success: true, total_recipients: clients.length, sent, skipped, failed, errors: errors.slice(0, 20) });
  } catch (e) {
    console.error('[platformBroadcast]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});