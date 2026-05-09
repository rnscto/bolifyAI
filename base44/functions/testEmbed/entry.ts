import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Diagnostic — tries embedding with multiple URL/api-version combos to find what works.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const base = (Deno.env.get('AZURE_EMBEDDING_ENDPOINT') || '').replace(/\/+$/, '');
    const apiKey = Deno.env.get('AZURE_EMBEDDING_KEY');
    const model = Deno.env.get('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');

    const variants = [
      { name: 'foundry-v1-no-version', url: `${base}/openai/v1/embeddings`, body: { input: 'test', model } },
      { name: 'foundry-v1-preview', url: `${base}/openai/v1/embeddings?api-version=preview`, body: { input: 'test', model } },
      { name: 'foundry-v1-2025-04-01-preview', url: `${base}/openai/v1/embeddings?api-version=2025-04-01-preview`, body: { input: 'test', model } },
      { name: 'classic-deployments-2024-10-21', url: `${base}/openai/deployments/${model}/embeddings?api-version=2024-10-21`, body: { input: 'test' } },
      { name: 'classic-deployments-2024-08-01-preview', url: `${base}/openai/deployments/${model}/embeddings?api-version=2024-08-01-preview`, body: { input: 'test' } },
      { name: 'classic-deployments-2023-05-15', url: `${base}/openai/deployments/${model}/embeddings?api-version=2023-05-15`, body: { input: 'test' } },
    ];

    const results = [];
    for (const v of variants) {
      try {
        const resp = await fetch(v.url, {
          method: 'POST',
          headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(v.body)
        });
        const txt = await resp.text();
        results.push({
          variant: v.name,
          url: v.url,
          status: resp.status,
          ok: resp.ok,
          body: txt.substring(0, 300)
        });
      } catch (e) {
        results.push({ variant: v.name, url: v.url, error: e.message });
      }
    }

    return Response.json({ base, model, results });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});