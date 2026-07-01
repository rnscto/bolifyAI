import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// RCS Digital (rcsdigital.in) — Full WhatsApp CPaaS integration.
// RCS Digital proxies Meta's Graph API on their own domain. All endpoints have
// the same shape as Meta's Cloud API, just with base URL swapped.
//
// Base URL: https://rcsdigital.in
// Auth:     Bearer <whatsapp_api_key>
// Version:  v23.0 (configurable — stored on config.whatsapp_api_endpoint if custom)
//
// Actions supported via payload.action:
//   - "test_connection"   : verify credentials by listing templates
//   - "submit"            : create a new template on RCS Digital
//   - "sync"              : pull all templates from RCS Digital into local DB
//   - "get_template"      : fetch one template by vendor_template_id
//   - "delete"            : delete a template by name
//   - "send_test_message" : send a real template message to a test number
//   - "upload_media"      : upload media and return media_id (expects file_url)
//   - "get_channels"      : list WhatsApp channels linked to the WABA



const RCS_BASE = 'https://rcsdigital.in';
const VERSION = 'v23.0';

// Upload media to Meta's Resumable Upload API (proxied by RCS Digital) and
// return the file handle (h:...) required by message-template media headers.
// A raw URL in header_handle is silently dropped by Meta → template approved
// without a header. The handle is mandatory.
async function uploadMediaHandle(mediaUrl, token, appId) {
  if (!appId) throw new Error('NO_APP_ID');
  // 1. Fetch the file bytes
  const fileRes = await fetch(mediaUrl);
  if (!fileRes.ok) throw new Error('Could not fetch header media file');
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  const fileLength = bytes.length;
  const fileType = fileRes.headers.get('content-type') || 'application/octet-stream';
  const fileName = (mediaUrl.split('/').pop() || 'file').split('?')[0];

  // 2. Start a resumable upload session — Meta requires this be App-scoped.
  const startRes = await rcsFetch(
    `/${VERSION}/${appId}/uploads?file_length=${fileLength}&file_type=${encodeURIComponent(fileType)}&file_name=${encodeURIComponent(fileName)}`,
    { method: 'POST', token }
  );
  if (!startRes.ok || !startRes.data?.id) {
    throw new Error(`Resumable upload session failed: ${startRes.data?.error?.message || JSON.stringify(startRes.data)}`);
  }
  const sessionId = startRes.data.id;

  // 3. Upload the bytes (offset 0)
  const uploadRes = await fetch(`${RCS_BASE}/${VERSION}/${sessionId}`, {
    method: 'POST',
    headers: { 'Authorization': `OAuth ${token}`, 'file_offset': '0' },
    body: bytes,
  });
  const uploadText = await uploadRes.text();
  let uploadData; try { uploadData = JSON.parse(uploadText); } catch { uploadData = uploadText; }
  if (!uploadRes.ok || !uploadData?.h) {
    throw new Error(`Media upload failed: ${uploadData?.error?.message || JSON.stringify(uploadData)}`);
  }
  return uploadData.h;
}

async function buildTemplateComponents(template, token, appId) {
  const components = [];

  // Header
  if (template.header_type && template.header_type !== 'none') {
    if (template.header_type === 'text' && template.header_text) {
      components.push({ type: 'HEADER', format: 'TEXT', text: template.header_text });
    } else if (['image', 'video', 'document'].includes(template.header_type) && template.header_media_url) {
      // Media headers normally need a resumable-upload file handle (requires a
      // Meta App ID). For third-party-managed WABAs the client usually doesn't
      // have the App ID — in that case fall back to submitting the header with
      // the raw media URL so the template still goes through.
      if (appId) {
        const handle = await uploadMediaHandle(template.header_media_url, token, appId);
        components.push({
          type: 'HEADER',
          format: template.header_type.toUpperCase(),
          example: { header_handle: [template.header_media_url] }
        });
        // overwrite with the real handle (kept separate for clarity)
        components[components.length - 1].example.header_handle = [handle];
      } else {
        components.push({
          type: 'HEADER',
          format: template.header_type.toUpperCase(),
          example: { header_handle: [template.header_media_url] }
        });
      }
    }
  }

  // Body (required)
  const bodyComponent = { type: 'BODY', text: template.body };
  if (template.sample_values?.length > 0) {
    bodyComponent.example = { body_text: [template.sample_values] };
  }
  components.push(bodyComponent);

  // Footer
  if (template.footer_text) components.push({ type: 'FOOTER', text: template.footer_text });

  // Buttons
  if (template.buttons?.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: template.buttons.map(b => {
        if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.url };
        if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
        if (b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text };
        if (b.type === 'OTP') return { type: 'OTP', otp_type: 'COPY_CODE', text: b.text };
        return null;
      }).filter(Boolean)
    });
  }

  return components;
}

