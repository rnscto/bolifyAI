import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// azureBlobSignedUrl — Drop-in replacement for Core.CreateFileSignedUrl
//
// Generates a time-limited SAS URL for a private blob.
// Input: { file_uri: "azblob://<container>/<blobName>", expires_in: 300 }
// Output: { signed_url: "<https-url-with-sas>" }
// ═══════════════════════════════════════════════════════════════════


import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} from 'npm:@azure/storage-blob@12.17.0';

function parseConnectionString(conn) {
  const parts = Object.fromEntries(
    conn.split(';').filter(Boolean).map(kv => {
      const idx = kv.indexOf('=');
      return [kv.substring(0, idx), kv.substring(idx + 1)];
    })
  );
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
    endpointSuffix: parts.EndpointSuffix || 'core.windows.net'
  };
}

export function generateSasUrl(fileUri, expiresInSeconds = 300) {
  if (!fileUri || !fileUri.startsWith('azblob://')) {
    throw new Error('Invalid file_uri (expected azblob://<container>/<blob>)');
  }
  const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');

  const path = fileUri.replace('azblob://', '');
  const slash = path.indexOf('/');
  const container = path.substring(0, slash);
  const blobName = path.substring(slash + 1);

  const { accountName, accountKey, endpointSuffix } = parseConnectionString(conn);
  const cred = new StorageSharedKeyCredential(accountName, accountKey);

  const expiresOn = new Date(Date.now() + expiresInSeconds * 1000);
  const sas = generateBlobSASQueryParameters({
    containerName: container,
    blobName,
    permissions: BlobSASPermissions.parse('r'),
    expiresOn,
    protocol: 'https'
  }, cred).toString();

  return `https://${accountName}.blob.${endpointSuffix}/${container}/${blobName}?${sas}`;
}

export default async function azureBlobSignedUrl(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    // Allow service-role / inter-function calls (no end-user). Only enforce
    // auth when there's neither a service-role context nor an authenticated user.
    const user = c.get('jwtPayload').catch(() => null);
    const isServiceRole = !!base44.asServiceRole;
    if (!user && !isServiceRole) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { file_uri, expires_in } = await c.req.json();
    if (!file_uri) return c.json({ data: { error: 'file_uri required' } }, 400);

    // Only Azure Blob URIs are supported. Legacy Base44 storage URIs (mp/private/...) are no
    // longer signable since Core.CreateFileSignedUrl is integration-credit-blocked. Affected
    // agents must be re-uploaded via uploadKBToStorage.
    if (!file_uri.startsWith('azblob://')) {
      return c.json({ data: {
        error: 'Legacy Base44 storage URI not supported. Re-upload via uploadKBToStorage.',
        signed_url: ''
      } }, 400);
    }

    const signedUrl = generateSasUrl(file_uri, expires_in || 300);
    return c.json({ data: { signed_url: signedUrl } });
  } catch (error) {
    console.error('[azureBlobSignedUrl] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};