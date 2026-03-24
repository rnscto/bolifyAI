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

    // Login to get fresh bearer token
    console.log('Logging in...');
    const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const loginData = await loginRes.json();
    
    if (!loginData.success || !loginData.access_token) {
      return Response.json({ error: 'Login failed', details: loginData }, { status: 401 });
    }

    const token = loginData.access_token;
    console.log('Login successful, token obtained');

    const baseUrl = 'https://api-smartflo.tatateleservices.com/v1';

    // Endpoints that responded (non-403/404) from previous scan, plus key ones
    const endpoints = [
      '/my_number',
      '/users',
      '/profile',
      '/agents',
      '/departments',
      '/recordings',
      '/ivrs',
      '/dashboard',
      '/contacts',
      '/webhooks',
      // Additional ones to deep-scan with bearer
      '/calls',
      '/call_logs',
      '/queues',
      '/hunt_groups',
      '/extensions',
      '/settings',
      '/channels',
      '/voice_streaming',
      '/click_to_call',
      '/click_to_call_support',
      '/reports',
      '/cdr',
      '/blacklist',
      '/sms',
    ];

    const results = {};

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${baseUrl}${ep}`, {
          method: 'GET',
          headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        const status = res.status;
        let body = null;
        try { body = await res.json(); } catch { body = (await res.text().catch(() => '')).substring(0, 500); }

        const bodyStr = JSON.stringify(body);
        const isSuccess = status >= 200 && status < 300 && !bodyStr.includes('"success":false');
        
        if (isSuccess) {
          console.log(`✅ ${ep} → ${status} (${bodyStr.length} chars)`);
        } else {
          console.log(`❌ ${ep} → ${status}: ${bodyStr.substring(0, 150)}`);
        }

        results[ep] = { 
          status,
          accessible: isSuccess,
          data_preview: bodyStr.substring(0, 800)
        };
      } catch (e) {
        results[ep] = { status: 'error', error: e.message };
      }
    }

    // Logout
    try {
      await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': token }
      });
    } catch (e) {}

    // Separate accessible vs inaccessible
    const accessible = {};
    const inaccessible = {};
    for (const [ep, data] of Object.entries(results)) {
      if (data.accessible) accessible[ep] = data;
      else inaccessible[ep] = data;
    }

    return Response.json({
      success: true,
      auth_method: 'Bearer token (email/password login)',
      accessible_endpoints: accessible,
      inaccessible_endpoints: inaccessible,
      summary: {
        total_probed: endpoints.length,
        accessible: Object.keys(accessible).length,
        inaccessible: Object.keys(inaccessible).length
      }
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});