function mapMetaStatus(metaStatus) {
  const s = (metaStatus || '').toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'pending') return 'pending';
  if (s === 'rejected') return 'rejected';
  if (s === 'paused') return 'paused';
  if (s === 'disabled') return 'disabled';
  return 'pending';
}

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

export default async function rcsDigitalTemplateSync(c: any) {
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

    const token = config.whatsapp_api_key;
    const wabaId = config.whatsapp_business_id;
    const phoneNumberId = config.whatsapp_phone_number_id;

    // ─── TEST CONNECTION ───
    if (action === 'test_connection') {
      if (!token || !wabaId) {
        return c.json({ data: { success: false, error: 'Missing API token or WABA ID' } });
      }
      const { ok, status, data } = await rcsFetch(
        `/${VERSION}/${wabaId}/message_templates?limit=1`,
        { token }
      );
      await base44.asServiceRole.entities.ClientMessagingConfig.update(config.id, {
        whatsapp_status: ok ? 'connected' : 'error',
        whatsapp_last_tested: new Date().toISOString()
      });
      // Extract clearest error message from RCS Digital's response shape
      let errorMsg = null;
      if (!ok) {
        const rcsMsg = data?.response?.[0]?.message || data?.details?.response?.[0]?.message;
        const metaMsg = data?.error?.message;
        errorMsg = rcsMsg || metaMsg || data?.error || `HTTP ${status}`;
        if (status === 403 && /api access is disabled/i.test(errorMsg)) {
          errorMsg = 'API access is disabled for this RCS Digital account. Contact RCS Digital support to enable WhatsApp Cloud API access on your account.';
        }
      }
      return c.json({ data: {
        success: ok,
        status_code: status,
        error: errorMsg,
        details: ok ? null : data
      } });
    }

    // ─── SUBMIT / CREATE TEMPLATE ───
    if (action === 'submit') {
      if (!template_id) return c.json({ data: { error: 'template_id required' } }, 400);
      if (!wabaId) return c.json({ data: { error: 'WABA ID not configured' } }, 400);

      const template = await base44.asServiceRole.entities.MessageTemplate.get(template_id);
      if (!template || template.client_id !== targetClient.id) {
        return c.json({ data: { error: 'Template not found' } }, 404);
      }
      if (template.channel !== 'whatsapp') {
        return c.json({ data: { error: 'Only WhatsApp templates supported here' } }, 400);
      }

      // If this template was already created on the vendor (has a vendor_template_id),
      // we must EDIT the existing template (POST /{template_id}) instead of creating a
      // new one — Meta/RCS rejects creating a duplicate name. Editing puts an approved
      // template back into PENDING for re-approval. Note: name/language/category cannot
      // be changed on edit, so we only send the components.
      const isEdit = !!template.vendor_template_id;

      const metaAppId = config.whatsapp_app_id;
      const components = await buildTemplateComponents(template, token, metaAppId);
      const payload = isEdit
        ? { components }
        : {
            name: template.name,
            category: template.category || 'UTILITY',
            language: template.language || 'en',
            components
          };

      const path = isEdit
        ? `/${VERSION}/${template.vendor_template_id}`
        : `/${VERSION}/${wabaId}/message_templates`;

      const { ok, status, data } = await rcsFetch(
        path,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), token }
      );
      if (!ok) {
        return c.json({ data: {
          error: data?.error?.message || `HTTP ${status}`,
          details: data
        } }, 400);
      }
      await base44.asServiceRole.entities.MessageTemplate.update(template_id, {
        vendor_template_id: isEdit ? template.vendor_template_id : data.id,
        // On edit, vendor returns success:true (no status) — force back to pending for re-approval
        approval_status: isEdit ? 'pending' : mapMetaStatus(data.status),
        submitted_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString()
      });
      return c.json({ data: { success: true, vendor_template_id: isEdit ? template.vendor_template_id : data.id, status: isEdit ? 'PENDING' : data.status } });
    }

    // ─── SYNC — pull all templates from RCS Digital ───
    if (action === 'sync') {
      if (!wabaId) return c.json({ data: { error: 'WABA ID not configured' } }, 400);

      const { ok, status, data } = await rcsFetch(
        `/${VERSION}/${wabaId}/message_templates?limit=200`,
        { token }
      );
      if (!ok) {
        return c.json({ data: { error: data?.error?.message || `HTTP ${status}`, details: data } }, 400);
      }

      const remoteTemplates = data?.data || [];
      const localTemplates = await base44.asServiceRole.entities.MessageTemplate.filter({
        client_id: targetClient.id, vendor: 'rcs_digital', channel: 'whatsapp'
      });
      const byName = new Map(localTemplates.map(t => [`${t.name}__${t.language}`, t]));

      const results = [];
      for (const rt of remoteTemplates) {
        const key = `${rt.name}__${rt.language}`;
        const local = byName.get(key);
        const bodyComp = (rt.components || []).find(c => c.type === 'BODY');
        const footerComp = (rt.components || []).find(c => c.type === 'FOOTER');
        const headerComp = (rt.components || []).find(c => c.type === 'HEADER');
        const buttonsComp = (rt.components || []).find(c => c.type === 'BUTTONS');

        const updates = {
          vendor_template_id: rt.id,
          approval_status: mapMetaStatus(rt.status),
          category: rt.category || 'UTILITY',
          body: bodyComp?.text || local?.body || '',
          footer_text: footerComp?.text || '',
          header_type: headerComp ? (headerComp.format || 'text').toLowerCase() : 'none',
          header_text: headerComp?.format === 'TEXT' ? headerComp.text : '',
          // Meta/RCS does not return the original media URL on sync, only a
          // re-uploadable handle. Preserve the locally-saved media URL so
          // document/image/video headers keep their file after syncing.
          header_media_url: local?.header_media_url || '',
          buttons: buttonsComp?.buttons || [],
          last_synced_at: new Date().toISOString(),
        };
        if (updates.approval_status === 'approved' && !local?.approved_at) {
          updates.approved_at = new Date().toISOString();
        }
        if (updates.approval_status === 'rejected') {
          updates.rejection_reason = rt.rejected_reason || rt.reason || '';
        }

        if (local) {
          await base44.asServiceRole.entities.MessageTemplate.update(local.id, updates);
          results.push({ name: rt.name, action: 'updated', status: updates.approval_status });
        } else {
          await base44.asServiceRole.entities.MessageTemplate.create({
            client_id: targetClient.id,
            vendor: 'rcs_digital',
            channel: 'whatsapp',
            name: rt.name,
            language: rt.language || 'en',
            ...updates
          });
          results.push({ name: rt.name, action: 'imported', status: updates.approval_status });
        }
      }
      return c.json({ data: { success: true, total: remoteTemplates.length, synced: results.length, results } });
    }

    // ─── GET TEMPLATE BY ID ───
    if (action === 'get_template') {
      const { vendor_template_id } = body;
      if (!vendor_template_id) return c.json({ data: { error: 'vendor_template_id required' } }, 400);
      const { ok, status, data } = await rcsFetch(`/${VERSION}/${vendor_template_id}`, { token });
      if (!ok) return c.json({ data: { error: data?.error?.message || `HTTP ${status}`, details: data } }, 400);
      return c.json({ data: { success: true, template: data } });
    }

    // ─── DELETE TEMPLATE ───
    if (action === 'delete') {
      if (!template_id) return c.json({ data: { error: 'template_id required' } }, 400);
      if (!wabaId) return c.json({ data: { error: 'WABA ID not configured' } }, 400);

      const template = await base44.asServiceRole.entities.MessageTemplate.get(template_id);
      if (!template || template.client_id !== targetClient.id) {
        return c.json({ data: { error: 'Template not found' } }, 404);
      }

      // RCS Digital (Meta-compatible) delete: DELETE /{version}/{wabaId}/message_templates?name={name}
      const { ok, status, data } = await rcsFetch(
        `/${VERSION}/${wabaId}/message_templates?name=${encodeURIComponent(template.name)}`,
        { method: 'DELETE', token }
      );
      if (!ok) {
        return c.json({ data: { error: data?.error?.message || `HTTP ${status}`, details: data } }, 400);
      }
      await base44.asServiceRole.entities.MessageTemplate.delete(template_id);
      return c.json({ data: { success: true } });
    }

    // ─── SEND TEST MESSAGE ───
    if (action === 'send_test_message') {
      const { to, template_name, language, variables } = body;
      if (!to) return c.json({ data: { error: 'to (phone number) required' } }, 400);
      if (!template_name) return c.json({ data: { error: 'template_name required' } }, 400);
      if (!phoneNumberId) return c.json({ data: { error: 'WhatsApp Phone Number ID not configured' } }, 400);

      // Load the template (if id supplied) so we can attach header media.
      let tpl = null;
      if (template_id) {
        tpl = await base44.asServiceRole.entities.MessageTemplate.get(template_id).catch(() => null);
      }

      const components = [];

      // Header media (image/video/document) — required at send time when the
      // template was approved with a media header, otherwise the file won't arrive.
      if (tpl && ['image', 'video', 'document'].includes(tpl.header_type) && tpl.header_media_url) {
        const mediaObj = { link: tpl.header_media_url };
        if (tpl.header_type === 'document') {
          mediaObj.filename = (tpl.header_media_url.split('/').pop() || 'document.pdf').split('?')[0];
        }
        components.push({
          type: 'header',
          parameters: [{ type: tpl.header_type, [tpl.header_type]: mediaObj }]
        });
      }

      if (variables && variables.length > 0) {
        components.push({
          type: 'body',
          parameters: variables.map(v => ({ type: 'text', text: String(v) }))
        });
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(to).replace(/[^0-9]/g, ''),
        type: 'template',
        template: {
          name: template_name,
          language: { code: language || 'en' },
          ...(components.length > 0 && { components })
        }
      };

      let { ok, status, data } = await rcsFetch(
        `/${VERSION}/${phoneNumberId}/messages`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), token }
      );

      // If the approved template has no header component but we sent a header
      // parameter (local record out of sync with vendor), Meta returns 132018.
      // Retry once without the header component so the test send still works.
      const headerMismatch = !ok && data?.error?.code === 132018 &&
        /header|title component/i.test(data?.error?.error_data?.details || '');
      if (headerMismatch && payload.template.components) {
        payload.template.components = payload.template.components.filter(c => c.type !== 'header');
        if (payload.template.components.length === 0) delete payload.template.components;
        ({ ok, status, data } = await rcsFetch(
          `/${VERSION}/${phoneNumberId}/messages`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), token }
        ));
      }

      if (!ok) {
        return c.json({ data: { error: data?.error?.message || `HTTP ${status}`, details: data } }, 400);
      }
      return c.json({ data: { success: true, message_id: data?.messages?.[0]?.id, response: data } });
    }

    // ─── UPLOAD MEDIA ───
    if (action === 'upload_media') {
      const { file_url } = body;
      if (!file_url) return c.json({ data: { error: 'file_url required' } }, 400);
      if (!phoneNumberId) return c.json({ data: { error: 'WhatsApp Phone Number ID not configured' } }, 400);

      // Fetch the file from Base44 storage
      const fileRes = await fetch(file_url);
      if (!fileRes.ok) return c.json({ data: { error: 'Failed to fetch file' } }, 400);
      const fileBlob = await fileRes.blob();
      const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
      const fileName = file_url.split('/').pop() || 'upload';

      const formData = new FormData();
      formData.append('file', fileBlob, fileName);
      formData.append('type', contentType);
      formData.append('messaging_product', 'whatsapp');

      const { ok, status, data } = await rcsFetch(
        `/${VERSION}/${phoneNumberId}/media`,
        { method: 'POST', body: formData, token }
      );
      if (!ok) {
        return c.json({ data: { error: data?.error?.message || `HTTP ${status}`, details: data } }, 400);
      }
      return c.json({ data: { success: true, media_id: data?.id, response: data } });
    }

    // ─── GET CHANNELS ───
    if (action === 'get_channels') {
      const { ok, status, data } = await rcsFetch(`/${VERSION}/channels`, { token });
      if (!ok) return c.json({ data: { error: data?.error?.message || `HTTP ${status}`, details: data } }, 400);
      return c.json({ data: { success: true, channels: data?.data || data } });
    }

    return c.json({ data: { error: `Unknown action: ${action}` } }, 400);
  } catch (error) {
    console.error('rcsDigitalTemplateSync error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};