import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.25';

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

async function signSharedKey(stringToSign, accountKey) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function putBlob({ endpoint, accountName, accountKey, container, blobName, body, contentType }) {
  const dateStr = new Date().toUTCString();
  const contentLength = body.byteLength;
  const canonicalizedHeaders = `x-ms-blob-type:BlockBlob\nx-ms-date:${dateStr}\nx-ms-version:2021-08-06`;
  const canonicalizedResource = `/${accountName}/${container}/${blobName}`;
  const stringToSign = [
    'PUT', '', '', contentLength, '', contentType, '', '', '', '', '', '',
    canonicalizedHeaders, canonicalizedResource
  ].join('\n');
  const signature = await signSharedKey(stringToSign, accountKey);
  const auth = `SharedKey ${accountName}:${signature}`;

  const url = `${endpoint}/${container}/${blobName}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': auth,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-date': dateStr,
      'x-ms-version': '2021-08-06',
      'Content-Type': contentType,
      'Content-Length': String(contentLength)
    },
    body
  });
  if (!resp.ok) {
    throw new Error(`Azure PUT failed ${resp.status}: ${(await resp.text()).substring(0, 300)}`);
  }
  return url;
}

// ─── Split combined KB blob into chunks (mirrors kbSearch.splitIntoChunks) ───
function splitIntoChunks(content) {
  const chunks = [];
  const sections = content.split(/\n\n---\n\n/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 1500) {
      chunks.push(trimmed);
    } else {
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

// ─── Embed chunks via Azure Foundry embedding endpoint (text-embedding-3-small) ───
// Foundry uses /openai/v1/embeddings with model name in body and api-version=preview
async function embedChunks(chunks) {
  const base = (Deno.env.get('AZURE_EMBEDDING_ENDPOINT') || '').replace(/\/+$/, '');
  const apiKey = Deno.env.get('AZURE_EMBEDDING_KEY');
  const model = Deno.env.get('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
  if (!base || !apiKey || !model) {
    throw new Error('Embedding endpoint/key/model not configured');
  }
  const url = `${base}/openai/v1/embeddings`;
  console.log(`[uploadKBToStorage] embed URL: ${url}, model: ${model}`);

  const all = [];
  const BATCH = 16;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: batch, model })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Embedding API ${resp.status}: ${errText.substring(0, 300)}`);
    }
    const data = await resp.json();
    if (!Array.isArray(data.data)) throw new Error('Embedding response missing data');
    // Order is preserved per Azure OpenAI docs
    data.data.forEach(d => all.push(d.embedding));
  }
  return all;
}

