import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";
import { extractText, getDocumentProxy } from "npm:unpdf";
import mammoth from "npm:mammoth";

// ─── Azure Storage helpers (sign GET to fetch private blob) ───
function parseConnectionString(cs: string) {
  const parts: Record<string, string> = {};
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

async function signSharedKey(stringToSign: string, accountKey: string) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function fetchBlobBytes(fileUrl: string) {
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

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function putBlob({ endpoint, accountName, accountKey, container, blobName, body, contentType }: any) {
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

// Inline KB rebuild
async function rebuildAgentKB(agent: any) {
  const kbIds = agent.knowledge_base_ids || [];
  if (kbIds.length === 0) {
    if (agent.kb_file_uri) await base44ORM.entities.Agent.update(agent.id, { kb_file_uri: '', kb_file_hash: '', kb_char_count: 0 });
    return;
  }
  const parts = [];
  for (const kbId of kbIds) {
    try {
      const doc = await base44ORM.entities.KnowledgeBase.get(kbId);
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
  await base44ORM.entities.Agent.update(agent.id, {
    kb_file_uri: fileUri, kb_file_hash: hash, kb_char_count: combined.length
  });
  console.log(`[extractKB] Agent ${agent.name} KB rebuilt: ${combined.length} chars`);
}

// ─── Azure OpenAI vision for images ───
async function extractImageWithVision(bytes: Uint8Array, mimeType: string) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey) {
    throw new Error('Azure OpenAI not configured for OCR');
  }
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
async function extractContent(fileUrl: string, fileType: string) {
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
    const result = await mammoth.extractRawText({ buffer: bytes as any });
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
async function processKB(kbId: string, kb: any, data: any) {
  const fileUrl = kb?.file_url || data?.file_url || kb?.file_uri || data?.file_uri;
  if (!fileUrl) {
    console.log(`[extractKB] No file_url on KB ${kbId}, skipping`);
    return { skipped: 'no_file_url' };
  }

  const fileType = kb?.file_type || data?.file_type || '';
  console.log(`[extractKB] Extracting KB ${kbId} (${fileType || 'auto'}): ${fileUrl.substring(0, 100)}`);

  let content = '';
  try {
    content = await extractContent(fileUrl, fileType);
  } catch (e: any) {
    console.error(`[extractKB] Extraction failed for KB ${kbId}: ${e.message}`);
    await base44ORM.entities.KnowledgeBase.update(kbId, { status: 'failed' });
    return { success: false, error: e.message };
  }

  if (!content || content.trim().length === 0) {
    await base44ORM.entities.KnowledgeBase.update(kbId, { status: 'failed' });
    return { success: false, error: 'Empty content extracted' };
  }

  const truncated = content.substring(0, 100000); // 100k limit
  await base44ORM.entities.KnowledgeBase.update(kbId, {
    content: truncated,
    status: 'ready'
  });
  console.log(`[extractKB] KB ${kbId} extracted: ${truncated.length} chars`);

  try {
    const clientId = kb?.client_id || data?.client_id;
    if (clientId) {
      const agents = await base44ORM.entities.Agent.filter({ client_id: clientId });
      const affected = agents.filter((a: any) => (a.knowledge_base_ids || []).includes(kbId));
      console.log(`[extractKB] Rebuilding KB for ${affected.length} affected agent(s)`);
      for (const a of affected) {
        rebuildAgentKB(a).catch(e => console.error(`[extractKB] rebuild(${a.id}) failed: ${e.message}`));
      }
    }
  } catch (rebuildErr: any) {
    console.error(`[extractKB] KB rebuild trigger failed: ${rebuildErr.message}`);
  }

  return { success: true, chars: truncated.length };
}

export default async function (c: Context) {
  try {
    let payload;
    try { payload = await c.req.json(); } catch { payload = {}; }
    const { event, data, kb_id } = payload;

    // Entity automation trigger
    if (event && event.entity_name === 'KnowledgeBase' && event.type === 'create') {
      const kbId = event.entity_id;
      const result = await processKB(kbId, null, data);
      return c.json({ data: result });
    }

    // Direct invocation fallback
    if (kb_id) {
      const kb = await base44ORM.entities.KnowledgeBase.get(kb_id);
      if (!kb) return c.json({ data: { success: false, error: 'KB not found' } });
      const result = await processKB(kb_id, kb, null);
      return c.json({ data: result });
    }

    return c.json({ data: { success: true, skipped: 'no_matching_trigger' } });
  } catch (error: any) {
    console.error('[extractKB] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
