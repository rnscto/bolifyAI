import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// azureBlobUpload — Drop-in replacement for Core.UploadFile / UploadPrivateFile
//
// Frontend usage (replaces base44.integrations.Core.UploadFile):
//   const formData = new FormData();
//   formData.append('file', file);
//   formData.append('visibility', 'public'); // or 'private'
//   const res = await base44.functions.invoke('azureBlobUpload', formData);
//   // res.data.file_url   (public blobs — direct https URL)
//   // res.data.file_uri   (private blobs — opaque ref, use azureBlobSignedUrl)
//
// Backend usage:
//   const res = await base44.asServiceRole.functions.invoke('azureBlobUpload', { ... })
//   — but for backend uploads from a Deno function, use uploadBlobFromBuffer() directly.
// ═══════════════════════════════════════════════════════════════════


import { BlobServiceClient } from 'npm:@azure/storage-blob@12.17.0';

function getBlobService() {
  const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');
  return BlobServiceClient.fromConnectionString(conn);
}

function safeName(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 120);
}

// Build the opaque file_uri token for private blobs.
// Format: "azblob://<container>/<blobName>"
// Public blobs use the direct HTTPS URL — no token needed.
function buildPrivateUri(container, blobName) {
  return `azblob://${container}/${blobName}`;
}

export default async function azureBlobUpload(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload').catch(() => null);
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const contentType = req.headers.get('content-type') || '';

    let fileBuffer; // Uint8Array
    let fileName;
    let fileType;
    let visibility;
    let folder;

    if (contentType.includes('multipart/form-data')) {
      // Native multipart path
      const form = await req.formData();
      const file = form.get('file');
      visibility = (form.get('visibility') || 'public').toString();
      folder = (form.get('folder') || '').toString();
      if (!file || typeof file === 'string') {
        return c.json({ data: { error: 'file field required' } }, 400);
      }
      fileBuffer = new Uint8Array(await file.arrayBuffer());
      fileName = file.name || 'file';
      fileType = file.type || 'application/octet-stream';
    } else {
      // JSON path (used by frontend via base44.functions.invoke which serializes to JSON)
      // Body: { file_base64, file_name, file_type, visibility, folder }
      const body = await c.req.json().catch(() => ({}));
      const { file_base64, file_name, file_type } = body || {};
      visibility = (body.visibility || 'public').toString();
      folder = (body.folder || '').toString();
      if (!file_base64) {
        return c.json({ data: { error: 'file_base64 field required' } }, 400);
      }
      // Strip data URL prefix if present
      const b64 = file_base64.includes(',') ? file_base64.split(',')[1] : file_base64;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      fileBuffer = bytes;
      fileName = file_name || 'file';
      fileType = file_type || 'application/octet-stream';
    }

    const containerName = visibility === 'private'
      ? Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE')
      : Deno.env.get('AZURE_STORAGE_CONTAINER_PUBLIC');
    if (!containerName) {
      return c.json({ data: { error: 'Container not configured' } }, 500);
    }

    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 10);
    const cleanName = safeName(fileName);
    const blobName = folder
      ? `${folder.replace(/[^a-zA-Z0-9/_-]/g, '')}/${ts}_${rand}_${cleanName}`
      : `${ts}_${rand}_${cleanName}`;

    const blobService = getBlobService();
    const container = blobService.getContainerClient(containerName);
    const blockBlob = container.getBlockBlobClient(blobName);

    await blockBlob.uploadData(fileBuffer, {
      blobHTTPHeaders: { blobContentType: fileType }
    });

    if (visibility === 'private') {
      return c.json({ data: {
        success: true,
        file_uri: buildPrivateUri(containerName, blobName),
        size: fileBuffer.length
      } });
    }

    // Public — return direct HTTPS URL
    return c.json({ data: {
      success: true,
      file_url: blockBlob.url,
      size: fileBuffer.length
    } });
  } catch (error) {
    console.error('[azureBlobUpload] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};