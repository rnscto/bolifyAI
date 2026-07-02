/**
 * ─── Azure Blob Storage Integration ──────────────────────────────────────────
 *
 * Production implementation using the Azure Storage REST API directly (no npm
 * dependency needed in Deno). Uses Shared Key authentication derived from the
 * AZURE_STORAGE_CONNECTION_STRING env var.
 *
 * Containers:
 *   Public  → AZURE_STORAGE_CONTAINER_PUBLIC  (default: "bolifyai-public")
 *   Private → AZURE_STORAGE_CONTAINER_PRIVATE (default: "bolifyai-private")
 */

import { hmac } from "https://deno.land/x/hmac@v2.0.1/mod.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseConnectionString(conn: string): { account: string; key: string } {
  const parts: Record<string, string> = {};
  for (const part of conn.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) {
      parts[part.substring(0, idx)] = part.substring(idx + 1);
    }
  }
  const account = parts["AccountName"];
  const key = parts["AccountKey"];
  if (!account || !key) throw new Error("[AzureBlob] Invalid connection string format");
  return { account, key };
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
}

/**
 * Build the HMAC-SHA256 Authorization header for Azure Blob REST API.
 * See: https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key
 */
async function buildAuthHeader(
  account: string,
  key: string,
  method: string,
  containerName: string,
  blobName: string,
  contentType: string,
  contentLength: number,
  date: string
): Promise<string> {
  const canonicalizedResource = `/${account}/${containerName}/${blobName}`;
  const canonicalizedHeaders = `x-ms-blob-type:BlockBlob\nx-ms-date:${date}\nx-ms-version:2020-04-08`;

  const stringToSign = [
    method.toUpperCase(),
    "",              // Content-Encoding
    "",              // Content-Language
    String(contentLength),
    "",              // Content-MD5
    contentType,
    "",              // Date (empty — using x-ms-date)
    "",              // If-Modified-Since
    "",              // If-Match
    "",              // If-None-Match
    "",              // If-Unmodified-Since
    "",              // Range
    canonicalizedHeaders,
    canonicalizedResource,
  ].join("\n");

  const keyBytes = fromBase64(key);
  const signatureBytes = await hmac("sha256", keyBytes, new TextEncoder().encode(stringToSign));
  const signature = toBase64(new Uint8Array(signatureBytes as ArrayBuffer));
  return `SharedKey ${account}:${signature}`;
}

// ── Main Upload Function ──────────────────────────────────────────────────────

/**
 * Upload a file to Azure Blob Storage.
 *
 * @param filename   - Blob name (path inside container, e.g. "kyc/file.pdf")
 * @param fileData   - Raw bytes
 * @param contentType - MIME type (default: "application/octet-stream")
 * @param visibility  - "public" | "private" (selects container)
 * @returns Public URL (for public blobs) or az:// URI (for private blobs)
 */
export async function uploadToBlobStorage(
  filename: string,
  fileData: Uint8Array,
  contentType = "application/octet-stream",
  visibility: "public" | "private" = "public"
): Promise<string> {
  const CONN = Deno.env.get("AZURE_STORAGE_CONNECTION_STRING");
  const PUBLIC_CONTAINER = Deno.env.get("AZURE_STORAGE_CONTAINER_PUBLIC") || "bolifyai-public";
  const PRIVATE_CONTAINER = Deno.env.get("AZURE_STORAGE_CONTAINER_PRIVATE") || "bolifyai-private";

  if (!CONN) {
    console.error("[AzureBlob] AZURE_STORAGE_CONNECTION_STRING is not set — upload aborted.");
    throw new Error("Azure Storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING.");
  }

  const { account, key } = parseConnectionString(CONN);
  const containerName = visibility === "private" ? PRIVATE_CONTAINER : PUBLIC_CONTAINER;
  const date = new Date().toUTCString();

  let authHeader: string;
  try {
    authHeader = await buildAuthHeader(
      account, key, "PUT", containerName, filename, contentType, fileData.byteLength, date
    );
  } catch (e: any) {
    console.error("[AzureBlob] Failed to build auth header:", e.message);
    throw new Error("Azure Storage auth error: " + e.message);
  }

  const url = `https://${account}.blob.core.windows.net/${containerName}/${filename}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "x-ms-date": date,
      "x-ms-version": "2020-04-08",
      "Content-Type": contentType,
      "Content-Length": String(fileData.byteLength),
      "Authorization": authHeader,
    },
    body: fileData,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error(`[AzureBlob] Upload failed (${response.status}):`, errText);
    throw new Error(`Azure Blob upload failed: HTTP ${response.status} — ${errText}`);
  }

  console.log(`[AzureBlob] Uploaded ${filename} to ${containerName} (${fileData.byteLength} bytes)`);

  // Return public URL or private az:// URI
  if (visibility === "private") {
    return `az://${containerName}/${filename}`;
  }
  return url;
}

/**
 * Generate a time-limited SAS (Shared Access Signature) URL for a private blob.
 *
 * @param containerName - Container name
 * @param blobName      - Blob path inside container
 * @param expiresInSecs - How long the URL is valid (default: 3600 s = 1 hour)
 */
export async function generateSasUrl(
  containerName: string,
  blobName: string,
  expiresInSecs = 3600
): Promise<string> {
  const CONN = Deno.env.get("AZURE_STORAGE_CONNECTION_STRING");
  if (!CONN) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");

  const { account, key } = parseConnectionString(CONN);

  const start = new Date();
  const expiry = new Date(start.getTime() + expiresInSecs * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

  const signedPermissions = "r";
  const signedStart = fmt(start);
  const signedExpiry = fmt(expiry);
  const canonicalizedResource = `/blob/${account}/${containerName}/${blobName}`;
  const signedVersion = "2020-04-08";

  const stringToSign = [
    signedPermissions,
    signedStart,
    signedExpiry,
    canonicalizedResource,
    "",              // signedIdentifier
    "",              // signedIP
    "https",         // signedProtocol
    signedVersion,
    "b",             // signedResource
    "",              // signedSnapshotTime
    "",              // rscc
    "",              // rscd
    "",              // rsce
    "",              // rscl
    "",              // rsct
  ].join("\n");

  const keyBytes = fromBase64(key);
  const sigBytes = await hmac("sha256", keyBytes, new TextEncoder().encode(stringToSign));
  const sig = encodeURIComponent(toBase64(new Uint8Array(sigBytes as ArrayBuffer)));

  return `https://${account}.blob.core.windows.net/${containerName}/${blobName}` +
    `?sv=${signedVersion}&ss=b&srt=o&sp=${signedPermissions}` +
    `&se=${encodeURIComponent(signedExpiry)}&st=${encodeURIComponent(signedStart)}` +
    `&spr=https&sig=${sig}`;
}
