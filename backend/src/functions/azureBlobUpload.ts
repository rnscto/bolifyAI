import { Context } from "hono";

// ─── Parse Azure connection string ───
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

// ─── HMAC-SHA256 sign for Shared Key auth ───
async function signSharedKey(stringToSign: string, accountKey: string) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ─── Build Authorization header for PUT Blob ───
async function buildAuthHeader(method: string, accountName: string, accountKey: string, container: string, blobName: string, contentLength: number, contentType: string, dateStr: string) {
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

export default async function (c: Context) {
  try {
    let fileBytes: ArrayBuffer;
    let fileName = 'file';
    let providedContentType = '';
    let visibility = 'public';
    let folder = '';

    const reqContentType = (c.req.header('content-type') || '').toLowerCase();

    if (reqContentType.includes('multipart/form-data')) {
      const formData = await c.req.parseBody();
      const file = formData['file'];
      visibility = (formData['visibility'] || 'public').toString();
      folder = (formData['folder'] || '').toString();
      
      if (!file || !(file instanceof File)) {
        return c.json({ data: { success: false, error: 'file required' } });
      }
      fileBytes = await file.arrayBuffer();
      fileName = file.name || 'file';
      providedContentType = file.type || '';
    } else {
      let body: any;
      try { body = await c.req.json(); } catch { body = {}; }
      const { file_base64, file_name, content_type } = body;
      visibility = (body.visibility || 'public').toString();
      folder = (body.folder || '').toString();
      if (!file_base64) {
        return c.json({ data: { success: false, error: 'file required' } });
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
      return c.json({ data: { success: false, error: 'Azure storage not configured in .env' } });
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
      return c.json({ data: { success: false, error: `Upload failed: ${putResp.status}` } });
    }

    // For public: return direct URL. For private: return URI (caller must request signed URL to read).
    if (visibility === 'private') {
      return c.json({ data: {
        success: true,
        file_uri: url,
        container,
        blob_name: blobName,
        size: contentLength,
        content_type: contentType
      } });
    }
    return c.json({ data: {
      success: true,
      file_url: url,
      container,
      blob_name: blobName,
      size: contentLength,
      content_type: contentType
    } });
  } catch (error: any) {
    console.error('[azureBlobUpload] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
