import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// RCS Digital — RCS channel management (templates + bots + capability checks).
// Counterpart to rcsDigitalTemplateSync (which handles WhatsApp).
//
// Base URL: https://rcsdigital.in
//
// Two APIs are used:
//   A) RCS Send/Bots API  — Bearer = same as whatsapp_api_key (config.rcs_api_key)
//        GET  /api/v1/rcs/getBotIds
//        POST /api/v1/Rcs/sendmessage
//        GET  /VodaWrapperRcs/v1/phones/{phone}/capabilitiesCheck
//   B) Voda Template API   — separate OAuth token from /templateapi/oauth/token
//        POST   /templateapi/v1/bots/{botId}/templates              (multipart, template_data string)
//        GET    /templateapi/v1/bots/{botId}/templates              (list)
//        GET    /templateapi/v1/bots/{botId}/templates/{idOrName}   (details)
//        DELETE /templateapi/v1/bots/{botId}/templates/{idOrName}
//        GET    /templateapi/v1/bots/{botId}/templates/{idOrName}/status
//        PUT    /templateapi/v1/bots/{botId}/templates/{templateId} (multipart, template_data string)
//
// Actions supported via payload.action:
//   - "test_connection"   : verify by listing bot IDs
//   - "list_bots"         : return all RCS bot IDs available to this account
//   - "sync"              : list templates from Voda Template API for both bots and upsert into DB
//   - "submit"            : create a new RCS template via Voda Template API (multipart)
//   - "get_template"      : fetch one RCS template's details
//   - "delete"            : delete an RCS template via Voda Template API
//   - "send_test_message" : send a real RCS template message to a test number
//   - "check_capabilities": check if a phone supports RCS



const RCS_BASE = 'https://rcsdigital.in';

