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
      // Clear KB fields if agent has no KB
      if (agent.kb_file_uri) {
        await svc.entities.Agent.update(agent_id, { kb_file_uri: '', kb_file_hash: '', kb_char_count: 0 });
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
      if (agent.kb_file_uri) {
        await svc.entities.Agent.update(agent_id, { kb_file_uri: '', kb_file_hash: '', kb_char_count: 0 });
      }
      return Response.json({ success: true, message: 'No ready KB content', char_count: 0 });
    }

    // Hash for change detection
    const hash = await sha256Hex(combined);
    if (agent.kb_file_hash === hash && agent.kb_file_uri) {
      console.log(`[uploadKBToStorage] Hash match for agent ${agent_id} — skipping upload`);
      return Response.json({
        success: true,
        skipped: 'unchanged',
        file_uri: agent.kb_file_uri,
        char_count: charCount,
        hash
      });
    }

    // Upload to Azure private container
    const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
    if (!cs || !container) return Response.json({ error: 'Azure storage not configured' }, { status: 500 });

    const { accountName, accountKey, endpoint } = parseConnectionString(cs);
    const blobName = `kb/${agent_id}/${Date.now()}-${hash.slice(0, 12)}.txt`;
    const bytes = new TextEncoder().encode(combined);

    const fileUri = await putBlob({
      endpoint, accountName, accountKey, container, blobName,
      body: bytes, contentType: 'text/plain; charset=utf-8'
    });

    await svc.entities.Agent.update(agent_id, {
      kb_file_uri: fileUri,
      kb_file_hash: hash,
      kb_char_count: charCount
    });

    console.log(`[uploadKBToStorage] Agent ${agent_id} KB uploaded: ${charCount} chars, hash=${hash.slice(0, 12)}`);
    return Response.json({
      success: true,
      file_uri: fileUri,
      char_count: charCount,
      hash,
      docs_combined: parts.length
    });
  } catch (error) {
    console.error('[uploadKBToStorage] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});