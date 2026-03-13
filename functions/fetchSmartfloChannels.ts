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
    console.log('Login response:', JSON.stringify({ success: loginData.success, token_type: loginData.token_type }));

    if (!loginData.success || !loginData.access_token) {
      return Response.json({ 
        error: 'Smartflo login failed', 
        details: loginData.message || 'Unknown error' 
      }, { status: 401 });
    }

    const bearerToken = loginData.access_token;

    // Step 2: Try multiple possible endpoints to fetch Click to Call API keys
    const possibleEndpoints = [
      'https://api-smartflo.tatateleservices.com/v1/click_to_call_api_keys',
      'https://api-smartflo.tatateleservices.com/v1/click_to_call/api_keys',
      'https://api-smartflo.tatateleservices.com/v1/click_to_call_support/api_keys',
      'https://api-smartflo.tatateleservices.com/v1/api_connect/click_to_call',
      'https://api-smartflo.tatateleservices.com/v1/channels',
      'https://api-smartflo.tatateleservices.com/v1/voice_streaming',
      'https://api-smartflo.tatateleservices.com/v1/voice_streaming/channels',
      'https://api-smartflo.tatateleservices.com/v1/api_connect',
      'https://api-smartflo.tatateleservices.com/v1/settings/channels',
      'https://api-smartflo.tatateleservices.com/v1/c2c/api_keys',
      'https://api-smartflo.tatateleservices.com/v1/click_to_call_support_api_keys'
    ];

    const results = [];

    for (const endpoint of possibleEndpoints) {
      try {
        console.log(`Trying: ${endpoint}`);
        const res = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${bearerToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });
        
        const status = res.status;
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = await res.text().catch(() => null);
        }

        results.push({
          endpoint,
          status,
          success: status >= 200 && status < 300,
          body: typeof body === 'string' ? body.substring(0, 500) : body
        });

        console.log(`${endpoint} → ${status}: ${JSON.stringify(body).substring(0, 200)}`);

        // If we got a successful response, highlight it
        if (status >= 200 && status < 300) {
          console.log(`✅ SUCCESS: ${endpoint}`);
        }
      } catch (e) {
        results.push({ endpoint, status: 'error', error: e.message });
        console.log(`${endpoint} → ERROR: ${e.message}`);
      }
    }

    // Step 3: Logout to clean up the session
    try {
      await fetch('https://api-smartflo.tatateleservices.com/v1/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (e) {
      console.log('Logout error (non-critical):', e.message);
    }

    return Response.json({
      success: true,
      message: 'Endpoint discovery complete',
      results
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});