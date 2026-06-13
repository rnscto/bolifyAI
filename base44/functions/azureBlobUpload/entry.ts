import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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

// ─── HMAC-SHA256 sign for Shared Key auth ───
async function signSharedKey(stringToSign, accountKey) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ─── Build Authorization header for PUT Blob ───
async function buildAuthHeader(method, accountName, accountKey, container, blobName, contentLength, contentType, dateStr) {
  const canonicalizedHeaders = `x-ms-blob-type:BlockBlob\nx-ms-date:${dateStr}\nx-ms-version:2021-08-06`;
  const canonicalizedResource = `/${accountName}/${container}/${blobName}`;
  const stringToSign = [
    method,
    '', // Content-Encoding
    '', // Content-Language
    contentLength || '', // Content-Length
    '', // Content-MD5
    contentType || '', // Content-Type
    '', // Date
    '', // If-Modified-Since
    '', // If-Match
    '', // If-None-Match
    '', // If-Unmodified-Since
    '', // Range
    canonicalizedHeaders,
    canonicalizedResource
  ].join('\n');
  const signature = await signSharedKey(stringToSign, accountKey);
  return `SharedKey ${accountName}:${signature}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Support two payload styles:
    //  1) multipart/form-data (file field) — when called via raw fetch
    //  2) JSON { file_base64, file_name, content_type, visibility, folder } — when
    //     called via base44.functions.invoke (which sends JSON, not multipart).
    let fileBytes;       // ArrayBuffer
    let fileName = 'file';
    let providedContentType = '';
    let visibility = 'public';
    let folder = '';

    const reqContentType = (req.headers.get('content-type') || '').toLowerCase();

    if (reqContentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file');
      visibility = (formData.get('visibility') || 'public').toString();
      folder = (formData.get('folder') || '').toString();
      if (!file || !(file instanceof File)) {
        return Response.json({ error: 'file required' }, { status: 400 });
      }
      fileBytes = await file.arrayBuffer();
      fileName = file.name || 'file';
      providedContentType = file.type || '';
    } else {
      let body;
      try { body = await req.json(); } catch { body = {}; }
      const { file_base64, file_name, content_type } = body;
      visibility = (body.visibility || 'public').toString();
      folder = (body.folder || '').toString();
      if (!file_base64) {
        return Response.json({ error: 'file required' }, { status: 400 });
      }
      // Accept both raw base64 and data URLs (data:...;base64,XXXX)
      const b64 = file_base64.includes(',') ? file_base64.split(',').pop() : file_base64;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      fileBytes = bytes.buffer;
      fileName = file_name || 'file';
      providedContentType = content_type || '';
    }

    folder = folder.replace(/[^a-zA-Z0-9_\-/]/g, '');

    const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    const containerPublic = Deno.env.get('AZURE_STORAGE_CONTAINER_PUBLIC');
    const containerPrivate = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
    if (!cs || !containerPublic || !containerPrivate) {
      return Response.json({ error: 'Azure storage not configured' }, { status: 500 });
    }

    const { accountName, accountKey, endpoint } = parseConnectionString(cs);
    const container = visibility === 'private' ? containerPrivate : containerPublic;

    // Build blob name: folder/timestamp-random-safename
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    const blobName = (folder ? `${folder}/` : '') + `${ts}-${rand}-${safeName}`;

    const arrayBuffer = fileBytes;
    const contentLength = arrayBuffer.byteLength;
    const contentType = providedContentType || 'application/octet-stream';
    const dateStr = new Date().toUTCString();

    const auth = await buildAuthHeader('PUT', accountName, accountKey, container, blobName, contentLength, contentType, dateStr);
    const url = `${endpoint}/${container}/${blobName}`;

    const putResp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': auth,
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-date': dateStr,
        'x-ms-version': '2021-08-06',
        'Content-Type': contentType,
        'Content-Length': String(contentLength)
      },
      body: arrayBuffer
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      console.error(`[azureBlobUpload] PUT failed ${putResp.status}: ${errText.substring(0, 500)}`);
      return Response.json({ error: `Upload failed: ${putResp.status}`, detail: errText.substring(0, 300) }, { status: 500 });
    }

    // For public: return direct URL. For private: return URI (caller must request signed URL to read).
    if (visibility === 'private') {
      return Response.json({
        success: true,
        file_uri: url,
        container,
        blob_name: blobName,
        size: contentLength,
        content_type: contentType
      });
    }
    return Response.json({
      success: true,
      file_url: url,
      container,
      blob_name: blobName,
      size: contentLength,
      content_type: contentType
    });
  } catch (error) {
    console.error('[azureBlobUpload] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});