import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Returns the WebSocket URL for the streamGeminiBrowser relay.
// Base44's HTTP gateway does NOT proxy WebSocket upgrades, so the browser
// must connect directly to the underlying Deno deployment URL of the
// streamGeminiBrowser function (which self-reports it via req.url).
export default async function getGeminiConfig(c: any) {
  const req = c.req.raw || c.req;
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
    // Prefer the env-var override if explicitly set to a wss:// URL.
    let wsUrl = Deno.env.get('GEMINI_RELAY_WS_URL') || '';
    if (wsUrl && !wsUrl.startsWith('wss://')) {
      // Old/misconfigured value (e.g. https://... via HTTP gateway) — ignore it.
      wsUrl = '';
    }

    // Discover the direct wss:// URL by invoking streamGeminiBrowser over HTTP.
    if (!wsUrl) {
      const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.31');
      /* const base44 = ... */;
      const res = await base44.asServiceRole.functions.invoke('streamGeminiBrowser', {});
      wsUrl = res?.data?.ws_url || '';
    }

    if (!wsUrl) {
      return c.json({ data: {
        error: 'Could not discover streamGeminiBrowser relay URL.'
      } }, 500);
    }

    return c.json({ data: { url: wsUrl, configured: true } });
  } catch (err) {
    return c.json({ data: { error: err.message } }, 500);
  }

};