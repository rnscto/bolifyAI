import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// In-memory token cache (per-isolate) — prevents repeated logins that cause Smartflo lockouts.
let cachedToken = null;
let cachedAt = 0;
let loginPromise = null;
let blockedUntil = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function performSmartfloLogin() {
  const email = Deno.env.get('SMARTFLO_EMAIL');
  const password = Deno.env.get('SMARTFLO_PASSWORD');
  if (!email || !password) throw new Error('SMARTFLO_EMAIL or SMARTFLO_PASSWORD not configured');
  const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const loginData = await loginRes.json().catch(() => ({}));
  if (!loginData.success || !loginData.access_token) {
    if (loginRes.status === 429 || loginData.retry_after) {
      let cooldownMs = 10 * 60 * 1000;
      if (loginData.retry_after) {
        const ra = new Date(loginData.retry_after.replace(' ', 'T') + '+05:30').getTime();
        if (!isNaN(ra) && ra > Date.now()) cooldownMs = ra - Date.now() + 5000;
      }
      blockedUntil = Date.now() + cooldownMs;
      throw new Error(`Smartflo rate-limited (retry_after=${loginData.retry_after || 'n/a'})`);
    }
    throw new Error('Smartflo login failed: ' + JSON.stringify(loginData));
  }
  console.log('[fetchSmartfloDIDs] Login successful (token cached)');
  return loginData.access_token;
}

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && (now - cachedAt) < TOKEN_TTL_MS) return cachedToken;
  if (blockedUntil > now) {
    const waitSec = Math.ceil((blockedUntil - now) / 1000);
    throw new Error(`Smartflo login is rate-limited — retry in ${waitSec}s`);
  }
  if (!loginPromise) {
    loginPromise = performSmartfloLogin()
      .then(t => { cachedToken = t; cachedAt = Date.now(); blockedUntil = 0; return t; })
      .finally(() => { loginPromise = null; });
  }
  return await loginPromise;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Get cached Smartflo bearer token (auto-refreshes after TTL)
    let token;
    try {
      token = await getSmartfloToken();
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }

    // Fetch DIDs using bearer token (with 1-time refresh on auth failure)
    let response = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
      method: 'GET',
      headers: { 'Authorization': token, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });

    if (response.status === 401 || response.status === 403) {
      console.log('[fetchSmartfloDIDs] Token rejected, refreshing and retrying...');
      cachedToken = null; cachedAt = 0;
      token = await getSmartfloToken(true);
      response = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
        method: 'GET',
        headers: { 'Authorization': token, 'Content-Type': 'application/json', 'Accept': 'application/json' }
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Smartflo API error:', errorText);
      return Response.json({ 
        error: 'Failed to fetch DIDs from Smartflo',
        details: errorText,
        status_code: response.status
      }, { status: response.status });
    }

    const smartfloData = await response.json();
    console.log('Smartflo /my_number response:', JSON.stringify(smartfloData).slice(0, 500));

    // Response is an array of DID objects with fields: id, name, alias, did
    const didsArray = Array.isArray(smartfloData) ? smartfloData : (smartfloData.data || []);

    if (!Array.isArray(didsArray)) {
      return Response.json({
        error: 'Unexpected response format from Smartflo',
        response: smartfloData
      }, { status: 500 });
    }

    // ─── Page through ALL existing DIDs (default list limit is small — we must paginate) ───
    const existingDids = [];
    const PAGE_SIZE = 500;
    for (let page = 0; page < 50; page++) {
      const batch = await base44.asServiceRole.entities.DID.list('-created_date', PAGE_SIZE, page * PAGE_SIZE);
      if (!batch || batch.length === 0) break;
      existingDids.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    console.log(`[fetchSmartfloDIDs] Loaded ${existingDids.length} existing DIDs from DB`);

    // Build a lookup set of all known number variants for O(1) match
    const existingSet = new Set();
    for (const d of existingDids) {
      if (!d.number) continue;
      const n = String(d.number).replace(/\D/g, '');
      existingSet.add(n);                                    // full digits
      if (n.length >= 10) existingSet.add(n.slice(-10));     // last-10
    }

    const newDids = [];
    for (const did of didsArray) {
      const rawDid = did.did || did.alias || '';
      const phoneNumber = rawDid.replace(/^\+/, '').replace(/\D/g, '');
      if (!phoneNumber) continue;
      const local10 = phoneNumber.slice(-10);
      if (existingSet.has(phoneNumber) || existingSet.has(local10)) continue;
      newDids.push({ number: phoneNumber, country_code: '+91', status: 'available', monthly_cost: 6500 });
      existingSet.add(phoneNumber); existingSet.add(local10); // dedupe within this batch too
    }

    // ─── Bulk-insert in small chunks to stay under timeout ───
    const CHUNK = 50;
    let inserted = 0;
    for (let i = 0; i < newDids.length; i += CHUNK) {
      const slice = newDids.slice(i, i + CHUNK);
      try {
        await base44.asServiceRole.entities.DID.bulkCreate(slice);
        inserted += slice.length;
      } catch (e) {
        console.error(`[fetchSmartfloDIDs] bulkCreate chunk ${i}-${i + slice.length} failed: ${e.message}`);
      }
    }
    console.log(`[fetchSmartfloDIDs] Inserted ${inserted}/${newDids.length} new DIDs`);

    // NOTE: Do NOT logout — token is cached and reused by future calls

    return Response.json({
      success: true,
      total_dids: didsArray.length,
      existing_dids: existingDids.length,
      new_dids_added: inserted,
      message: `Successfully synced ${inserted} new DIDs from Smartflo (${didsArray.length} total in Smartflo, ${existingDids.length} already in DB)`
    });

  } catch (error) {
    console.error('Error fetching Smartflo DIDs:', error);
    console.error('Stack:', error.stack);
    return Response.json({ 
      error: error.message
    }, { status: 500 });
  }
});