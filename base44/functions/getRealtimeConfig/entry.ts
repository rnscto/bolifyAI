import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id'
      }
    });
  }

  try {
    // Require authentication — never expose Azure keys publicly
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const endpoint = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    if (!endpoint) {
      return Response.json({ error: 'Azure Realtime not configured' }, { status: 500 });
    }

    // Only return the WSS URL — never expose the API key to clients
    const wsUrl = endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

    return Response.json({
      url: wsUrl,
      configured: true
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});