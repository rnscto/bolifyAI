import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// twilioSearchAvailableNumbers — Preview (search) numbers available to
// PURCHASE from Twilio's marketplace, filtered by country code.
//
// This does NOT purchase or modify anything. Read-only preview for sales
// & ops to confirm Tier 1 country coverage before promising a market.
//
// Twilio API:
//   GET https://api.twilio.com/2010-04-01/Accounts/{SID}
//       /AvailablePhoneNumbers/{CountryISO}/{Type}.json
//   Type = Local | TollFree | Mobile
//
// Admin-only.
// ═══════════════════════════════════════════════════════════════════════



// Tier 1 ISO codes (matches lib/twilioCoverage.js tier 1 entries).
// Search is locked to this list so sales can't preview unsupported markets.
const TIER1_ISO = new Set([
  'US', 'CA', 'GB', 'AU', 'NZ', 'IE', 'NL', 'SE', 'DK', 'NO', 'FI', 'EE',
]);

function currencyFor(iso) {
  if (iso === 'US' || iso === 'CA') return 'USD';
  if (iso === 'GB') return 'GBP';
  if (iso === 'AU' || iso === 'NZ') return 'USD';
  return 'EUR';
}

export default async function twilioSearchAvailableNumbers(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin') return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);

    const body = await c.req.json().catch(() => ({}));
    const countryIso = String(body.country || '').toUpperCase();
    const type = String(body.type || 'Local'); // Local | TollFree | Mobile
    const areaCode = body.area_code ? String(body.area_code).replace(/\D/g, '') : '';
    const contains = body.contains ? String(body.contains).trim() : '';
    const limit = Math.min(parseInt(body.limit) || 20, 50);

    if (!countryIso) {
      return c.json({ data: { success: false, error: 'country (ISO code) is required' } }, 400);
    }
    if (!TIER1_ISO.has(countryIso)) {
      return c.json({ data: {
        success: false,
        error: `Country "${countryIso}" is not in VaaniAI's Tier 1 supported list. Tier 1: ${[...TIER1_ISO].join(', ')}`,
      } }, 400);
    }
    if (!['Local', 'TollFree', 'Mobile'].includes(type)) {
      return c.json({ data: { success: false, error: 'type must be Local, TollFree, or Mobile' } }, 400);
    }

    const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    if (!twilioSid || !twilioToken) {
      return c.json({ data: { success: false, error: 'Twilio credentials not configured' } }, 500);
    }
    const auth = btoa(`${twilioSid}:${twilioToken}`);

    const params = new URLSearchParams();
    params.set('PageSize', String(limit));
    if (areaCode) params.set('AreaCode', areaCode);
    if (contains) params.set('Contains', contains);

    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/AvailablePhoneNumbers/${countryIso}/${type}.json?${params.toString()}`;
    const r = await fetch(url, { headers: { 'Authorization': `Basic ${auth}` } });

    if (!r.ok) {
      const errText = await r.text();
      console.error('[twilioSearchAvailableNumbers] Twilio error:', r.status, errText);
      return c.json({ data: {
        success: false,
        error: `Twilio API error ${r.status}: ${errText.slice(0, 400)}`,
      } }, r.status === 404 ? 404 : 500);
    }

    const data = await r.json();
    const list = data.available_phone_numbers || [];
    const numbers = list.map((n) => ({
      phone_number: n.phone_number,
      friendly_name: n.friendly_name,
      locality: n.locality || '',
      region: n.region || '',
      iso_country: n.iso_country || countryIso,
      capabilities: n.capabilities || {},
      address_requirements: n.address_requirements || 'none',
      beta: !!n.beta,
    }));

    return c.json({ data: {
      success: true,
      country: countryIso,
      type,
      currency: currencyFor(countryIso),
      count: numbers.length,
      numbers,
    } });
  } catch (error) {
    console.error('[twilioSearchAvailableNumbers] Error:', error);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};