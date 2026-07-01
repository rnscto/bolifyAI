import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Explicitly disconnect a Smartflo telephony call via API
// Uses Smartflo's hangup endpoint instead of call/options

// Simple in-memory token cache to avoid Smartflo login rate-limiting
let _cachedToken = null;
let _tokenExpiry = 0;

async function getSmartfloToken() {
  // Return cached token if still valid (cache for 10 minutes)
  if (_cachedToken && Date.now() < _tokenExpiry) {
    return _cachedToken;
  }

  const sfEmail = Deno.env.get('SMARTFLO_EMAIL');
  const sfPassword = Deno.env.get('SMARTFLO_PASSWORD');
  if (!sfEmail || !sfPassword) {
    throw new Error('Missing Smartflo credentials');
  }

  const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: sfEmail, password: sfPassword })
  });
  const loginData = await loginResp.json();
  const token = loginData.access_token || loginData.token;
  if (!token) {
    throw new Error(`Smartflo login failed: ${loginData.message || JSON.stringify(loginData)}`);
  }

  _cachedToken = token;
  _tokenExpiry = Date.now() + 10 * 60 * 1000; // 10 min cache
  console.log('[disconnectCall] Smartflo login successful (token cached)');
  return token;
}

// Look up the LIVE Smartflo call_id from /v1/live_calls using callee/caller phone numbers.
// The WebSocket streamSid (e.g. "h11.08-1776875353.216650") is NOT the same as the live call_id —
// Smartflo requires the numeric call_id from the live_calls endpoint to hang up.
async function findLiveCallId(token, { callerNumber, calleeNumber, callSid }) {
  try {
    const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (!r.ok) return null;
    const d = await r.json();
    const calls = Array.isArray(d) ? d : (d.data || []);
    const cleanCallee = (calleeNumber || '').replace(/\D/g, '').slice(-10);
    const cleanCaller = (callerNumber || '').replace(/\D/g, '').slice(-10);
    const m = calls.find(c => {
      const cn = (c.customer_number || '').replace(/\D/g, '').slice(-10);
      const did = (c.did || '').replace(/\D/g, '').slice(-10);
      return (cleanCallee && (cn === cleanCallee || did === cleanCallee)) ||
             (cleanCaller && (cn === cleanCaller || did === cleanCaller));
    });
    if (m?.call_id) {
      console.log(`[disconnectCall] 🔍 Resolved live call_id=${m.call_id} (from ${calls.length} live calls)`);
      return m.call_id;
    }
    console.log(`[disconnectCall] ⚠️ No live call match for callee=${cleanCallee} caller=${cleanCaller} (${calls.length} live calls)`);
  } catch (e) {
    console.error(`[disconnectCall] live_calls lookup failed: ${e.message}`);
  }
  return null;
}

export default async function disconnectCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    const { call_sid, caller_number, callee_number } = await c.req.json();
    if (!call_sid && !caller_number && !callee_number) {
      return c.json({ data: { error: 'call_sid or phone numbers required' } }, 400);
    }

    const token = await getSmartfloToken();

    // Primary strategy: look up the current live call_id from Smartflo's /v1/live_calls.
    // This is the ONLY reliable way — the streamSid we receive in the WebSocket is a different ID.
    const liveCallId = await findLiveCallId(token, {
      callerNumber: caller_number,
      calleeNumber: callee_number,
      callSid: call_sid
    });

    // Build list of call_id candidates to try in order
    const variants = [];
    if (liveCallId) variants.push(liveCallId);
    if (call_sid) {
      variants.push(call_sid);
      // Strip prefix: "h11.08-1776875353.216650" → "1776875353.216650"
      const numericMatch = call_sid.match(/\d{10,}\.\d+/);
      if (numericMatch && numericMatch[0] !== call_sid) variants.push(numericMatch[0]);
    }

    // Deduplicate
    const uniqueVariants = [...new Set(variants)];

    for (const cid of uniqueVariants) {
      const hangupResp = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ call_id: cid })
      });
      const hangupData = await hangupResp.json();
      console.log(`[disconnectCall] hangup call_id=${cid}, status=${hangupResp.status}`, JSON.stringify(hangupData));

      if (hangupResp.ok && hangupData.success !== false) {
        return c.json({ data: { success: true, call_id_used: cid, data: hangupData } });
      }
    }

    return c.json({ data: { success: false, message: `All hangup attempts failed. Tried: ${uniqueVariants.join(', ')}` } });
  } catch (error) {
    console.error('[disconnectCall] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};