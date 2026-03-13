import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const apiKey = Deno.env.get('SMARTFLO_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'SMARTFLO_API_KEY not configured' }, { status: 500 });
    }

    const baseUrl = 'https://api-smartflo.tatateleservices.com/v1';

    // Comprehensive list of Smartflo API v1 endpoints to probe
    const endpoints = [
      // Known working
      '/my_number',
      '/users',
      // User & account management
      '/me',
      '/account',
      '/profile',
      '/company',
      '/organization',
      // Numbers & DIDs
      '/numbers',
      '/did',
      '/dids',
      '/phone_numbers',
      '/caller_ids',
      // Agents & users
      '/agents',
      '/extensions',
      '/departments',
      '/teams',
      '/groups',
      // Call related
      '/calls',
      '/call_logs',
      '/call_history',
      '/call_records',
      '/recordings',
      '/cdr',
      '/call_detail_records',
      // IVR & queues
      '/ivr',
      '/ivrs',
      '/queues',
      '/call_queues',
      '/hunt_groups',
      // Click to call
      '/click_to_call',
      '/click_to_call_support',
      '/c2c',
      // Voice streaming / channels
      '/channels',
      '/voice_streaming',
      '/streams',
      '/streaming',
      '/websocket',
      // Configuration
      '/settings',
      '/config',
      '/configuration',
      '/features',
      // Reporting
      '/reports',
      '/analytics',
      '/dashboard',
      '/stats',
      '/summary',
      // Misc
      '/contacts',
      '/blacklist',
      '/blocklist',
      '/sms',
      '/messages',
      '/webhooks',
      '/integrations',
      '/api_keys',
      '/tokens',
      '/plans',
      '/billing',
      '/subscription',
    ];

    const results = {};

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${baseUrl}${ep}`, {
          method: 'GET',
          headers: {
            'Authorization': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        const status = res.status;
        let body = null;
        try { 
          body = await res.json(); 
        } catch { 
          body = (await res.text().catch(() => '')).substring(0, 300); 
        }

        // Only include interesting results (not 403/404)
        if (status !== 403 && status !== 404 && status !== 405) {
          console.log(`✅ ${ep} → ${status}`);
          results[ep] = { 
            status, 
            sample: typeof body === 'object' 
              ? JSON.stringify(body).substring(0, 500) 
              : String(body).substring(0, 500)
          };
        } else if (status === 405) {
          // Method not allowed means endpoint exists but needs POST
          console.log(`🔶 ${ep} → 405 (exists, needs POST)`);
          results[ep] = { status, note: 'Exists but requires POST/different method' };
        } else {
          console.log(`❌ ${ep} → ${status}`);
        }
      } catch (e) {
        console.log(`💥 ${ep} → Error: ${e.message}`);
      }
    }

    return Response.json({
      success: true,
      auth_method: 'API key (same as fetchSmartfloDIDs)',
      accessible_endpoints: results,
      total_probed: endpoints.length,
      total_accessible: Object.keys(results).length
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});