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

  // Read token fresh from localStorage every time.
  // KEY: apiClient.js stores the JWT under 'bolifyai_token' (see getToken() in apiClient.js)
  const token =
    localStorage.getItem('bolifyai_token') ||
    localStorage.getItem('base44_access_token') ||
    localStorage.getItem('token') ||
    appParams.token ||
    '';

  // API_BASE_URL is already '/api' in production; do NOT prepend it again.
  // The function route is POST /api/functions/azureBlobUpload
  const url = `${window.location.origin}/api/functions/azureBlobUpload`;

  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(url, { method: 'POST', headers, body: formData });
  let result;
  try { result = await resp.json(); } catch { result = {}; }
  const payload = result?.data || result;
  if (!resp.ok || !payload?.success) {
    const errMsg = payload?.error || result?.error || `Upload failed (HTTP ${resp.status})`;
    console.error('[azureBlob] Upload error:', errMsg, result);
    throw new Error(errMsg);
  }
  return payload;
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