import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// keepLLMWarm — Phase A Tier 1.5
// Periodically pings Gemini Live and Azure Realtime endpoints to keep
// DNS/TLS sessions warm at the Deno Deploy edge. Saves 50-150ms cold
// connection latency when a real call opens its WebSocket.
//
// Scheduled to run every 1 minute via Base44 automation.
// Lightweight — single HEAD/GET request per provider, no auth needed
// since we're only warming the network path (TLS handshake + DNS).
// ═══════════════════════════════════════════════════════════════════

export default async function keepLLMWarm(c: any) {
  const req = c.req.raw || c.req;
  // ─── Auth: shared API key (external cron services pass this) ───
  const url = new URL(req.url);
  const providedKey =
    req.headers.get('x-api-key') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('key') ||
    '';
  const expectedKey = Deno.env.get('CRON_API_KEY') || '';
  if (!expectedKey || providedKey !== expectedKey) {
    return c.json({ data: { error: 'Unauthorized' } }, 401);
  }

  const t0 = Date.now();
  const results = {};

  // ─── Gemini Live edge (host warm-up) ───
  try {
    const t = Date.now();
    // Tiny HTTPS HEAD to warm DNS/TLS — endpoint always returns quickly even without API key
    const r = await fetch('https://generativelanguage.googleapis.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000)
    });
    results.gemini = { status: r.status, ms: Date.now() - t };
  } catch (e) {
    results.gemini = { error: e.message };
  }

  // ─── Azure OpenAI Realtime endpoint warm-up ───
  try {
    const endpoint = Deno.env.get('AZURE_REALTIME_ENDPOINT') || '';
    if (endpoint) {
      let host = endpoint.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
      const slash = host.indexOf('/');
      if (slash > 0) host = host.substring(0, slash);
      const t = Date.now();
      const r = await fetch(`https://${host}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000)
      });
      results.azure_realtime = { status: r.status, ms: Date.now() - t };
    } else {
      results.azure_realtime = { skipped: 'no AZURE_REALTIME_ENDPOINT' };
    }
  } catch (e) {
    results.azure_realtime = { error: e.message };
  }

  // ─── Azure OpenAI (for post-call analysis) ───
  try {
    const endpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT') || '';
    if (endpoint) {
      let host = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const slash = host.indexOf('/', 8);
      if (slash > 0) host = host.substring(0, slash);
      const t = Date.now();
      const r = await fetch(`${host}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000)
      });
      results.azure_openai = { status: r.status, ms: Date.now() - t };
    } else {
      results.azure_openai = { skipped: 'no AZURE_OPENAI_ENDPOINT' };
    }
  } catch (e) {
    results.azure_openai = { error: e.message };
  }

  console.log(`[keepLLMWarm] ${Date.now() - t0}ms total | ${JSON.stringify(results)}`);

  return c.json({ data: {
    success: true,
    total_ms: Date.now() - t0,
    results
  } });

};