Deno.serve(async (req) => {
  try {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    const { agent_id, _internal } = body;
    if (!agent_id) return Response.json({ error: 'agent_id required' }, { status: 400 });

    let base44;
    if (_internal) {
      base44 = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    } else {
      base44 = createClientFromRequest(req);
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const svc = _internal ? base44 : base44.asServiceRole;

    const agent = await svc.entities.Agent.get(agent_id);
    if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });

    const kbIds = agent.knowledge_base_ids || [];
    if (kbIds.length === 0) {
      if (agent.kb_file_uri || agent.kb_index_uri) {
        await svc.entities.Agent.update(agent_id, {
          kb_file_uri: '', kb_file_hash: '', kb_char_count: 0,
          kb_index_uri: '', kb_embedding_model: ''
        });
      }
      return Response.json({ success: true, message: 'No KB documents', char_count: 0 });
    }

    // Concatenate all ready KB docs
    const parts = [];
    for (const kbId of kbIds) {
      try {
        const doc = await svc.entities.KnowledgeBase.get(kbId);
        if (doc && doc.status === 'ready' && doc.content) {
          parts.push(`[${doc.title || kbId}]\n${doc.content}\n\n---\n\n`);
        }
      } catch (_) { /* skip missing */ }
    }
    const combined = parts.join('');
    const charCount = combined.length;

    if (charCount === 0) {
      if (agent.kb_file_uri || agent.kb_index_uri) {
        await svc.entities.Agent.update(agent_id, {
          kb_file_uri: '', kb_file_hash: '', kb_char_count: 0,
          kb_index_uri: '', kb_embedding_model: ''
        });
      }
      return Response.json({ success: true, message: 'No ready KB content', char_count: 0 });
    }

    const embeddingDeployment = Deno.env.get('AZURE_OPENAI_EMBEDDING_DEPLOYMENT') || '';
    const hash = await sha256Hex(combined);

    // Skip rebuild if content unchanged AND embedding model unchanged
    if (
      agent.kb_file_hash === hash &&
      agent.kb_file_uri &&
      agent.kb_embedding_model === embeddingDeployment &&
      agent.kb_index_uri
    ) {
      console.log(`[uploadKBToStorage] Hash + model match for agent ${agent_id} — skipping`);
      return Response.json({
        success: true, skipped: 'unchanged',
        file_uri: agent.kb_file_uri, index_uri: agent.kb_index_uri,
        char_count: charCount, hash
      });
    }

    const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
    if (!cs || !container) return Response.json({ error: 'Azure storage not configured' }, { status: 500 });

    const { accountName, accountKey, endpoint } = parseConnectionString(cs);
    const ts = Date.now();
    const baseBlobName = `kb/${agent_id}/${ts}-${hash.slice(0, 12)}`;

    // 1) Upload raw text blob (kept for backward compatibility / debugging)
    const fileUri = await putBlob({
      endpoint, accountName, accountKey, container,
      blobName: `${baseBlobName}.txt`,
      body: new TextEncoder().encode(combined),
      contentType: 'text/plain; charset=utf-8'
    });

    // 2) Build semantic index — chunk + embed
    const chunks = splitIntoChunks(combined);
    let indexUri = '';
    let embeddingModelUsed = '';

    if (embeddingDeployment) {
      try {
        const t0 = Date.now();
        const embeddings = await embedChunks(chunks);
        const embedMs = Date.now() - t0;

        const indexJson = {
          version: 1,
          agent_id,
          hash,
          model: embeddingDeployment,
          dim: embeddings[0]?.length || 0,
          chunk_count: chunks.length,
          created_at: new Date().toISOString(),
          chunks: chunks.map((content, i) => ({ content, embedding: embeddings[i] }))
        };
        const indexBytes = new TextEncoder().encode(JSON.stringify(indexJson));

        indexUri = await putBlob({
          endpoint, accountName, accountKey, container,
          blobName: `${baseBlobName}.index.json`,
          body: indexBytes,
          contentType: 'application/json; charset=utf-8'
        });
        embeddingModelUsed = embeddingDeployment;
        console.log(`[uploadKBToStorage] Agent ${agent_id} indexed: ${chunks.length} chunks, ${embedMs}ms, dim=${indexJson.dim}`);
      } catch (embedErr) {
        // Don't fail the whole upload — semantic search will fall back to keyword search
        console.error(`[uploadKBToStorage] Embedding failed (will fallback to keyword): ${embedErr.message}`);
      }
    } else {
      console.log(`[uploadKBToStorage] AZURE_OPENAI_EMBEDDING_DEPLOYMENT not set — skipping semantic index (keyword fallback)`);
    }

    await svc.entities.Agent.update(agent_id, {
      kb_file_uri: fileUri,
      kb_file_hash: hash,
      kb_char_count: charCount,
      kb_index_uri: indexUri,
      kb_embedding_model: embeddingModelUsed
    });

    console.log(`[uploadKBToStorage] Agent ${agent_id} KB uploaded: ${charCount} chars, semantic=${!!indexUri}`);
    return Response.json({
      success: true,
      file_uri: fileUri,
      index_uri: indexUri,
      char_count: charCount,
      chunk_count: chunks.length,
      semantic: !!indexUri,
      hash,
      docs_combined: parts.length
    });
  } catch (error) {
    console.error('[uploadKBToStorage] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});