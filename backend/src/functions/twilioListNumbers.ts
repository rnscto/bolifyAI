import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// twilioListNumbers — Fetches all IncomingPhoneNumbers from the Twilio
// account and upserts them into the DID entity (provider='twilio').
// Admin-only.
//
// Twilio API:
//   GET https://api.twilio.com/2010-04-01/Accounts/{SID}/IncomingPhoneNumbers.json
//   Returns: { incoming_phone_numbers: [{ sid, phone_number, ... }] }
// ═══════════════════════════════════════════════════════════════════════



function detectCountry(phone) {
  const clean = String(phone || '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+1')) return 'US';
  if (clean.startsWith('+44')) return 'GB';
  if (clean.startsWith('+91')) return 'IN';
  return 'UNKNOWN';
}
function currencyFor(country) {
  if (country === 'US') return 'USD';
  if (country === 'GB') return 'GBP';
  if (country === 'IN') return 'INR';
  return 'USD';
}

export default async function twilioListNumbers(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin') return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);

    const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    if (!twilioSid || !twilioToken) {
      return c.json({ data: { success: false, error: 'Twilio credentials not configured' } }, 500);
    }
    const auth = btoa(`${twilioSid}:${twilioToken}`);

    // Build the inbound webhook URL — points to our twilioInboundWebhook fn.
    // Derived from TWILIO_STATUS_CALLBACK_URL (same base) so admin only needs one secret.
    const statusCb = Deno.env.get('TWILIO_STATUS_CALLBACK_URL') || '';
    const inboundUrl = statusCb.replace(/twilioWebhook(\/)?$/, 'twilioInboundWebhook');

    // Paginate Twilio's IncomingPhoneNumbers list
    const all = [];
    let url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers.json?PageSize=100`;
    while (url) {
      const r = await fetch(url, { headers: { 'Authorization': `Basic ${auth}` } });
      if (!r.ok) {
        const errText = await r.text();
        return c.json({ data: { success: false, error: `Twilio API error ${r.status}: ${errText}` } }, 500);
      }
      const data = await r.json();
      all.push(...(data.incoming_phone_numbers || []));
      url = data.next_page_uri ? `https://api.twilio.com${data.next_page_uri}` : null;
    }

    // Upsert each into DID entity (match by phone number)
    const svc = base44.asServiceRole;
    const existing = await svc.entities.DID.filter({ provider: 'twilio' }).catch(() => []);
    const byNumber = new Map(existing.map(d => [d.number, d]));

    let created = 0, updated = 0, wired = 0, wireFailed = 0;
    for (const tn of all) {
      const number = tn.phone_number;
      if (!number) continue;
      const country = detectCountry(number);
      const existingDid = byNumber.get(number);
      const payload = {
        number,
        country_code: country,
        provider: 'twilio',
        twilio_sid: tn.sid,
        currency: currencyFor(country),
      };
      if (existingDid) {
        await svc.entities.DID.update(existingDid.id, {
          twilio_sid: tn.sid,
          country_code: country,
          currency: currencyFor(country),
        });
        updated++;
      } else {
        await svc.entities.DID.create({
          ...payload,
          status: 'available',
          monthly_cost: country === 'US' ? 1 : country === 'GB' ? 1 : 0,
        });
        created++;
      }

      // ─── Auto-wire voice URL + status callback on the Twilio number ───
      // Only update if our URL isn't already set (don't clobber custom configs).
      if (inboundUrl && tn.sid) {
        const needsVoice = !tn.voice_url || tn.voice_url !== inboundUrl;
        const needsStatus = statusCb && tn.status_callback !== statusCb;
        if (needsVoice || needsStatus) {
          try {
            const form = new URLSearchParams();
            if (needsVoice) {
              form.set('VoiceUrl', inboundUrl);
              form.set('VoiceMethod', 'POST');
            }
            if (needsStatus) {
              form.set('StatusCallback', statusCb);
              form.set('StatusCallbackMethod', 'POST');
            }
            const updResp = await fetch(
              `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers/${tn.sid}.json`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${auth}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: form.toString(),
              }
            );
            if (updResp.ok) wired++; else wireFailed++;
          } catch (e) {
            console.error(`[twilioListNumbers] Wire failed for ${number}: ${e.message}`);
            wireFailed++;
          }
        }
      }
    }

    return c.json({ data: {
      success: true,
      message: `Synced ${all.length} Twilio numbers (${created} new, ${updated} updated, ${wired} auto-wired${wireFailed ? `, ${wireFailed} wire failures` : ''}).`,
      total: all.length, created, updated, wired, wire_failed: wireFailed,
      inbound_url: inboundUrl,
    } });
  } catch (error) {
    console.error('[twilioListNumbers] Error:', error);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};