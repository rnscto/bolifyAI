import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// TEMP debug helper — fetches Smartflo's /v1/my_numbers so we can see the real field names/IDs.
// Call with {} payload. Admin-only.


async function smartfloLogin() {
  const res = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: Deno.env.get('SMARTFLO_EMAIL'), password: Deno.env.get('SMARTFLO_PASSWORD') })
  });
  const data = await res.json();
  return data.access_token || data.token || data.data?.token;
}

export default async function debugSmartfloNumbers(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') return c.json({ data: { error: 'admin_only' } }, 403);

    const token = await smartfloLogin();
    const apiKey = Deno.env.get('SMARTFLO_API_KEY');

    // Also fetch roles list
    try {
      const rolesRes = await fetch('https://api-smartflo.tatateleservices.com/v1/user_roles', {
        headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
      });
      const rolesTxt = await rolesRes.text();
      console.log(`[debugSmartfloNumbers] /v1/user_roles status=${rolesRes.status} body=${rolesTxt.slice(0, 1500)}`);
    } catch (e) { console.log(`[debugSmartfloNumbers] roles err: ${e.message}`); }

    const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` };
    const endpoints = [
      '/v1/my_numbers',
      '/v1/my_number',
      '/v1/number',
      '/v1/numbers',
      '/v1/caller_id',
      '/v1/caller_ids',
      '/v1/did',
      '/v1/dids',
      '/v1/inbound_number',
      '/v1/inbound_numbers',
      '/v1/user/caller_id',
      '/v1/user/numbers'
    ];
    const attempts = [];
    const winners = [];
    for (const ep of endpoints) {
      try {
        const r = await fetch(`https://api-smartflo.tatateleservices.com${ep}`, { headers });
        const t = await r.text();
        const preview = t.slice(0, 500);
        attempts.push({ endpoint: ep, status: r.status, preview });
        if (r.ok) {
          let parsed = null; try { parsed = JSON.parse(t); } catch (_) {}
          const list = parsed?.data || parsed?.results || (Array.isArray(parsed) ? parsed : []);
          winners.push({ endpoint: ep, parsed_keys: parsed ? Object.keys(parsed) : null, count: Array.isArray(list) ? list.length : 'not-array', sample: Array.isArray(list) ? list.slice(0, 3) : parsed });
        }
      } catch (e) {
        attempts.push({ endpoint: ep, error: e.message });
      }
    }
    return c.json({ data: { winners, attempts } });
  } catch (e) {
    return c.json({ data: { error: e.message } }, 500);
  }

};