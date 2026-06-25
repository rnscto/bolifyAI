import { client } from "../db/index.ts";

export async function triggerSmartfloOutboundCall(params: {
  smartfloApiKey: string;
  calleeNumber: string;
  callerId: string;
  callLogId: string;
}) {
  const { smartfloApiKey, calleeNumber, callerId, callLogId } = params;

  let cleanCallerID = callerId.replace(/[^0-9]/g, '');
  if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;

  const callee10 = calleeNumber.replace(/[^0-9]/g, '').slice(-10);
  const dialNumber = '91' + callee10;

  const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: smartfloApiKey,
      customer_number: dialNumber,
      caller_id: cleanCallerID,
      custom_identifier: callLogId,
      async: 1
    })
  });

  const smartfloData = await smartfloResp.json();
  console.log("[Smartflo] Click-to-call response:", smartfloResp.status, smartfloData);
  if (smartfloResp.ok && smartfloData.success !== false) {
    const newCallSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id;
    await client.queryObject(
      `UPDATE "calllog" SET call_sid = $1, status = 'ringing' WHERE id = $2`,
      [newCallSid, callLogId]
    );
    return { success: true, call_sid: newCallSid };
  } else {
    await client.queryObject(
      `UPDATE "calllog" SET status = 'failed' WHERE id = $1`,
      [callLogId]
    );
    return { success: false, message: smartfloData.message || 'Smartflo API Error' };
  }
}

// Global Smartflo Token Cache Logic
let _localCache = { token: null as string | null, expiresAt: 0 };
let _loginPromise: Promise<string> | null = null;

export async function getSmartfloToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && _localCache.token && _localCache.expiresAt > now) {
    return _localCache.token as string;
  }
  
  // Read token from DB (smartfloauth table)
  const recRes = await client.queryObject(`SELECT * FROM "smartfloauth" ORDER BY updated_at DESC LIMIT 1`);
  const rec = (recRes.rows[0] as any) || null;

  if (rec) {
    if (rec.blocked_until && new Date(rec.blocked_until).getTime() > now) {
      throw new Error("Smartflo login is rate-limited (shared)");
    }
    if (!forceRefresh && rec.token && rec.expires_at && new Date(rec.expires_at).getTime() > now + 60000) {
      _localCache = { token: rec.token, expiresAt: new Date(rec.expires_at).getTime() };
      return rec.token;
    }
  }

  if (_loginPromise) return _loginPromise;
  
  _loginPromise = (async () => {
    try {
      const email = Deno.env.get('SMARTFLO_EMAIL');
      const password = Deno.env.get('SMARTFLO_PASSWORD');
      if (!email || !password) throw new Error('SMARTFLO_EMAIL/PASSWORD not configured');
      
      const r = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const d = await r.json().catch(() => ({}));
      const token = d.access_token || d.token;
      
      if (!token) {
        if (r.status === 429 || d.retry_after) {
          let cooldownMs = 10 * 60 * 1000;
          if (d.retry_after) {
             const ra = new Date(d.retry_after.replace(' ', 'T') + '+05:30').getTime();
             if (!isNaN(ra) && ra > Date.now()) cooldownMs = ra - Date.now() + 5000;
          }
          if (rec) {
            await client.queryObject(
              `UPDATE "smartfloauth" SET blocked_until = $1 WHERE id = $2`,
              [new Date(Date.now() + cooldownMs).toISOString(), rec.id]
            );
          }
          throw new Error(`Smartflo login rate-limited, try again later.`);
        }
        throw new Error(`Login failed: ${d.message || r.status}`);
      }

      const expiresAt = new Date(Date.now() + 50 * 60 * 1000).toISOString();
      if (rec) {
        await client.queryObject(
          `UPDATE "smartfloauth" SET token = $1, expires_at = $2, blocked_until = NULL WHERE id = $3`,
          [token, expiresAt, rec.id]
        );
      } else {
        await client.queryObject(
          `INSERT INTO "smartfloauth" (token, expires_at) VALUES ($1, $2)`,
          [token, expiresAt]
        );
      }
      
      _localCache = { token, expiresAt: new Date(expiresAt).getTime() };
      return token;
    } finally {
      _loginPromise = null;
    }
  })();
  
  return _loginPromise;
}
