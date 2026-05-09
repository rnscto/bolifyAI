import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.25';

// ─── Parse Azure connection string ───
function parseConnectionString(cs) {
  const parts = {};
  for (const seg of cs.split(';')) {
    const idx = seg.indexOf('=');
    if (idx > 0) parts[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
  }
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
    endpoint: parts.BlobEndpoint || `https://${parts.AccountName}.blob.${parts.EndpointSuffix || 'core.windows.net'}`
  };
}

async function hmacSha256(stringToSign, accountKey) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function buildGetAuthHeader(accountName, accountKey, container, blobName, dateStr) {
  const canonicalizedHeaders = `x-ms-date:${dateStr}\nx-ms-version:2021-08-06`;
  const canonicalizedResource = `/${accountName}/${container}/${blobName}`;
  const stringToSign = [
    'GET', '', '', '', '', '', '', '', '', '', '', '',
    canonicalizedHeaders, canonicalizedResource
  ].join('\n');
  const signature = await hmacSha256(stringToSign, accountKey);
  return `SharedKey ${accountName}:${signature}`;
}

async function fetchAzureBlob(blobUri) {
  const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  if (!cs) throw new Error('Azure storage not configured');
  const { accountName, accountKey, endpoint } = parseConnectionString(cs);

  const parsed = new URL(blobUri);
  const expectedHost = new URL(endpoint).host;
  if (parsed.host !== expectedHost) throw new Error('blob host mismatch');
  const pathParts = parsed.pathname.replace(/^\/+/, '').split('/');
  const container = pathParts.shift();
  const blobName = pathParts.join('/');
  if (!container || !blobName) throw new Error('Invalid blob path');

  const dateStr = new Date().toUTCString();
  const auth = await buildGetAuthHeader(accountName, accountKey, container, blobName, dateStr);
  const resp = await fetch(`${endpoint}/${container}/${blobName}`, {
    headers: { 'Authorization': auth, 'x-ms-date': dateStr, 'x-ms-version': '2021-08-06' }
  });
  if (!resp.ok) throw new Error(`Azure GET failed ${resp.status}`);
  return await resp.text();
}

// ─── Caches ───
// Index cache (per worker, per agent index hash) — TTL 10 min
const INDEX_CACHE = new Map();
const TEXT_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 32;

function cacheGet(map, key) {
  const v = map.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) { map.delete(key); return null; }
  return v.value;
}
function cacheSet(map, key, value) {
  if (map.size >= CACHE_MAX) {
    const firstKey = map.keys().next().value;
    if (firstKey) map.delete(firstKey);
  }
  map.set(key, { value, ts: Date.now() });
}

async function fetchIndex(agent) {
  const cacheKey = `${agent.id}:${agent.kb_file_hash || 'none'}:${agent.kb_embedding_model || ''}`;
  const cached = cacheGet(INDEX_CACHE, cacheKey);
  if (cached) return cached;
  const raw = await fetchAzureBlob(agent.kb_index_uri);
  const index = JSON.parse(raw);
  cacheSet(INDEX_CACHE, cacheKey, index);
  return index;
}

async function fetchRawText(agent) {
  const cacheKey = `${agent.id}:${agent.kb_file_hash || 'none'}`;
  const cached = cacheGet(TEXT_CACHE, cacheKey);
  if (cached) return cached;
  const text = await fetchAzureBlob(agent.kb_file_uri);
  cacheSet(TEXT_CACHE, cacheKey, text);
  return text;
}

