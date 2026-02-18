import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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
    // No auth required — this is for the public landing page voice agent
    const endpoint = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const apiKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!endpoint || !apiKey) {
      return Response.json({ error: 'Azure Realtime not configured' }, { status: 500 });
    }

    // Convert HTTP endpoint to WSS
    let wsUrl = endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

    return Response.json({
      url: wsUrl,
      key: apiKey
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});