import { createClient } from 'npm:@base44/sdk@0.8.18';

// Centralized RCS/SMS sending function
// Uses the client's configured messaging provider (Zixflow, Gupshup, etc.)
// Falls back to platform-level Zixflow if client has no config

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id' }
    });
  }

  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const body = await req.json();
    const { client_id, recipient, message } = body;

    if (!recipient || !message) {
      return Response.json({ success: false, error: 'recipient and message are required' }, { status: 400 });
    }

    // Clean phone: strip + and spaces, ensure digits only
    const cleanPhone = recipient.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      return Response.json({ success: false, error: 'Invalid phone number' }, { status: 400 });
    }

    // Try to load client's messaging config
    let msgConfig = null;
    if (client_id) {
      const configs = await base44.entities.ClientMessagingConfig.filter({ client_id });
      if (configs.length > 0) msgConfig = configs[0];
    }

    const provider = msgConfig?.rcs_provider || 'none';

    // ===== ZIXFLOW (Platform default + client option) =====
    // Use platform-level Zixflow if client has no config or chose zixflow
    if (provider === 'zixflow' || provider === 'none') {
      const apiKey = (provider === 'zixflow' && msgConfig?.rcs_api_key) 
        ? msgConfig.rcs_api_key 
        : Deno.env.get('ZIXFLOW_API_KEY');
      const workspaceId = (provider === 'zixflow' && msgConfig?.rcs_api_endpoint)
        ? msgConfig.rcs_api_endpoint  // We store workspace_id in api_endpoint field for zixflow
        : Deno.env.get('ZIXFLOW_WORKSPACE_ID');
      const botId = (provider === 'zixflow' && msgConfig?.rcs_sender_id)
        ? msgConfig.rcs_sender_id  // We store bot_id in sender_id field for zixflow
        : Deno.env.get('ZIXFLOW_BOT_ID');

      if (!apiKey || !workspaceId) {
        console.log('[sendRCS] No Zixflow credentials configured, skipping');
        return Response.json({ success: false, error: 'Zixflow RCS not configured. Set ZIXFLOW_API_KEY and ZIXFLOW_WORKSPACE_ID.' });
      }

      const zixflowBody = {
        recipient: cleanPhone,
        text: message,
      };
      if (botId) zixflowBody.bot_id = botId;

      const res = await fetch('https://api-ai.zixflow.com/api/ingest/rcs/v1/message/text/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-workspace-id': workspaceId
        },
        body: JSON.stringify(zixflowBody)
      });

      const data = await res.json();
      console.log(`[sendRCS] Zixflow response for ${cleanPhone}:`, JSON.stringify(data));

      if (res.ok && data.success) {
        return Response.json({ 
          success: true, 
          provider: 'zixflow',
          request_id: data.request_id,
          message: 'RCS message queued via Zixflow' 
        });
      }
      return Response.json({ 
        success: false, 
        provider: 'zixflow',
        error: data.message || JSON.stringify(data) 
      });
    }

    // ===== GUPSHUP =====
    if (provider === 'gupshup') {
      const endpoint = msgConfig.rcs_api_endpoint || 'https://enterprise.smsgupshup.com/GatewayAPI/rest';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          method: 'SendMessage',
          userid: msgConfig.rcs_sender_id || '',
          password: msgConfig.rcs_api_key,
          msg: message,
          send_to: cleanPhone,
          msg_type: 'TEXT',
          auth_scheme: 'plain'
        })
      });
      const data = await res.text();
      const ok = res.ok && (data.includes('success') || data.includes('sent'));
      return Response.json({ success: ok, provider: 'gupshup', ...(ok ? {} : { error: data }) });
    }

    // ===== KALEYRA / ROUTE_MOBILE / SMARTFLO =====
    if (['kaleyra', 'route_mobile', 'smartflo'].includes(provider)) {
      const endpoint = msgConfig.rcs_api_endpoint;
      if (!endpoint) return Response.json({ success: false, error: 'API endpoint required for ' + provider });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${msgConfig.rcs_api_key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: cleanPhone,
          sender: msgConfig.rcs_sender_id || 'VaaniAI',
          type: 'rcs',
          body: message,
          fallback: 'sms'
        })
      });
      const ok = res.ok;
      const data = ok ? {} : { error: await res.text() };
      return Response.json({ success: ok, provider, ...data });
    }

    // ===== TWILIO =====
    if (provider === 'twilio') {
      const accountSid = msgConfig.rcs_sender_id;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${accountSid}:${msgConfig.rcs_api_key}`),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: accountSid, To: cleanPhone, Body: message })
      });
      const data = await res.json();
      if (res.ok && data.sid) {
        return Response.json({ success: true, provider: 'twilio', sid: data.sid });
      }
      return Response.json({ success: false, provider: 'twilio', error: data.message || JSON.stringify(data) });
    }

    return Response.json({ success: false, error: `Unsupported RCS provider: ${provider}` });

  } catch (error) {
    console.error('[sendRCS] Error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});