async function rcsFetch(path, { method = 'GET', headers = {}, body, token }) {
  const url = `${RCS_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...headers
    },
    body
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Voda Template API uses the same Bearer token as the send-message API.
// No separate OAuth exchange required.

function buildSuggestions(template) {
  // RCS suggestions — REPLY (quick reply), OPEN_URL, DIAL_PHONE.
  return (template.buttons || []).map(b => {
    if (b.type === 'URL') {
      return { action: { text: b.text, postbackData: b.text, openUrlAction: { url: b.url || '' } } };
    }
    if (b.type === 'PHONE_NUMBER') {
      return { action: { text: b.text, postbackData: b.text, dialAction: { phoneNumber: b.phone_number || '' } } };
    }
    // QUICK_REPLY (default)
    return { reply: { text: b.text, postbackData: b.text } };
  });
}

function buildTemplateDataObject(template) {
  // Standard RCS Business Messaging "agent message" shape — what the Voda
  // Template API expects inside the template_data field (sent as a JSON string).
  const hasMedia = template.header_type && template.header_type !== 'none' && template.header_type !== 'text';
  const suggestions = buildSuggestions(template);

  const contentMessage = {
    text: template.body || '',
    ...(suggestions.length ? { suggestions } : {})
  };

  if (hasMedia && template.header_media_url) {
    contentMessage.richCard = {
      standaloneCard: {
        cardContent: {
          title: template.header_text || '',
          description: template.body || '',
          media: {
            height: 'MEDIUM',
            contentInfo: {
              fileUrl: template.header_media_url,
              forceRefresh: false
            }
          },
          ...(suggestions.length ? { suggestions } : {})
        }
      }
    };
    delete contentMessage.text;
    delete contentMessage.suggestions;
  }

  return {
    name: template.name,
    category: template.category || 'UTILITY',
    language: template.language || 'en',
    contentMessage
  };
}

// Voda Template API expects multipart/form-data with a "template_data" text field
// containing the JSON-stringified template body.
function buildMultipartTemplate(template) {
  const tplData = buildTemplateDataObject(template);
  const boundary = `----rcsd${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="template_data"\r\n\r\n`,
    JSON.stringify(tplData),
    `\r\n--${boundary}--\r\n`
  ];
  return {
    boundary,
    body: parts.join(''),
    payload: tplData
  };
}

export default async function rcsDigitalRcsSync(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const { action, template_id, client_id } = body;

    // Resolve client
    let targetClient;
    if (user.role === 'admin' && client_id) {
      targetClient = await base44.asServiceRole.entities.Client.get(client_id);
    } else {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (clients.length === 0) return c.json({ data: { error: 'No client found' } }, 404);
      targetClient = clients[0];
    }

    // Load messaging config
    const configs = await base44.asServiceRole.entities.ClientMessagingConfig.filter({ client_id: targetClient.id });
    if (configs.length === 0) return c.json({ data: { error: 'No messaging config — connect RCS Digital first' } }, 400);
    const config = configs[0];

    // Per user: RCS bearer token = same as whatsapp_api_key
    const token = config.rcs_api_key || config.whatsapp_api_key;
    const transBotId = config.rcs_bot_id;
    const promoBotId = config.rcs_promo_bot_id || config.rcs_bot_id;
    // Default bot for non-template actions (test_connection, list_bots) = trans bot
    const botId = transBotId;

    // Helper: pick bot by template category (MARKETING -> promo, else -> trans)
    const pickBotForCategory = (category) =>
      (String(category || '').toUpperCase() === 'MARKETING') ? promoBotId : transBotId;

    if (!token) {
      return c.json({ data: { success: false, error: 'Missing API token. Connect RCS Digital first.' } }, 400);
    }

    // ─── TEST CONNECTION ───
    if (action === 'test_connection') {
      const { ok, status, data } = await rcsFetch(`/api/v1/rcs/getBotIds`, { token });
      await base44.asServiceRole.entities.ClientMessagingConfig.update(config.id, {
        rcs_status: ok ? 'connected' : 'error',
        rcs_last_tested: new Date().toISOString()
      });
      let errorMsg = null;
      if (!ok) {
        errorMsg = data?.message || data?.error?.message || data?.error || `HTTP ${status}`;
      }
      return c.json({ data: {
        success: ok,
        status_code: status,
        bots: ok ? (data?.botIds || data?.data || data) : null,
        error: errorMsg,
        details: ok ? null : data
      } });
    }

    // ─── LIST BOTS ───
    if (action === 'list_bots') {
      const { ok, status, data } = await rcsFetch(`/api/v1/rcs/getBotIds`, { token });
      if (!ok) return c.json({ data: { error: data?.message || `HTTP ${status}`, details: data } }, 400);
      return c.json({ data: { success: true, bots: data?.botIds || data?.data || data } });
    }

    // ─── SUBMIT / CREATE TEMPLATE (Voda Template API, multipart) ───
    if (action === 'submit') {
      if (!template_id) return c.json({ data: { error: 'template_id required' } }, 400);

      const template = await base44.asServiceRole.entities.MessageTemplate.get(template_id);
      if (!template || template.client_id !== targetClient.id) {
        return c.json({ data: { error: 'Template not found' } }, 404);
      }
      if (template.channel !== 'rcs') {
        return c.json({ data: { error: 'Only RCS templates supported here' } }, 400);
      }

      const targetBotId = pickBotForCategory(template.category);
      if (!targetBotId) {
        return c.json({ data: { error: `RCS Bot ID not configured for ${template.category} templates` } }, 400);
      }

      const { boundary, body: multipartBody, payload } = buildMultipartTemplate(template);
      const isUpdate = !!template.vendor_template_id;
      const url = isUpdate
        ? `/templateapi/v1/bots/${encodeURIComponent(targetBotId)}/templates/${encodeURIComponent(template.vendor_template_id)}`
        : `/templateapi/v1/bots/${encodeURIComponent(targetBotId)}/templates`;
      const { ok, status, data } = await rcsFetch(url, {
        method: isUpdate ? 'PUT' : 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
        token
      });
      if (!ok) {
        return c.json({ data: {
          error: data?.message || data?.error?.message || `HTTP ${status}`,
          details: data,
          attempted_payload: payload
        } }, 400);
      }
      const vendorId = data?.templateId || data?.id || data?.data?.templateId || data?.data?.id || template.vendor_template_id || template.name;
      const remoteStatus = String(data?.status || data?.data?.status || 'pending').toLowerCase();
      await base44.asServiceRole.entities.MessageTemplate.update(template_id, {
        vendor_template_id: vendorId,
        approval_status: ['approved', 'pending', 'rejected', 'paused', 'disabled'].includes(remoteStatus) ? remoteStatus : 'pending',
        submitted_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString()
      });
      return c.json({ data: { success: true, vendor_template_id: vendorId, response: data } });
    }

    // ─── GET TEMPLATE DETAILS (Voda Template API) ───
    if (action === 'get_template') {
      const { template_name, category } = body;
      let templateForBot = null;
      const name = template_name || (template_id ? ((templateForBot = await base44.asServiceRole.entities.MessageTemplate.get(template_id)))?.name : null);
      if (!name) return c.json({ data: { error: 'template_name or template_id required' } }, 400);

      const targetBotId = pickBotForCategory(category || templateForBot?.category);
      if (!targetBotId) return c.json({ data: { error: 'RCS Bot ID not configured' } }, 400);

      const idOrName = templateForBot?.vendor_template_id || name;
      const { ok, status, data } = await rcsFetch(
        `/templateapi/v1/bots/${encodeURIComponent(targetBotId)}/templates/${encodeURIComponent(idOrName)}`,
        { method: 'GET', token }
      );
      if (!ok) return c.json({ data: { error: data?.message || `HTTP ${status}`, details: data } }, 400);
      return c.json({ data: { success: true, template: data } });
    }

    // ─── DELETE TEMPLATE (Voda Template API) ───
    if (action === 'delete') {
      if (!template_id) return c.json({ data: { error: 'template_id required' } }, 400);

      const template = await base44.asServiceRole.entities.MessageTemplate.get(template_id);
      if (!template || template.client_id !== targetClient.id) {
        return c.json({ data: { error: 'Template not found' } }, 404);
      }

      const targetBotId = pickBotForCategory(template.category);
      if (!targetBotId) return c.json({ data: { error: 'RCS Bot ID not configured' } }, 400);

      // Only call remote delete if it was actually submitted there
      if (template.vendor_template_id || template.approval_status !== 'draft') {
        const idOrName = template.vendor_template_id || template.name;
        const { ok, status, data } = await rcsFetch(
          `/templateapi/v1/bots/${encodeURIComponent(targetBotId)}/templates/${encodeURIComponent(idOrName)}`,
          { method: 'DELETE', token }
        );
        // Tolerate "not found" upstream — treat as success so local cleanup proceeds
        if (!ok && status !== 404) {
          return c.json({ data: { error: data?.message || `HTTP ${status}`, details: data } }, 400);
        }
      }
      await base44.asServiceRole.entities.MessageTemplate.delete(template_id);
      return c.json({ data: { success: true } });
    }

    // ─── SYNC TEMPLATES from Voda Template API ───
    if (action === 'sync') {
      const bots = [transBotId, promoBotId].filter((b, i, arr) => b && arr.indexOf(b) === i);
      if (bots.length === 0) return c.json({ data: { error: 'No RCS Bot IDs configured' } }, 400);

      const results = [];
      let synced = 0;
      for (const b of bots) {
        const { ok, status, data } = await rcsFetch(
          `/templateapi/v1/bots/${encodeURIComponent(b)}/templates`,
          { method: 'GET', token }
        );
        if (!ok) {
          results.push({ bot: b, error: data?.message || `HTTP ${status}` });
          continue;
        }
        const list = Array.isArray(data) ? data : (data?.templates || data?.data || []);
        for (const remote of list) {
          const name = remote?.name || remote?.templateName || remote?.template_name;
          if (!name) continue;
          const remoteStatus = String(remote?.status || remote?.approval_status || 'pending').toLowerCase();
          const mapped = ['approved', 'pending', 'rejected', 'paused', 'disabled'].includes(remoteStatus) ? remoteStatus : 'pending';
          const existing = await base44.asServiceRole.entities.MessageTemplate.filter({
            client_id: targetClient.id, channel: 'rcs', name
          });
          if (existing.length > 0) {
            await base44.asServiceRole.entities.MessageTemplate.update(existing[0].id, {
              vendor_template_id: remote?.id || remote?.templateId || existing[0].vendor_template_id || name,
              approval_status: mapped,
              last_synced_at: new Date().toISOString()
            });
            results.push({ name, action: 'updated', status: mapped });
          } else {
            await base44.asServiceRole.entities.MessageTemplate.create({
              client_id: targetClient.id,
              vendor: 'rcs_digital',
              channel: 'rcs',
              name,
              category: String(remote?.category || 'UTILITY').toUpperCase(),
              language: remote?.language || 'en',
              body: remote?.contentMessage?.text || remote?.body || '',
              vendor_template_id: remote?.id || remote?.templateId || name,
              approval_status: mapped,
              last_synced_at: new Date().toISOString()
            });
            results.push({ name, action: 'created', status: mapped });
          }
          synced++;
        }
      }
      return c.json({ data: { success: true, synced, results } });
    }

    // ─── SEND TEST MESSAGE ───
    if (action === 'send_test_message') {
      const { to, template_name, variables, var_keys, category } = body;
      if (!to) return c.json({ data: { error: 'to (phone number) required' } }, 400);
      if (!template_name) return c.json({ data: { error: 'template_name required' } }, 400);
      const targetBotId = pickBotForCategory(category);
      if (!targetBotId) return c.json({ data: { error: 'RCS Bot ID not configured' } }, 400);

      let normalizedTo = String(to).replace(/[^0-9]/g, '');
      if (normalizedTo.length === 10) normalizedTo = '91' + normalizedTo;

      // Use caller-supplied var_keys (named placeholders like "Yadav", "AIvoice").
      // Fallback to property1, property2... if no keys are supplied (legacy).
      const varObject = {};
      const keys = Array.isArray(var_keys) ? var_keys : [];
      (variables || []).forEach((v, i) => {
        const key = (keys[i] && String(keys[i]).trim()) || `property${i + 1}`;
        varObject[key] = String(v);
      });

      const payload = {
        botid: targetBotId,
        templatename: template_name,
        destination: [normalizedTo],
        var: varObject,
        callbackdata: `test:${targetClient.id}`
      };

      const { ok, status, data } = await rcsFetch(
        `/api/v1/Rcs/sendmessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), token }
      );
      if (!ok) {
        return c.json({ data: { error: data?.message || data?.error?.message || `HTTP ${status}`, details: data } }, 400);
      }
      return c.json({ data: { success: true, message_id: data?.messageId || data?.id, response: data } });
    }

    // ─── CHECK PHONE CAPABILITIES (does it support RCS?) ───
    if (action === 'check_capabilities') {
      const { phone } = body;
      if (!phone) return c.json({ data: { error: 'phone required' } }, 400);
      let normalized = String(phone).replace(/[^0-9]/g, '');
      if (normalized.length === 10) normalized = '91' + normalized;

      const qs = botId ? `?botId=${encodeURIComponent(botId)}` : '';
      const { ok, status, data } = await rcsFetch(
        `/VodaWrapperRcs/v1/phones/${encodeURIComponent(normalized)}/capabilitiesCheck${qs}`,
        { token }
      );
      if (!ok) return c.json({ data: { error: data?.message || `HTTP ${status}`, details: data } }, 400);
      return c.json({ data: { success: true, phone: normalized, capabilities: data } });
    }

    return c.json({ data: { error: `Unknown action: ${action}` } }, 400);
  } catch (error) {
    console.error('rcsDigitalRcsSync error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};