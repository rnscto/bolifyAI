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

async function signSharedKey(stringToSign: string, accountKey: string) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function putBlob(params: { endpoint: string, accountName: string, accountKey: string, container: string, blobName: string, body: Uint8Array, contentType: string }) {
  const { endpoint, accountName, accountKey, container, blobName, body, contentType } = params;
  const dateStr = new Date().toUTCString();
  const contentLength = body.byteLength;
  const canonicalizedHeaders = `x-ms-blob-type:BlockBlob\\nx-ms-date:\${dateStr}\\nx-ms-version:2021-08-06`;
  const canonicalizedResource = `/\${accountName}/\${container}/\${blobName}`;
  const stringToSign = [
    'PUT', '', '', contentLength, '', contentType, '', '', '', '', '', '',
    canonicalizedHeaders, canonicalizedResource
  ].join('\\n');
  const signature = await signSharedKey(stringToSign, accountKey);
  const auth = `SharedKey \${accountName}:\${signature}`;

  const url = `\${endpoint}/\${container}/\${blobName}`;
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
    throw new Error(`Azure PUT failed \${resp.status}: \${(await resp.text()).substring(0, 300)}`);
  }
  return url;
}

export default async function uploadKBToStorage(c: any) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { agent_id } = body;
    if (!agent_id) return c.json({ data: { error: 'agent_id required' } }, 400);

    const agent = await base44.entities.Agent.get(agent_id);
    if (!agent) return c.json({ data: { error: 'Agent not found' } }, 404);

    const kbIds = agent.knowledge_base_ids || [];
    if (kbIds.length === 0) {
      if (agent.kb_file_uri) {
        await base44.entities.Agent.update(agent_id, { kb_file_uri: '', kb_file_hash: '', kb_char_count: 0 });
      }
      return c.json({ data: { success: true, message: 'No KB documents', char_count: 0 } });
    }

    const parts = [];
    for (const kbId of kbIds) {
      try {
        const doc = await base44.entities.KnowledgeBase.get(kbId);
        if (doc && doc.status === 'ready' && doc.content) {
          parts.push(`[\${doc.title || kbId}]\\n\${doc.content}\\n\\n---\\n\\n`);
        }
      } catch (_) {}
    }
    const combined = parts.join('');
    const charCount = combined.length;

    if (charCount === 0) {
      if (agent.kb_file_uri) {
        await base44.entities.Agent.update(agent_id, { kb_file_uri: '', kb_file_hash: '', kb_char_count: 0 });
      }
      return c.json({ data: { success: true, message: 'No ready KB content', char_count: 0 } });
    }

    const hash = await sha256Hex(combined);
    if (agent.kb_file_hash === hash && agent.kb_file_uri) {
      console.log(`[uploadKBToStorage] Hash match for agent \${agent_id} — skipping upload`);
      return c.json({
        data: {
          success: true,
          skipped: 'unchanged',
          file_uri: agent.kb_file_uri,
          char_count: charCount,
          hash
        }
      });
    }

    const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
    if (!cs || !container) return c.json({ data: { error: 'Azure storage not configured' } }, 500);

    const { accountName, accountKey, endpoint } = parseConnectionString(cs);
    const blobName = `kb/\${agent_id}/\${Date.now()}-\${hash.slice(0, 12)}.txt`;
    const bytes = new TextEncoder().encode(combined);

    const fileUri = await putBlob({
      endpoint, accountName, accountKey, container, blobName,
      body: bytes, contentType: 'text/plain; charset=utf-8'
    });

    await base44.entities.Agent.update(agent_id, {
      kb_file_uri: fileUri,
      kb_file_hash: hash,
      kb_char_count: charCount
    });

    console.log(`[uploadKBToStorage] Agent \${agent_id} KB uploaded: \${charCount} chars, hash=\${hash.slice(0, 12)}`);
    return c.json({
      data: {
        success: true,
        file_uri: fileUri,
        char_count: charCount,
        hash,
        docs_combined: parts.length
      }
    });
  } catch (error: any) {
    console.error('[uploadKBToStorage] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
