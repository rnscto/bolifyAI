// ─── Frontend helper for Azure Blob Storage ───
// Drop-in replacement for base44.integrations.Core.UploadFile.
//
// Usage:
//   import { uploadFile, uploadPrivateFile, getSignedUrl } from '@/lib/azureBlob';
//
//   const { file_url } = await uploadFile(file);                       // public
//   const { file_uri } = await uploadPrivateFile(file);                // private
//   const { signed_url } = await getSignedUrl(file_uri, 3600);         // read private blob
//
// Optional: pass a folder hint to organize blobs (e.g. 'kyc', 'logos', 'recordings').

import { base44 } from '@/api/base44Client';

async function invokeUpload({ file, visibility, folder }) {
  if (!file) throw new Error('file is required');
  const formData = new FormData();
  formData.append('file', file);
  formData.append('visibility', visibility);
  if (folder) formData.append('folder', folder);

  const resp = await base44.functions.invoke('azureBlobUpload', formData);
  // base44.functions.invoke returns an Axios-like response { data, status }
  if (!resp?.data?.success) {
    throw new Error(resp?.data?.error || 'Azure upload failed');
  }
  return resp.data;
}

// Public uploads (logos, social images, recordings) — returns { file_url }
export async function uploadFile(file, folder = '') {
  return invokeUpload({ file, visibility: 'public', folder });
}

// Private uploads (KYC, KB sources, sensitive docs) — returns { file_uri }
export async function uploadPrivateFile(file, folder = '') {
  return invokeUpload({ file, visibility: 'private', folder });
}

// Generate a time-limited read URL for a private blob.
export async function getSignedUrl(file_uri, expires_in = 3600) {
  if (!file_uri) throw new Error('file_uri is required');
  const resp = await base44.functions.invoke('azureBlobSignedUrl', { file_uri, expires_in });
  if (!resp?.data?.success) throw new Error(resp?.data?.error || 'Signed URL failed');
  return resp.data;
}