// Extract text content from KB files using Azure (no Base44 integration credits).
// Supports: txt, csv, json, html, md (direct decode), pdf (unpdf with vision OCR fallback),
// docx (mammoth), images (Azure OpenAI vision).
// Inlines KB rebuild to Azure Blob (no cross-function invoke — avoids 403).
//
// Triggered by:
//   - KnowledgeBase entity create automation: { event, data }
//   - Direct invocation: { kb_id }

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { extractText, getDocumentProxy } from 'npm:unpdf@0.12.1';
import mammoth from 'npm:mammoth@1.8.0';

// ─── Azure Storage helpers (sign GET to fetch private blob) ───
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

async function fetchBlobBytes(fileUrl) {
  // If it's an Azure blob URL we own, sign and GET; else just fetch.
  const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  if (cs && fileUrl) {
    const { accountName, accountKey, endpoint } = parseConnectionString(cs);
    if (fileUrl.startsWith(endpoint)) {
      const path = fileUrl.substring(endpoint.length); // /container/blob...
      const dateStr = new Date().toUTCString();
      const canonicalizedHeaders = `x-ms-date:${dateStr}\nx-ms-version:2021-08-06`;
      const canonicalizedResource = `/${accountName}${path.split('?')[0]}`;
      const stringToSign = ['GET', '', '', '', '', '', '', '', '', '', '', '', canonicalizedHeaders, canonicalizedResource].join('\n');
      const signature = await signSharedKey(stringToSign, accountKey);
      const resp = await fetch(fileUrl, {
        headers: {
          'Authorization': `SharedKey ${accountName}:${signature}`,
          'x-ms-date': dateStr,
          'x-ms-version': '2021-08-06'
        }
      });
      if (!resp.ok) throw new Error(`Azure GET failed ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
      return new Uint8Array(await resp.arrayBuffer());
    }
  }
  // Public URL fallback
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`Fetch failed ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
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
  if (!resp.ok) throw new Error(`Azure PUT ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  return url;
}

// Inline KB rebuild (mirrors uploadKBToStorage logic to avoid cross-fn 403)
async function rebuildAgentKB(svc, agent) {
  const kbIds = agent.knowledge_base_ids || [];
  if (kbIds.length === 0) {
    if (agent.kb_file_uri) await svc.entities.Agent.update(agent.id, { kb_file_uri: '', kb_file_hash: '', kb_char_count: 0 });
    return;
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
  if (combined.length === 0) return;
  const hash = await sha256Hex(combined);
  if (agent.kb_file_hash === hash && agent.kb_file_uri) return;

  const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
  if (!cs || !container) throw new Error('Azure storage not configured');
  const { accountName, accountKey, endpoint } = parseConnectionString(cs);
  const blobName = `kb/${agent.id}/${Date.now()}-${hash.slice(0, 12)}.txt`;
  const fileUri = await putBlob({
    endpoint, accountName, accountKey, container, blobName,
    body: new TextEncoder().encode(combined), contentType: 'text/plain; charset=utf-8'
  });
  await svc.entities.Agent.update(agent.id, {
    kb_file_uri: fileUri, kb_file_hash: hash, kb_char_count: combined.length
  });
  console.log(`[extractKB] Agent ${agent.name} KB rebuilt: ${combined.length} chars`);
}

// ─── Azure OpenAI vision for images ───
async function extractImageWithVision(bytes, mimeType) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const b64 = btoa(String.fromCharCode(...bytes));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'Extract all visible text from this image verbatim. Return only the text, no commentary.' },
        { role: 'user', content: [
          { type: 'text', text: 'Extract all text from this image.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
        ]}
      ],
      max_completion_tokens: 4000
    })
  });
  if (!res.ok) throw new Error(`Vision OCR failed ${res.status}: ${(await res.text()).substring(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Main extractor by file type ───
async function extractContent(fileUrl, fileType) {
  const bytes = await fetchBlobBytes(fileUrl);
  const lowerUrl = (fileUrl || '').toLowerCase();
  const ft = (fileType || '').toLowerCase();

  // Plain text formats
  if (ft === 'txt' || ft === 'csv' || ft === 'json' || ft === 'html' || ft === 'md' ||
      lowerUrl.endsWith('.txt') || lowerUrl.endsWith('.csv') || lowerUrl.endsWith('.json') ||
      lowerUrl.endsWith('.html') || lowerUrl.endsWith('.md')) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  // PDF
  if (ft === 'pdf' || lowerUrl.endsWith('.pdf')) {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return text || '';
  }

  // DOCX
  if (ft === 'docx' || lowerUrl.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value || '';
  }

  // Images → vision OCR
  if (lowerUrl.match(/\.(png|jpe?g|webp|gif)$/)) {
    const mime = lowerUrl.endsWith('.png') ? 'image/png'
      : lowerUrl.endsWith('.webp') ? 'image/webp'
      : lowerUrl.endsWith('.gif') ? 'image/gif'
      : 'image/jpeg';
    return await extractImageWithVision(bytes, mime);
  }

  // Fallback: try as plain text
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

// ─── Process a single KB record ───
async function processKB(svc, kbId, kb, data) {
  const fileUrl = kb?.file_url || data?.file_url;
  if (!fileUrl) {
    console.log(`[extractKB] No file_url on KB ${kbId}, skipping`);
    return { skipped: 'no_file_url' };
  }

  const fileType = kb?.file_type || data?.file_type || '';
  console.log(`[extractKB] Extracting KB ${kbId} (${fileType || 'auto'}): ${fileUrl.substring(0, 100)}`);

  let content = '';
  try {
    content = await extractContent(fileUrl, fileType);
  } catch (e) {
    console.error(`[extractKB] Extraction failed for KB ${kbId}: ${e.message}`);
    await svc.entities.KnowledgeBase.update(kbId, { status: 'failed' });
    return { success: false, error: e.message };
  }

  if (!content || content.trim().length === 0) {
    await svc.entities.KnowledgeBase.update(kbId, { status: 'failed' });
    return { success: false, error: 'Empty content extracted' };
  }

  // KnowledgeBase.content has a hard size limit. Truncate aggressively.
  const truncated = content.substring(0, 10000);
  await svc.entities.KnowledgeBase.update(kbId, {
    content: truncated,
    status: 'ready'
  });
  console.log(`[extractKB] KB ${kbId} extracted: ${truncated.length} chars`);

  // Auto-rebuild Azure Blob KB for affected agents (inline — avoids cross-fn 403)
  try {
    const clientId = kb?.client_id || data?.client_id;
    if (clientId) {
      const agents = await svc.entities.Agent.filter({ client_id: clientId });
      const affected = agents.filter(a => (a.knowledge_base_ids || []).includes(kbId));
      console.log(`[extractKB] Rebuilding KB for ${affected.length} affected agent(s)`);
      for (const a of affected) {
        rebuildAgentKB(svc, a).catch(e => console.error(`[extractKB] rebuild(${a.id}) failed: ${e.message}`));
      }
    }
  } catch (rebuildErr) {
    console.error(`[extractKB] KB rebuild trigger failed: ${rebuildErr.message}`);
  }

  return { success: true, chars: truncated.length };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    const payload = await req.json();
    const { event, data } = payload;

    // Entity automation trigger
    if (event && event.entity_name === 'KnowledgeBase' && event.type === 'create') {
      const kbId = event.entity_id;
      const result = await processKB(svc, kbId, null, data);
      return Response.json(result);
    }

    // Direct invocation fallback
    if (payload.kb_id) {
      const kb = await svc.entities.KnowledgeBase.get(payload.kb_id);
      if (!kb) return Response.json({ error: 'KB not found' }, { status: 400 });
      const result = await processKB(svc, payload.kb_id, kb, null);
      return Response.json(result);
    }

    return Response.json({ success: true, skipped: 'no_matching_trigger' });
  } catch (error) {
    console.error('[extractKB] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});