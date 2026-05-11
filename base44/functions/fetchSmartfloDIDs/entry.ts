import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// In-memory token cache (per-isolate) — prevents repeated logins that cause Smartflo lockouts.
let cachedToken = null;
let cachedAt = 0;
let loginPromise = null;
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
  const loginData = await loginRes.json();
  if (!loginData.success || !loginData.access_token) {
    throw new Error('Smartflo login failed: ' + JSON.stringify(loginData));
  }
  console.log('[fetchSmartfloDIDs] Login successful (token cached)');
  return loginData.access_token;
}

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && (now - cachedAt) < TOKEN_TTL_MS) return cachedToken;
  if (!loginPromise) {
    loginPromise = performSmartfloLogin()
      .then(t => { cachedToken = t; cachedAt = Date.now(); return t; })
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

    // Sync all DIDs to database
    const existingDids = await base44.asServiceRole.entities.DID.list();
    const existingNumbers = new Set(existingDids.map(d => d.number));

    const newDids = [];
    const updatedDids = [];

    for (const did of didsArray) {
      // did.did is like "+918065485979", did.alias is "918065485979"
      const rawDid = did.did || did.alias || '';
      // Strip leading + to get the number as stored (e.g. 918065485979 or 8065485979)
      const phoneNumber = rawDid.replace(/^\+/, '');
      // Also store the 10-digit local version for matching
      const localNumber = phoneNumber.startsWith('91') ? phoneNumber.slice(2) : phoneNumber;

      if (!phoneNumber) continue;

      // Check if already exists by full number or local number
      const existingFull = existingDids.find(d => d.number === phoneNumber || d.number === localNumber || d.number === rawDid);

      if (!existingFull) {
        newDids.push({
          number: phoneNumber,
          country_code: '+91',
          status: 'available',
          monthly_cost: 6500
        });
      }
    }

    if (newDids.length > 0) {
      await base44.asServiceRole.entities.DID.bulkCreate(newDids);
    }

    // NOTE: Do NOT logout — token is cached and reused by future calls

    return Response.json({
      success: true,
      total_dids: didsArray.length,
      existing_dids: existingDids.length,
      new_dids_added: newDids.length,
      dids_in_smartflo: didsArray.map(d => d.did || d.alias),
      message: `Successfully synced ${newDids.length} new DIDs from Smartflo (${didsArray.length} total in Smartflo)`
    });

  } catch (error) {
    console.error('Error fetching Smartflo DIDs:', error);
    console.error('Stack:', error.stack);
    return Response.json({ 
      error: error.message
    }, { status: 500 });
  }
});