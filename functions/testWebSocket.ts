import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get host and construct URLs
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'unknown';
    const protocol = req.headers.get('x-forwarded-proto') || 'https';
    
    // WebSocket URL variants
    const urls = {
      variant1: `wss://${host}/functions/streamAudio`,
      variant2: `wss://${host}/api/functions/streamAudio`,
      variant3: `wss://${host}/v1/streamAudio`,
      variant4: Deno.env.get('DENO_DEPLOY_URL') ? 
        `${Deno.env.get('DENO_DEPLOY_URL').replace('https://', 'wss://')}/functions/streamAudio` : 
        'NOT SET',
      host_header: host,
      protocol_used: protocol
    };

    console.log('WebSocket URL Diagnostics:', JSON.stringify(urls, null, 2));

    return Response.json({
      success: true,
      diagnostics: urls,
      request_method: req.method,
      request_url: req.url,
      headers: {
        'x-forwarded-host': req.headers.get('x-forwarded-host'),
        'x-forwarded-proto': req.headers.get('x-forwarded-proto'),
        'host': req.headers.get('host'),
        'origin': req.headers.get('origin')
      }
    });
  } catch (error) {
    console.error('Diagnostic error:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
});