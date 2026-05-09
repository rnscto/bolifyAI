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

async function hmacSha256(stringToSign, accountKey) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ─── Generate Service-SAS for a blob (read-only) ───
async function generateBlobSAS({ accountName, accountKey, container, blobName, expirySeconds = 3600 }) {
  const start = new Date(Date.now() - 60 * 1000).toISOString().slice(0, 19) + 'Z'; // 1 min skew
  const expiry = new Date(Date.now() + expirySeconds * 1000).toISOString().slice(0, 19) + 'Z';
  const permissions = 'r';
  const resource = 'b'; // blob
  const version = '2021-08-06';
  const canonicalizedResource = `/blob/${accountName}/${container}/${blobName}`;

  // String-to-sign for service-SAS v2021-08-06 (15 fields + empty trailing optionals)
  const stringToSign = [
    permissions,
    start,
    expiry,
    canonicalizedResource,
    '', // identifier
    '', // ip
    '', // protocol
    version,
    resource,
    '', // snapshot
    '', // encryptionScope
    '', // rscc — Cache-Control
    '', // rscd — Content-Disposition
    '', // rsce — Content-Encoding
    '', // rscl — Content-Language
    ''  // rsct — Content-Type
  ].join('\n');

  const signature = await hmacSha256(stringToSign, accountKey);
  const sas = new URLSearchParams({
    sp: permissions,
    st: start,
    se: expiry,
    sv: version,
    sr: resource,
    sig: signature
  });
  return sas.toString();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body;
    try { body = await req.json(); } catch { body = {}; }
    const { file_uri, expires_in } = body;
    if (!file_uri) return Response.json({ error: 'file_uri required' }, { status: 400 });

    const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    if (!cs) return Response.json({ error: 'Azure storage not configured' }, { status: 500 });

    const { accountName, accountKey, endpoint } = parseConnectionString(cs);

    // Parse the URI: e.g. https://acct.blob.core.windows.net/container/path/to/blob
    let parsed;
    try { parsed = new URL(file_uri); } catch { return Response.json({ error: 'Invalid file_uri' }, { status: 400 }); }
    const expectedHost = new URL(endpoint).host;
    if (parsed.host !== expectedHost) {
      return Response.json({ error: 'file_uri host mismatch' }, { status: 400 });
    }
    const pathParts = parsed.pathname.replace(/^\/+/, '').split('/');
    const container = pathParts.shift();
    const blobName = pathParts.join('/');
    if (!container || !blobName) return Response.json({ error: 'Invalid blob path' }, { status: 400 });

    const ttl = Math.max(60, Math.min(parseInt(expires_in) || 3600, 24 * 3600));
    const sas = await generateBlobSAS({ accountName, accountKey, container, blobName, expirySeconds: ttl });

    return Response.json({
      success: true,
      signed_url: `${file_uri}?${sas}`,
      expires_in: ttl
    });
  } catch (error) {
    console.error('[azureBlobSignedUrl] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});