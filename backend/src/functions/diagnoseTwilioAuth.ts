import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Diagnostic: verifies the TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN secrets
// actually authenticate against Twilio's REST API. Returns the exact Twilio
// response so we can see if it's a credential, account-status, or DID-ownership issue.


export default async function diagnoseTwilioAuth(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);
    }

    const sid = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
    const token = Deno.env.get('TWILIO_AUTH_TOKEN') || '';

    const sidInfo = {
      length: sid.length,
      starts_with: sid.substring(0, 4),
      has_whitespace: /\s/.test(sid),
      looks_valid: /^AC[a-f0-9]{32}$/i.test(sid),
    };
    const tokenInfo = {
      length: token.length,
      has_whitespace: /\s/.test(token),
    };

    // 1. Verify auth against /Accounts/{sid}.json
    const authHeader = 'Basic ' + btoa(`${sid}:${token}`);
    const acctRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: authHeader }
    });
    const acctBody = await acctRes.json();

    // 2. If auth works, list the first few incoming phone numbers to confirm DID ownership
    let incomingNumbers = null;
    if (acctRes.ok) {
      const numRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=20`, {
        headers: { Authorization: authHeader }
      });
      const numBody = await numRes.json();
      incomingNumbers = {
        status: numRes.status,
        count: numBody.incoming_phone_numbers?.length || 0,
        numbers: (numBody.incoming_phone_numbers || []).map(n => ({
          phone_number: n.phone_number,
          friendly_name: n.friendly_name,
          status: n.status,
        })),
      };
    }

    return c.json({ data: {
      sid_info: sidInfo,
      token_info: tokenInfo,
      auth_check: {
        http_status: acctRes.status,
        ok: acctRes.ok,
        account_status: acctBody.status,
        account_type: acctBody.type,
        friendly_name: acctBody.friendly_name,
        twilio_error: acctBody.code ? {
          code: acctBody.code,
          message: acctBody.message,
          more_info: acctBody.more_info,
        } : null,
      },
      incoming_numbers: incomingNumbers,
      target_did_check: incomingNumbers
        ? {
            looking_for: '+16672290576',
            found: (incomingNumbers.numbers || []).some(n => n.phone_number === '+16672290576'),
          }
        : null,
    } });
  } catch (error) {
    return c.json({ data: { error: error.message, stack: error.stack } }, 500);
  }

};