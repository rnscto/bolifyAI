// One-time backfill: builds kb_file_uri (Azure Blob) for every agent that has
// knowledge_base_ids but no kb_file_uri yet. Admin-only. Inlines Azure upload to
// avoid cross-function service-role 403.
//
// Usage:
//   POST { dry_run: true }   → reports what WOULD be processed
//   POST {}                  → upload all
//   POST { agent_id: "..." } → process a single agent

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

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
  const stringToSign = ['PUT', '', '', contentLength, '', contentType, '', '', '', '', '', '', canonicalizedHeaders, canonicalizedResource].join('\n');
  const signature = await signSharedKey(stringToSign, accountKey);
  const url = `${endpoint}/${container}/${blobName}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `SharedKey ${accountName}:${signature}`,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-date': dateStr,
      'x-ms-version': '2021-08-06',
      'Content-Type': contentType,
      'Content-Length': String(contentLength)
    },
    body
  });
  if (!resp.ok) throw new Error(`Azure PUT ${resp.status}: ${(await resp.text()).substring(0, 300)}`);
  return url;
}

async function rebuildAgentKB(svc, agent, azure) {
  const kbIds = agent.knowledge_base_ids || [];
  if (kbIds.length === 0) {
    if (agent.kb_file_uri) await svc.entities.Agent.update(agent.id, { kb_file_uri: '', kb_file_hash: '', kb_char_count: 0 });
    return { agent: agent.name, status: 'no_kb', char_count: 0 };
  }

  const parts = [];
  for (const kbId of kbIds) {
    try {
      const doc = await svc.entities.KnowledgeBase.get(kbId);
      if (doc && doc.status === 'ready' && doc.content) {
        parts.push(`[${doc.title || kbId}]\n${doc.content}\n\n---\n\n`);
      }
    } catch (_) {}
  }
  const combined = parts.join('');
  if (combined.length === 0) return { agent: agent.name, status: 'no_ready_content', char_count: 0 };

  const hash = await sha256Hex(combined);
  if (agent.kb_file_hash === hash && agent.kb_file_uri) {
    return { agent: agent.name, status: 'unchanged', char_count: combined.length };
  }

  const blobName = `kb/${agent.id}/${Date.now()}-${hash.slice(0, 12)}.txt`;
  const bytes = new TextEncoder().encode(combined);
  const fileUri = await putBlob({ ...azure, blobName, body: bytes, contentType: 'text/plain; charset=utf-8' });

  await svc.entities.Agent.update(agent.id, {
    kb_file_uri: fileUri,
    kb_file_hash: hash,
    kb_char_count: combined.length
  });

  return { agent: agent.name, status: 'uploaded', char_count: combined.length, file_uri: fileUri };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { dry_run, agent_id } = body;
    const svc = base44.asServiceRole;

    let agents;
    if (agent_id) {
      const a = await svc.entities.Agent.get(agent_id).catch(() => null);
      agents = a ? [a] : [];
    } else {
      agents = await svc.entities.Agent.list('-created_date', 1000);
    }

    const candidates = agents.filter(a => (a.knowledge_base_ids || []).length > 0);

    if (dry_run) {
      return Response.json({
        success: true, dry_run: true,
        total_agents: agents.length,
        agents_with_kb: candidates.length,
        agents_missing_uri: candidates.filter(a => !a.kb_file_uri).length,
        sample: candidates.slice(0, 10).map(a => ({ id: a.id, name: a.name, kb_docs: a.knowledge_base_ids?.length || 0, has_uri: !!a.kb_file_uri }))
      });
    }

    const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
    if (!cs || !container) return Response.json({ error: 'Azure storage not configured' }, { status: 500 });
    const { accountName, accountKey, endpoint } = parseConnectionString(cs);
    const azure = { accountName, accountKey, endpoint, container };

    const results = [];
    let uploaded = 0, unchanged = 0, errors = 0;
    for (const a of candidates) {
      try {
        const r = await rebuildAgentKB(svc, a, azure);
        results.push(r);
        if (r.status === 'uploaded') uploaded++;
        else if (r.status === 'unchanged') unchanged++;
      } catch (e) {
        errors++;
        results.push({ agent: a.name, status: 'error', error: e.message });
        console.error(`[backfillKB] ${a.name}: ${e.message}`);
      }
    }

    return Response.json({ success: true, total: candidates.length, uploaded, unchanged, errors, results });
  } catch (error) {
    console.error('[backfillKB] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});