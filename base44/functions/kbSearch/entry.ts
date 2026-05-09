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

// Build SharedKey auth header for GET Blob
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

// ─── In-memory cache for blob content (per worker, per agent KB hash) ───
// Key: `${agent_id}:${kb_file_hash}` → { content, ts }
// TTL 10 min — survives multiple turns of the same call without re-fetching Azure.
const BLOB_CACHE = new Map();
const BLOB_CACHE_TTL_MS = 10 * 60 * 1000;
const BLOB_CACHE_MAX_ENTRIES = 32;

async function fetchAgentKBContent(agent) {
  const cacheKey = `${agent.id}:${agent.kb_file_hash || 'none'}`;
  const cached = BLOB_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < BLOB_CACHE_TTL_MS) {
    return cached.content;
  }

  const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  if (!cs) throw new Error('Azure storage not configured');
  const { accountName, accountKey, endpoint } = parseConnectionString(cs);

  // Parse the URI: e.g. https://acct.blob.core.windows.net/container/path/to/blob
  const parsed = new URL(agent.kb_file_uri);
  const expectedHost = new URL(endpoint).host;
  if (parsed.host !== expectedHost) throw new Error('kb_file_uri host mismatch');
  const pathParts = parsed.pathname.replace(/^\/+/, '').split('/');
  const container = pathParts.shift();
  const blobName = pathParts.join('/');
  if (!container || !blobName) throw new Error('Invalid blob path');

  const dateStr = new Date().toUTCString();
  const auth = await buildGetAuthHeader(accountName, accountKey, container, blobName, dateStr);
  const resp = await fetch(`${endpoint}/${container}/${blobName}`, {
    headers: {
      'Authorization': auth,
      'x-ms-date': dateStr,
      'x-ms-version': '2021-08-06'
    }
  });
  if (!resp.ok) throw new Error(`Azure GET failed ${resp.status}`);
  const content = await resp.text();

  // Evict oldest if over capacity
  if (BLOB_CACHE.size >= BLOB_CACHE_MAX_ENTRIES) {
    const firstKey = BLOB_CACHE.keys().next().value;
    if (firstKey) BLOB_CACHE.delete(firstKey);
  }
  BLOB_CACHE.set(cacheKey, { content, ts: Date.now() });
  return content;
}

// ─── Split combined KB blob into chunks ───
// uploadKBToStorage joins docs with `\n\n---\n\n` and prefixes each with `[Title]\n`.
// We split by that separator first, then sub-chunk long sections by paragraph.
function splitIntoChunks(content) {
  const chunks = [];
  const sections = content.split(/\n\n---\n\n/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 1500) {
      chunks.push(trimmed);
    } else {
      // Long section — split by paragraph, group up to ~1200 chars each
      const paras = trimmed.split(/\n\s*\n/);
      let buf = '';
      for (const p of paras) {
        if ((buf + '\n\n' + p).length > 1200 && buf) {
          chunks.push(buf.trim());
          buf = p;
        } else {
          buf = buf ? buf + '\n\n' + p : p;
        }
      }
      if (buf.trim()) chunks.push(buf.trim());
    }
  }
  return chunks;
}

// ─── Tokenize for keyword scoring ───
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','can','of',
  'to','in','on','at','for','with','by','from','as','it','this','that','these',
  'those','i','you','he','she','we','they','what','when','where','why','how',
  'and','or','but','if','then','so','my','your','our','their','me','us','him','her',
  'mein','hai','hain','ho','ka','ki','ke','ko','se','ne','par','tha','thi','the',
  'aap','main','hum','kya','kaise','kahan','kab','kyun','aur','ya','toh','phir'
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// ─── Score a chunk against query tokens ───
// Combines: keyword overlap + phrase match bonus + section header weight.
function scoreChunk(chunk, queryTokens, queryRaw) {
  const text = chunk.toLowerCase();
  let score = 0;

  // Keyword overlap — count distinct query tokens present
  const matchedTokens = new Set();
  for (const tok of queryTokens) {
    if (text.includes(tok)) matchedTokens.add(tok);
  }
  score += matchedTokens.size * 10;

  // Phrase match bonus (raw query as exact substring, e.g. "return policy")
  if (queryRaw.length >= 4 && text.includes(queryRaw.toLowerCase())) {
    score += 25;
  }

  // Bonus if title/heading at start of chunk contains a query token
  const firstLine = chunk.split('\n')[0].toLowerCase();
  for (const tok of matchedTokens) {
    if (firstLine.includes(tok)) { score += 8; break; }
  }

  // Mild bonus for token frequency (capped to avoid over-weighting long chunks)
  let totalOccurrences = 0;
  for (const tok of matchedTokens) {
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    const m = text.match(re);
    if (m) totalOccurrences += m.length;
  }
  score += Math.min(totalOccurrences, 10);

  return { score, matchedCount: matchedTokens.size };
}

Deno.serve(async (req) => {
  try {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    const { agent_id, query, top_k, _internal } = body;
    if (!agent_id) return Response.json({ error: 'agent_id required' }, { status: 400 });
    if (!query || typeof query !== 'string') return Response.json({ error: 'query required' }, { status: 400 });

    // Auth — allow internal calls (from streamAudio, asServiceRole) to skip user auth
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

    if (!agent.kb_file_uri) {
      return Response.json({
        success: true,
        results: [],
        message: 'No knowledge base configured for this agent.'
      });
    }

    const t0 = Date.now();
    const content = await fetchAgentKBContent(agent);
    const fetchMs = Date.now() - t0;

    const chunks = splitIntoChunks(content);
    if (chunks.length === 0) {
      return Response.json({ success: true, results: [], message: 'KB empty.' });
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      // Query is all stopwords — return first chunk as a fallback
      return Response.json({
        success: true,
        results: [{ content: chunks[0].slice(0, 1000), score: 0 }],
        total_chunks: chunks.length,
        fetch_ms: fetchMs
      });
    }

    const scored = chunks
      .map(c => ({ content: c, ...scoreChunk(c, queryTokens, query) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const k = Math.min(Math.max(parseInt(top_k) || 3, 1), 5);
    const results = scored.slice(0, k).map(s => ({
      content: s.content.slice(0, 1500),
      score: s.score,
      matched_keywords: s.matchedCount
    }));

    console.log(`[kbSearch] agent=${agent_id} q="${query.slice(0, 60)}" → ${results.length}/${chunks.length} chunks (top=${results[0]?.score || 0}, fetch=${fetchMs}ms)`);

    return Response.json({
      success: true,
      results,
      total_chunks: chunks.length,
      fetch_ms: fetchMs,
      query_tokens: queryTokens
    });
  } catch (error) {
    console.error('[kbSearch] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});