import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// ─── Phone normalization (E.164) ───
function normalizeToE164(phone) {
  const clean = String(phone || '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+')) return clean;
  if (/^1\d{10}$/.test(clean)) return '+' + clean;
  if (/^44\d{9,10}$/.test(clean)) return '+' + clean;
  // 10-digit US-style → assume US
  if (/^\d{10}$/.test(clean)) return '+1' + clean;
  return clean.startsWith('+') ? clean : '+' + clean;
}

function detectCountry(e164) {
  if (e164.startsWith('+1')) return 'US';
  if (e164.startsWith('+44')) return 'GB';
  return 'OTHER';
}

// ─── Optional FreeDNCList.com API check ───
// Only fires if FREEDNCLIST_API_KEY secret is set. Caches results in DncList
// with a 30-day TTL to keep API costs down.
async function queryFreeDncList(e164) {
  const apiKey = Deno.env.get('FREEDNCLIST_API_KEY');
  if (!apiKey) return { checked: false };

  try {
    const phone = e164.replace(/^\+/, '');
    const res = await fetch(`https://api.freednclist.com/v1/check?phone=${phone}&apikey=${apiKey}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      console.error(`[checkDnc] FreeDNCList API ${res.status}`);
      return { checked: false };
    }
    const data = await res.json();
    return { checked: true, is_dnc: !!data.is_dnc, raw: data };
  } catch (err) {
    console.error('[checkDnc] FreeDNCList error:', err.message);
    return { checked: false };
  }
}

export default async function checkDnc(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const { phone_number, client_id } = await c.req.json();

    if (!phone_number) {
      return c.json({ data: { error: 'Missing phone_number' } }, 400);
    }

    const e164 = normalizeToE164(phone_number);
    const country = detectCountry(e164);

    // Only enforce DNC for US + UK numbers
    if (country !== 'US' && country !== 'GB') {
      return c.json({ data: { is_dnc: false, country, skipped: true } });
    }

    // 1) Check internal DncList (platform-wide + client-specific)
    const matches = await base44.asServiceRole.entities.DncList.filter({ phone_e164: e164 });
    const live = matches.filter((m) => {
      if (!m.cached_until) return true;
      return new Date(m.cached_until) > new Date();
    });
    const platformHit = live.find((m) => !m.client_id);
    const clientHit = client_id ? live.find((m) => m.client_id === client_id) : null;

    if (platformHit || clientHit) {
      const hit = platformHit || clientHit;
      return c.json({ data: {
        is_dnc: true,
        country,
        source: hit.source,
        reason: hit.reason || 'On internal DNC suppression list',
        e164
      } });
    }

    // 2) Optional external check
    const ext = await queryFreeDncList(e164);
    if (ext.checked && ext.is_dnc) {
      // Cache result for 30 days
      const cachedUntil = new Date();
      cachedUntil.setDate(cachedUntil.getDate() + 30);
      try {
        await base44.asServiceRole.entities.DncList.create({
          phone_e164: e164,
          country_code: country,
          source: 'freednclist_api',
          reason: 'Listed on National DNC Registry (FreeDNCList)',
          cached_until: cachedUntil.toISOString()
        });
      } catch (e) {
        console.error('[checkDnc] cache write failed:', e.message);
      }
      return c.json({ data: {
        is_dnc: true,
        country,
        source: 'freednclist_api',
        reason: 'Listed on National DNC Registry',
        e164
      } });
    }

    return c.json({ data: { is_dnc: false, country, e164, external_checked: ext.checked } });
  } catch (error) {
    console.error('[checkDnc] error:', error);
    return c.json({ data: { error: error.message, is_dnc: false } }, 500);
  }

};