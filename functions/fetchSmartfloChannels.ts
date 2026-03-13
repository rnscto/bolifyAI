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

    // Step 1: Login to Smartflo portal (web app)
    console.log('Trying portal login at cloudphone.tatateleservices.com...');
    
    // Try the portal API endpoints - cloudphone uses a separate web backend
    const portalEndpoints = [
      // The portal URL structure suggests internal APIs
      'https://cloudphone.tatateleservices.com/api/click_to_call_api_keys',
      'https://cloudphone.tatateleservices.com/api/v1/click_to_call_api_keys',
      'https://cloudphone.tatateleservices.com/click_to_call_api_keys/list',
    ];

    // Also try the main API with the API key header (like fetchSmartfloDIDs does)
    const apiEndpoints = [
      'https://api-smartflo.tatateleservices.com/v1/click_to_call_api_keys',
      'https://api-smartflo.tatateleservices.com/v1/click_to_call_support_keys',
      'https://api-smartflo.tatateleservices.com/v1/c2c_api_keys',
      'https://api-smartflo.tatateleservices.com/v1/api_connect/c2c',
      'https://api-smartflo.tatateleservices.com/v1/api_connect',
    ];

    const results = [];

    // Try API key auth format (same as fetchSmartfloDIDs which works)
    for (const endpoint of apiEndpoints) {
      try {
        console.log(`Trying API key auth: ${endpoint}`);
        const res = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Authorization': apiKey,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });
        
        const status = res.status;
        let body = null;
        try { body = await res.json(); } catch { body = (await res.text().catch(() => '')).substring(0, 500); }

        console.log(`${endpoint} → ${status}: ${JSON.stringify(body).substring(0, 300)}`);
        results.push({ endpoint, auth: 'API key', status, body });
        
        if (status >= 200 && status < 300) {
          console.log('✅ SUCCESS!');
          break;
        }
      } catch (e) {
        results.push({ endpoint, auth: 'API key', status: 'error', error: e.message });
      }
    }

    // Also try login + bearer on the portal endpoints
    console.log('Logging into Smartflo for bearer token...');
    const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const loginData = await loginRes.json();
    
    if (loginData.success && loginData.access_token) {
      const token = loginData.access_token;
      
      for (const endpoint of portalEndpoints) {
        try {
          console.log(`Trying portal: ${endpoint}`);
          const res = await fetch(endpoint, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/json',
              'Cookie': `token=${token}`
            }
          });
          
          const status = res.status;
          let body = null;
          try { body = await res.json(); } catch { body = (await res.text().catch(() => '')).substring(0, 300); }

          console.log(`${endpoint} → ${status}`);
          results.push({ endpoint, auth: 'Portal bearer', status, body: typeof body === 'string' ? body : body });
        } catch (e) {
          results.push({ endpoint, auth: 'Portal bearer', status: 'error', error: e.message });
        }
      }

      // Logout
      try {
        await fetch('https://api-smartflo.tatateleservices.com/v1/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch (e) {}
    }

    return Response.json({ success: true, results });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});