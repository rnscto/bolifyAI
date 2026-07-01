import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Admin-only: tests SignalWire credentials against the LaML REST API.
// Hits GET /api/laml/2010-04-01/Accounts/{ProjectID}.json — returns account status.


export default async function checkSignalWireCreds(c: any) {
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
      return c.json({ data: {
        ok: false,
        error: 'Missing required fields: project_id, api_token, space_url',
      } }, 400);
    }

    const url = `https://${space_url}/api/laml/2010-04-01/Accounts/${project_id}.json`;
    const auth = btoa(`${project_id}:${api_token}`);

    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const ms = Date.now() - t0;
    const text = await res.text();

    let payload = null;
    try { payload = JSON.parse(text); } catch { /* not JSON */ }

    if (!res.ok) {
      console.error('[checkSignalWireCreds] failed', res.status, text.slice(0, 500));
      return c.json({ data: {
        ok: false,
        status: res.status,
        error: payload?.message || text.slice(0, 300) || `HTTP ${res.status}`,
        ms,
      } });
    }

    return c.json({ data: {
      ok: true,
      status: res.status,
      ms,
      account_name: payload?.friendly_name || null,
      account_status: payload?.status || null,
      account_type: payload?.type || null,
    } });
  } catch (error) {
    console.error('[checkSignalWireCreds] error', error);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};