// ─── Embed query via Azure Foundry embedding endpoint (text-embedding-3-small) ───
// Foundry uses /openai/v1/embeddings with model name in body and api-version=preview
async function embedQuery(query) {
  const base = (Deno.env.get('AZURE_EMBEDDING_ENDPOINT') || '').replace(/\/+$/, '');
  const apiKey = Deno.env.get('AZURE_EMBEDDING_KEY');
  const model = Deno.env.get('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
  if (!base || !apiKey || !model) throw new Error('Embedding not configured');
  const url = `${base}/openai/v1/embeddings`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: query, model })
  });
  if (!resp.ok) throw new Error(`Embed query ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  return data.data[0].embedding;
}

// ─── Cosine similarity (vectors are not pre-normalized, so we compute properly) ───
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── Keyword fallback (kept for agents without an embedding index) ───
function splitIntoChunks(content) {
  const chunks = [];
  const sections = content.split(/\n\n---\n\n/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 1500) chunks.push(trimmed);
    else {
      const paras = trimmed.split(/\n\s*\n/);
      let buf = '';
      for (const p of paras) {
        if ((buf + '\n\n' + p).length > 1200 && buf) { chunks.push(buf.trim()); buf = p; }
        else { buf = buf ? buf + '\n\n' + p : p; }
      }
      if (buf.trim()) chunks.push(buf.trim());
    }
  }
  return chunks;
}

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','can','of',
  'to','in','on','at','for','with','by','from','as','it','this','that','these',
  'those','i','you','he','she','we','they','what','when','where','why','how',
  'and','or','but','if','then','so','my','your','our','their','me','us','him','her',
  'mein','hai','hain','ho','ka','ki','ke','ko','se','ne','par','tha','thi',
  'aap','main','hum','kya','kaise','kahan','kab','kyun','aur','ya','toh','phir'
]);
function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t.length >= 2 && !STOPWORDS.has(t));
}
function scoreChunk(chunk, queryTokens, queryRaw) {
  const text = chunk.toLowerCase();
  let score = 0;
  const matched = new Set();
  for (const tok of queryTokens) if (text.includes(tok)) matched.add(tok);
  score += matched.size * 10;
  if (queryRaw.length >= 4 && text.includes(queryRaw.toLowerCase())) score += 25;
  const firstLine = chunk.split('\n')[0].toLowerCase();
  for (const tok of matched) { if (firstLine.includes(tok)) { score += 8; break; } }
  let occ = 0;
  for (const tok of matched) {
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    const m = text.match(re); if (m) occ += m.length;
  }
  score += Math.min(occ, 10);
  return { score, matchedCount: matched.size };
}

async function keywordFallback(agent, query, k) {
  const content = await fetchRawText(agent);
  const chunks = splitIntoChunks(content);
  if (chunks.length === 0) return { results: [], total_chunks: 0 };
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { results: [{ content: chunks[0].slice(0, 1000), score: 0 }], total_chunks: chunks.length };
  }
  const scored = chunks.map(c => ({ content: c, ...scoreChunk(c, queryTokens, query) }))
    .filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return {
    results: scored.slice(0, k).map(s => ({ content: s.content.slice(0, 1500), score: s.score, matched_keywords: s.matchedCount })),
    total_chunks: chunks.length
  };
}

Deno.serve(async (req) => {
  try {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    const { agent_id, query, top_k, _internal } = body;
    if (!agent_id) return Response.json({ error: 'agent_id required' }, { status: 400 });
    if (!query || typeof query !== 'string') return Response.json({ error: 'query required' }, { status: 400 });

    let svc;
    if (_internal) {
      svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    } else {
      const base44 = createClientFromRequest(req);
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      svc = base44.asServiceRole;
    }

    const agent = await svc.entities.Agent.get(agent_id);
    if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });

    if (!agent.kb_file_uri && !agent.kb_index_uri) {
      return Response.json({ success: true, results: [], message: 'No knowledge base configured.' });
    }

    const k = Math.min(Math.max(parseInt(top_k) || 3, 1), 5);
    const t0 = Date.now();

    // ─── SEMANTIC PATH (preferred) ───
    if (agent.kb_index_uri && Deno.env.get('AZURE_EMBEDDING_ENDPOINT') && Deno.env.get('AZURE_EMBEDDING_KEY')) {
      try {
        const [index, queryVec] = await Promise.all([fetchIndex(agent), embedQuery(query)]);
        if (!index?.chunks?.length) throw new Error('Index empty');

        const scored = index.chunks.map(c => ({
          content: c.content,
          score: cosineSim(queryVec, c.embedding)
        })).sort((a, b) => b.score - a.score);

        const results = scored.slice(0, k).map(s => ({
          content: s.content.slice(0, 1500),
          score: Number(s.score.toFixed(4))
        }));

        const ms = Date.now() - t0;
        console.log(`[kbSearch] semantic agent=${agent_id} q="${query.slice(0, 60)}" → ${results.length}/${index.chunks.length} (top=${results[0]?.score || 0}, ${ms}ms)`);
        return Response.json({
          success: true, mode: 'semantic',
          results, total_chunks: index.chunks.length, elapsed_ms: ms
        });
      } catch (semErr) {
        console.error(`[kbSearch] semantic failed, falling back: ${semErr.message}`);
        // Fall through to keyword fallback below
      }
    }

    // ─── KEYWORD FALLBACK ───
    if (!agent.kb_file_uri) {
      return Response.json({ success: true, results: [], message: 'KB index unavailable.' });
    }
    const fb = await keywordFallback(agent, query, k);
    const ms = Date.now() - t0;
    console.log(`[kbSearch] keyword agent=${agent_id} q="${query.slice(0, 60)}" → ${fb.results.length}/${fb.total_chunks} (${ms}ms)`);
    return Response.json({
      success: true, mode: 'keyword',
      results: fb.results, total_chunks: fb.total_chunks, elapsed_ms: ms
    });
  } catch (error) {
    console.error('[kbSearch] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});