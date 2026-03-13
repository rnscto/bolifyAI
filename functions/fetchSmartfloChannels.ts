import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const email = Deno.env.get('SMARTFLO_EMAIL');
    const password = Deno.env.get('SMARTFLO_PASSWORD');
    const apiKey = Deno.env.get('SMARTFLO_API_KEY');

    if (!email || !password) {
      return Response.json({ error: 'SMARTFLO_EMAIL and SMARTFLO_PASSWORD not configured' }, { status: 500 });
    }

    // Step 1: Login to Smartflo to get bearer token
    console.log('Logging in to Smartflo...');
    const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const loginData = await loginRes.json();
    console.log('Login success:', loginData.success);

    if (!loginData.success || !loginData.access_token) {
      return Response.json({ 
        error: 'Smartflo login failed', 
        details: loginData.message || 'Unknown error' 
      }, { status: 401 });
    }

    const bearerToken = loginData.access_token;

    // Step 2: Try different auth header formats on the likely endpoints
    const endpoints = [
      'https://api-smartflo.tatateleservices.com/v1/click_to_call_api_keys',
      'https://api-smartflo.tatateleservices.com/v1/api_connect/click_to_call',
      'https://api-smartflo.tatateleservices.com/v1/channels',
      'https://api-smartflo.tatateleservices.com/v1/voice_streaming',
    ];

    const authHeaders = [
      { name: 'Bearer token', header: { 'Authorization': `Bearer ${bearerToken}` } },
      { name: 'Raw token', header: { 'Authorization': bearerToken } },
      { name: 'API key', header: { 'Authorization': apiKey } },
      { name: 'X-Auth-Token', header: { 'X-Auth-Token': bearerToken } },
      { name: 'Token in query (skip header)', header: {} },
    ];

    const results = [];

    for (const endpoint of endpoints) {
      for (const auth of authHeaders) {
        try {
          const url = auth.name === 'Token in query (skip header)' 
            ? `${endpoint}?token=${bearerToken}` 
            : endpoint;
          
          console.log(`Trying: ${endpoint} with ${auth.name}`);
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              ...auth.header
            }
          });
          
          const status = res.status;
          let body = null;
          try {
            body = await res.json();
          } catch {
            const text = await res.text().catch(() => '');
            body = text.substring(0, 500);
          }

          // Only log non-403 or successful ones to reduce noise
          if (status !== 403) {
            console.log(`✅ ${endpoint} [${auth.name}] → ${status}: ${JSON.stringify(body).substring(0, 300)}`);
          }

          results.push({
            endpoint,
            auth: auth.name,
            status,
            body: typeof body === 'object' ? body : (typeof body === 'string' ? body.substring(0, 300) : null)
          });

          // If successful, no need to try more auth methods for this endpoint
          if (status >= 200 && status < 300) break;
        } catch (e) {
          results.push({ endpoint, auth: auth.name, status: 'error', error: e.message });
        }
      }
    }

    // Cleanup
    try {
      await fetch('https://api-smartflo.tatateleservices.com/v1/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': bearerToken, 'Content-Type': 'application/json' }
      });
    } catch (e) {}

    return Response.json({ success: true, results });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});