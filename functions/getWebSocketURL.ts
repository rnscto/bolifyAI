import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get the host from request
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const protocol = req.headers.get('x-forwarded-proto') || 'wss';

    // Construct WebSocket URL
    const wssUrl = `${protocol}://${host}/functions/streamAudio`;

    console.log(`WebSocket URL: ${wssUrl}`);

    return Response.json({
      success: true,
      wss_url: wssUrl,
      message: 'Configure this URL in Smartflo Click-to-Call Support settings as the webhook/callback URL'
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});