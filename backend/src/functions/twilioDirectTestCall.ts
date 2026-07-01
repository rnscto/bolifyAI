import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Minimal Twilio outbound test — bypasses our entire stack.
// Calls Twilio's REST API directly with TwiML <Say>, so we can isolate
// whether error 21216 is from our request format or from the DID itself.
//
// Usage: base44.functions.invoke('twilioDirectTestCall', { to: '+15551234567' })
// Admin-only.



export default async function twilioDirectTestCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);
    }

    const { to, from } = await c.req.json();
    if (!to) return c.json({ data: { error: 'Missing "to"' } }, 400);

    const sid = (Deno.env.get('TWILIO_ACCOUNT_SID') || '').trim();
    const token = (Deno.env.get('TWILIO_AUTH_TOKEN') || '').trim();
    const fromNumber = (from || '+16672290576').trim();

    if (!sid || !token) {
      return c.json({ data: { error: 'Twilio creds missing' } }, 500);
    }

    // Simplest possible TwiML — just say a word and hang up. No streams, no callbacks.
    const twiml = '<Response><Say>Test call from Vaani AI. Goodbye.</Say></Response>';

    const body = new URLSearchParams({
      To: to,
      From: fromNumber,
      Twiml: twiml,
    });

    const auth = btoa(`${sid}:${token}`);
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );

    const data = await resp.json();
    console.log('[twilioDirectTestCall]', { status: resp.status, from: fromNumber, to, response: data });

    return c.json({ data: {
      success: resp.ok,
      http_status: resp.status,
      from: fromNumber,
      to,
      twilio_response: data,
      diagnosis: resp.ok
        ? '✅ Call placed successfully — number works for outbound.'
        : data.code === 21216
          ? `❌ Error 21216 even on bare minimum call. The DID ${fromNumber} cannot place outbound calls. Contact Twilio Support and ask: "Why does my number ${fromNumber} return error 21216 on every outbound call?"`
          : `❌ Twilio rejected with code ${data.code}: ${data.message}`,
    } });
  } catch (error) {
    console.error('[twilioDirectTestCall] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};