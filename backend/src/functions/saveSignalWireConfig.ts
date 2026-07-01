import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Admin-only: tests then saves SignalWire credentials to the SignalWireConfig entity (single row).


export default async function saveSignalWireConfig(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const project_id = (body.project_id || '').trim();
    const api_token = (body.api_token || '').trim();
    const space_url = (body.space_url || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');

    if (!project_id || !api_token || !space_url) {
      return c.json({ data: { ok: false, error: 'project_id, api_token, and space_url are required' } }, 400);
    }

    // Step 1 — test credentials before saving
    const testUrl = `https://${space_url}/api/laml/2010-04-01/Accounts/${project_id}.json`;
    const auth = btoa(`${project_id}:${api_token}`);
    const testRes = await fetch(testUrl, { headers: { 'Authorization': `Basic ${auth}` } });
    const testText = await testRes.text();

    if (!testRes.ok) {
      let msg = `HTTP ${testRes.status}`;
      try { msg = JSON.parse(testText)?.message || msg; } catch { /* ignore */ }
      console.error('[saveSignalWireConfig] credential test failed', testRes.status, testText.slice(0, 300));
      return c.json({ data: {
        ok: false,
        error: `Credential test failed: ${msg}`,
        status: testRes.status,
      } }, 400);
    }

    // Step 2 — build save payload
    const payload = {
      project_id,
      api_token,
      signing_key: (body.signing_key || '').trim(),
      space_url,
      default_did: (body.default_did || '').trim(),
      available_dids: Array.isArray(body.available_dids)
        ? body.available_dids.map((d) => String(d).trim()).filter(Boolean)
        : (body.default_did ? [String(body.default_did).trim()] : []),
      stream_wss_url: (body.stream_wss_url || '').trim(),
      status_callback_url: (body.status_callback_url || '').trim(),
      cnam_display_name: (body.cnam_display_name || '').trim(),
      stir_shaken_attestation: body.stir_shaken_attestation || 'auto',
      region: body.region || 'US',
      is_active: body.is_active !== false,
      last_tested_at: new Date().toISOString(),
      last_test_status: 'success',
      last_test_error: '',
    };

    // Step 3 — upsert single row
    const existing = await base44.asServiceRole.entities.SignalWireConfig.list('-created_date', 1);
    let saved;
    if (existing.length > 0) {
      saved = await base44.asServiceRole.entities.SignalWireConfig.update(existing[0].id, payload);
    } else {
      saved = await base44.asServiceRole.entities.SignalWireConfig.create(payload);
    }

    console.log('[saveSignalWireConfig] saved config', saved.id);
    return c.json({ data: { ok: true, config_id: saved.id } });
  } catch (error) {
    console.error('[saveSignalWireConfig] error', error);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};