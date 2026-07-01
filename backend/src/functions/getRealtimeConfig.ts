import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function getRealtimeConfig(c: any) {
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
    // This endpoint powers the public landing-page voice demo, so authentication
    // is NOT required. We still gate by the Base44 app id to keep abuse low.
    // (createClientFromRequest is intentionally not called for auth here.)

    // GA kill-switch: when AZURE_REALTIME_GA=true, use the new Foundry GA endpoint
    // (gpt-realtime / gpt-realtime-2). Otherwise keep the existing preview endpoint.
    const useGA = (Deno.env.get('AZURE_REALTIME_GA') || '').toLowerCase() === 'true';
    const endpoint = useGA
      ? (Deno.env.get('AZURE_REALTIME_ENDPOINT_GA') || Deno.env.get('AZURE_REALTIME_ENDPOINT'))
      : Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const key = useGA
      ? (Deno.env.get('AZURE_REALTIME_KEY_GA') || Deno.env.get('AZURE_REALTIME_KEY'))
      : Deno.env.get('AZURE_REALTIME_KEY');
    const deployment = useGA
      ? (Deno.env.get('AZURE_REALTIME_DEPLOYMENT_GA') || Deno.env.get('AZURE_REALTIME_DEPLOYMENT') || 'gpt-realtime-2')
      : (Deno.env.get('AZURE_REALTIME_DEPLOYMENT') || 'gpt-4o-realtime-preview');
    const apiVersion = Deno.env.get('AZURE_REALTIME_API_VERSION') || '2024-10-01-preview';

    if (!endpoint || !key) {
      return c.json({ data: { error: 'Azure Realtime not configured' } }, 500);
    }

    // Strip path/protocol from endpoint, build a fully-qualified WSS URL
    let host = endpoint.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
    const slash = host.indexOf('/');
    if (slash > 0) host = host.substring(0, slash);

    const wsUrl = useGA
      ? `wss://${host}/openai/v1/realtime?model=${encodeURIComponent(deployment)}`
      : `wss://${host}/openai/realtime?api-version=${apiVersion}&deployment=${deployment}`;

    return c.json({ data: {
      url: wsUrl,
      key,
      configured: true,
      ga: useGA
    } });
  } catch (err) {
    return c.json({ data: { error: err.message } }, 500);
  }

};