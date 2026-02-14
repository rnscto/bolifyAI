import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get the Deno Deploy URL from environment or construct it
    // Deno Deploy provides the deployment URL in the request headers
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    
    // If we're on Deno Deploy, the host will be something like: xxxxx.deno.dev
    // Otherwise, it will be the Base44 proxy URL
    
    let denoUrl = '';
    
    if (host && host.includes('.deno.dev')) {
      // We're being accessed via Deno Deploy directly
      denoUrl = `wss://${host}/api/functions/streamAudio`;
    } else {
      // Try to get from environment variable if set
      denoUrl = Deno.env.get('DENO_DEPLOY_URL') || '';
      
      if (!denoUrl) {
        // Return a helpful message
        return Response.json({ 
          deno_url: null,
          message: 'Deno Deploy URL not detected. Please check deployment logs or Deno Deploy dashboard.'
        });
      }
    }

    return Response.json({ 
      deno_url: denoUrl,
      message: 'Copy this URL to your agent settings'
    });
  } catch (error) {
    return Response.json({ 
      error: error.message,
      deno_url: null 
    }, { status: 500 });
  }
});