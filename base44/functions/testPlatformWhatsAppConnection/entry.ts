import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Test the platform-level (admin) RCS Digital / Meta Cloud connection.
// Updates PlatformMessagingConfig.whatsapp_status accordingly.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }
    const svc = base44.asServiceRole;

    const { provider, api_key, phone_number_id, business_id } = await req.json();
    if (!api_key || !phone_number_id) {
      return Response.json({ error: 'api_key and phone_number_id are required' }, { status: 400 });
    }

    const baseHost = provider === 'rcs_digital'
      ? 'https://rcsdigital.in/v23.0'
      : 'https://graph.facebook.com/v20.0';

    const res = await fetch(`${baseHost}/${phone_number_id}?fields=verified_name,display_phone_number`, {
      headers: { 'Authorization': `Bearer ${api_key}` }
    });
    const data = await res.json();

    // Persist status
    const cfgs = await svc.entities.PlatformMessagingConfig.list('-created_date', 1);
    const newStatus = res.ok ? 'connected' : 'error';
    const updates = {
      whatsapp_provider: provider,
      whatsapp_api_key: api_key,
      whatsapp_phone_number_id: phone_number_id,
      whatsapp_business_id: business_id || '',
      whatsapp_status: newStatus,
      whatsapp_last_tested: new Date().toISOString()
    };
    if (cfgs.length > 0) await svc.entities.PlatformMessagingConfig.update(cfgs[0].id, updates);
    else await svc.entities.PlatformMessagingConfig.create({ is_singleton: true, ...updates });

    if (res.ok) {
      return Response.json({ success: true, status: 'connected', message: `Connected to ${provider} — phone ${data.display_phone_number || phone_number_id}`, details: data });
    }
    return Response.json({ success: false, status: 'error', error: data.error?.message || JSON.stringify(data) });
  } catch (e) {
    console.error('[testPlatformWhatsAppConnection]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});