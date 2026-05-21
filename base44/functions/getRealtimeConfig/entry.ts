import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

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

    // Build the full WSS URL with deployment path — never expose the API key to clients
    let wsUrl = endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://').replace(/\/+$/, '');
    const pathIdx = wsUrl.indexOf('/', wsUrl.indexOf('//') + 2);
    if (pathIdx > 0) wsUrl = wsUrl.substring(0, pathIdx);
    const isFoundry = wsUrl.includes('.services.ai.azure.com');
    if (isFoundry) {
      wsUrl = `${wsUrl}/api/projects/yadavnand886-7905/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-2`;
    } else {
      wsUrl = `${wsUrl}/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-2`;
    }

    return Response.json({
      url: wsUrl,
      configured: true
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});