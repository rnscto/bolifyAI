import { Context } from "hono";

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

async function hmacSha256(stringToSign: string, accountKey: string) {
  const keyBytes = Uint8Array.from(atob(accountKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ─── Generate Service-SAS for a blob (read-only) ───
async function generateBlobSAS({ accountName, accountKey, container, blobName, expirySeconds = 3600 }: any) {
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

export default async function (c: Context) {
  try {
    let body;
    try { body = await c.req.json(); } catch { body = {}; }
    const { file_uri, expires_in } = body;
    if (!file_uri) return c.json({ data: { success: false, error: 'file_uri required' } });

    const cs = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    if (!cs) return c.json({ data: { success: false, error: 'Azure storage not configured' } });

    const { accountName, accountKey, endpoint } = parseConnectionString(cs);

    // Parse the URI: e.g. https://acct.blob.core.windows.net/container/path/to/blob
    let parsed;
    try { parsed = new URL(file_uri); } catch { return c.json({ data: { success: false, error: 'Invalid file_uri' } }); }
    const expectedHost = new URL(endpoint).host;
    if (parsed.host !== expectedHost) {
      return c.json({ data: { success: false, error: 'file_uri host mismatch' } });
    }
    const pathParts = parsed.pathname.replace(/^\/+/, '').split('/');
    const container = pathParts.shift();
    const blobName = pathParts.join('/');
    if (!container || !blobName) return c.json({ data: { success: false, error: 'Invalid blob path' } });

    const ttl = Math.max(60, Math.min(parseInt(expires_in) || 3600, 24 * 3600));
    const sas = await generateBlobSAS({ accountName, accountKey, container, blobName, expirySeconds: ttl });

    return c.json({
      data: {
        success: true,
        signed_url: `${file_uri}?${sas}`,
        expires_in: ttl
      }
    });
  } catch (error: any) {
    console.error('[azureBlobSignedUrl] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
