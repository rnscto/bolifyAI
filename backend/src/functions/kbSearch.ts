import { base44ORM as base44 } from "../db/orm.ts";

function parseConnectionString(cs: string) {
  const parts: Record<string, string> = {};
  for (const seg of cs.split(';')) {
    const idx = seg.indexOf('=');
    if (idx > 0) parts[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
  }
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
    endpoint: parts.BlobEndpoint || `https://\${parts.AccountName}.blob.\${parts.EndpointSuffix || 'core.windows.net'}`
  };
}

async function hmacSha256(stringToSign: string, accountKey: string) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function buildGetAuthHeader(accountName: string, accountKey: string, container: string, blobName: string, dateStr: string) {
  const canonicalizedHeaders = `x-ms-date:\${dateStr}\\nx-ms-version:2021-08-06`;
  const canonicalizedResource = `/\${accountName}/\${container}/\${blobName}`;
  const stringToSign = [
    'GET', '', '', '', '', '', '', '', '', '', '', '',
    canonicalizedHeaders, canonicalizedResource
  ].join('\\n');
  const signature = await hmacSha256(stringToSign, accountKey);
  return `SharedKey \${accountName}:\${signature}`;
}

const BLOB_CACHE = new Map<string, { content: string, ts: number }>();
const BLOB_CACHE_TTL_MS = 10 * 60 * 1000;
const BLOB_CACHE_MAX_ENTRIES = 32;

async function fetchAgentKBContent(agent: any) {
  const cacheKey = `\${agent.id}:\${agent.kb_file_hash || 'none'}`;
  const cached = BLOB_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < BLOB_CACHE_TTL_MS) {
    return cached.content;
  }

  const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  if (!cs) throw new Error('Azure storage not configured');
  const { accountName, accountKey, endpoint } = parseConnectionString(cs);

  const parsed = new URL(agent.kb_file_uri);
  const expectedHost = new URL(endpoint).host;
  if (parsed.host !== expectedHost) throw new Error('kb_file_uri host mismatch');
  const pathParts = parsed.pathname.replace(/^\/+/, '').split('/');
  const container = pathParts.shift();
  const blobName = pathParts.join('/');
  if (!container || !blobName) throw new Error('Invalid blob path');

  const dateStr = new Date().toUTCString();
  const auth = await buildGetAuthHeader(accountName, accountKey, container, blobName, dateStr);
  const resp = await fetch(`\${endpoint}/\${container}/\${blobName}`, {
    headers: {
      'Authorization': auth,
      'x-ms-date': dateStr,
      'x-ms-version': '2021-08-06'
    }
  });
  if (!resp.ok) throw new Error(`Azure GET failed \${resp.status}`);
  const content = await resp.text();

  if (BLOB_CACHE.size >= BLOB_CACHE_MAX_ENTRIES) {
    const firstKey = BLOB_CACHE.keys().next().value;
    if (firstKey) BLOB_CACHE.delete(firstKey);
  }
  BLOB_CACHE.set(cacheKey, { content, ts: Date.now() });
  return content;
}

function splitIntoChunks(content: string) {
  const chunks: string[] = [];
  const sections = content.split(/\\n\\n---\\n\\n/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 1500) {
      chunks.push(trimmed);
    } else {
      const paras = trimmed.split(/\\n\\s*\\n/);
      let buf = '';
      for (const p of paras) {
        if ((buf + '\\n\\n' + p).length > 1200 && buf) {
          chunks.push(buf.trim());
          buf = p;
        } else {
          buf = buf ? buf + '\\n\\n' + p : p;
        }
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
  'mein','hai','hain','ho','ka','ki','ke','ko','se','ne','par','tha','thi','the',
  'aap','main','hum','kya','kaise','kahan','kab','kyun','aur','ya','toh','phir'
]);

function tokenize(text: string) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\\p{L}\\p{N}\\s]/gu, ' ')
    .split(/\\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function scoreChunk(chunk: string, queryTokens: string[], queryRaw: string) {
  const text = chunk.toLowerCase();
  let score = 0;

  const matchedTokens = new Set<string>();
  for (const tok of queryTokens) {
    if (text.includes(tok)) matchedTokens.add(tok);
  }
  score += matchedTokens.size * 10;

  if (queryRaw.length >= 4 && text.includes(queryRaw.toLowerCase())) {
    score += 25;
  }

  const firstLine = chunk.split('\\n')[0].toLowerCase();
  for (const tok of matchedTokens) {
    if (firstLine.includes(tok)) { score += 8; break; }
  }

  let totalOccurrences = 0;
  for (const tok of matchedTokens) {
    const re = new RegExp(`\\\\b\${tok.replace(/[.*+?^\\$\\{\\}()|[\\]\\\\]/g, '\\\\$&')}`, 'g');
    const m = text.match(re);
    if (m) totalOccurrences += m.length;
  }
  score += Math.min(totalOccurrences, 10);

  return { score, matchedCount: matchedTokens.size };
}

export default async function kbSearch(c: any) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { agent_id, query, top_k } = body;
    if (!agent_id) return c.json({ data: { error: 'agent_id required' } }, 400);
    if (!query || typeof query !== 'string') return c.json({ data: { error: 'query required' } }, 400);

    const agent = await base44.entities.Agent.get(agent_id);
    if (!agent) return c.json({ data: { error: 'Agent not found' } }, 404);

    if (!agent.kb_file_uri) {
      return c.json({
        data: {
          success: true,
          results: [],
          message: 'No knowledge base configured for this agent.'
        }
      });
    }

    const t0 = Date.now();
    const content = await fetchAgentKBContent(agent);
    const fetchMs = Date.now() - t0;

    const chunks = splitIntoChunks(content);
    if (chunks.length === 0) {
      return c.json({ data: { success: true, results: [], message: 'KB empty.' } });
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return c.json({
        data: {
          success: true,
          results: [{ content: chunks[0].slice(0, 1000), score: 0 }],
          total_chunks: chunks.length,
          fetch_ms: fetchMs
        }
      });
    }

    const scored = chunks
      .map(ch => ({ content: ch, ...scoreChunk(ch, queryTokens, query) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const k = Math.min(Math.max(parseInt(top_k) || 3, 1), 5);
    const results = scored.slice(0, k).map(s => ({
      content: s.content.slice(0, 1500),
      score: s.score,
      matched_keywords: s.matchedCount
    }));

    console.log(`[kbSearch] agent=\${agent_id} q="\${query.slice(0, 60)}" → \${results.length}/\${chunks.length} chunks (top=\${results[0]?.score || 0}, fetch=\${fetchMs}ms)`);

    return c.json({
      data: {
        success: true,
        results,
        total_chunks: chunks.length,
        fetch_ms: fetchMs,
        query_tokens: queryTokens
      }
    });
  } catch (error: any) {
    console.error('[kbSearch] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }
}
