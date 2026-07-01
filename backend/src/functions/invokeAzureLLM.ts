import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Generic drop-in replacement for base44.integrations.Core.InvokeLLM
// using the user's own Azure OpenAI keys (zero Base44 integration credits).
//
// Accepts the same inputs as InvokeLLM: { prompt, response_json_schema, file_urls, add_context_from_internet }
// Returns: { result } where result is either a parsed object (if schema given) or a string.

export default async function invokeAzureLLM(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    // ── RATE LIMIT (per-user, 30 LLM calls/min) — cost-DoS protection ──
    // A logged-in user could otherwise drive unbounded Azure OpenAI spend.
    const LLM_LIMIT_PER_MIN = 30;
    try {
      const svc = base44.asServiceRole;
      const windowStart = new Date();
      windowStart.setSeconds(0, 0);
      const bucketKey = `user:${user.id}:llm:${windowStart.toISOString()}`;
      const existing = await svc.entities.RateBucket.filter({ bucket_key: bucketKey });
      const bucket = existing[0];
      if (bucket) {
        if ((bucket.count || 0) >= LLM_LIMIT_PER_MIN) {
          return c.json({ data: { error: 'Rate limit exceeded (30 AI calls/min). Please wait a moment.' } }, 429);
        }
        await svc.entities.RateBucket.update(bucket.id, { count: (bucket.count || 0) + 1 });
      } else {
        await svc.entities.RateBucket.create({
          bucket_key: bucketKey, identity: user.id, endpoint: 'llm',
          window_start: windowStart.toISOString(), count: 1
        });
      }
    } catch (rlErr) {
      console.error('invokeAzureLLM rate-limit check failed (allowing):', rlErr.message);
    }

    const { prompt, response_json_schema, file_urls } = await c.req.json();
    if (!prompt) return c.json({ data: { error: 'prompt required' } }, 400);

    let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const _oi = baseUrl.indexOf('/openai/'); if (_oi > 0) baseUrl = baseUrl.substring(0, _oi);
    const _pi = baseUrl.indexOf('/api/projects'); if (_pi > 0) baseUrl = baseUrl.substring(0, _pi);
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
    if (!baseUrl || !deployment || !apiKey) {
      return c.json({ data: { error: 'Azure OpenAI secrets not configured' } }, 500);
    }

    // Build messages — supports text-only or text + image URLs
    const userContent = [];
    userContent.push({ type: 'text', text: prompt });
    if (Array.isArray(file_urls)) {
      for (const u of file_urls) {
        if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
          userContent.push({ type: 'image_url', image_url: { url: u } });
        }
      }
    }

    const body = {
      messages: [
        {
          role: 'system',
          content: response_json_schema
            ? 'You are a helpful assistant. Always respond with valid JSON matching the user-provided schema. Do not include markdown fences.'
            : 'You are a helpful assistant.'
        },
        { role: 'user', content: userContent.length === 1 ? prompt : userContent }
      ],
      max_completion_tokens: 4000
    };
    if (response_json_schema) body.response_format = { type: 'json_object' };

    const r = await fetch(
      `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
      { method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!r.ok) {
      const t = await r.text();
      return c.json({ data: { error: `Azure OpenAI ${r.status}: ${t.substring(0, 400)}` } }, 500);
    }
    const data = await r.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();

    if (response_json_schema) {
      try {
        return c.json({ data: { result: JSON.parse(text) } });
      } catch {
        // Try to extract JSON between first { and last }
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try { return c.json({ data: { result: JSON.parse(m[0]) } }); } catch {}
        }
        return c.json({ data: { error: 'AI did not return valid JSON', raw: text.substring(0, 500) } }, 502);
      }
    }
    return c.json({ data: { result: text } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};