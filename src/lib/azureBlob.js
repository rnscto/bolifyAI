// ─── Frontend helper for Azure Blob Storage ───
// Drop-in replacement for apiClient.integrations.Core.UploadFile.
//
// Usage:
//   import { uploadFile, uploadPrivateFile, getSignedUrl } from '@/lib/azureBlob';
//
//   const { file_url } = await uploadFile(file);                       // public
//   const { file_uri } = await uploadPrivateFile(file);                // private
//   const { signed_url } = await getSignedUrl(file_uri, 3600);         // read private blob
//
// Optional: pass a folder hint to organize blobs (e.g. 'kyc', 'logos', 'recordings').

import { apiClient } from '@/api/apiClient';
import { appParams } from '@/lib/app-params';

// Direct multipart upload — apiClient.functions.invoke serializes its body as JSON
// and would corrupt FormData, so we POST straight to the function endpoint.
async function invokeUpload({ file, visibility, folder }) {
  if (!file) throw new Error('file is required');
  const formData = new FormData();
  formData.append('file', file);
  formData.append('visibility', visibility);
  if (folder) formData.append('folder', folder);

  const { appId, token, appBaseUrl } = appParams;
  const baseUrl = (appBaseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/api/functions/azureBlobUpload`;

  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(url, { method: 'POST', headers, body: formData });
  let data;
  try { data = await resp.json(); } catch { data = {}; }
  if (!resp.ok || !data?.success) {
    throw new Error(data?.error || `Azure upload failed (${resp.status})`);
  }
  return data;
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
  const resp = await apiClient.functions.invoke('azureBlobSignedUrl', { file_uri, expires_in });
  if (!resp?.data?.success) throw new Error(resp?.data?.error || 'Signed URL failed');
  return resp.data;
}