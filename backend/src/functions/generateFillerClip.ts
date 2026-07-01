import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Admin utility: generate a "Hello" mu-law 8kHz clip via Azure Speech TTS
// and upload it to private storage. Returns the file_uri to plug into
// streamAudio / streamAudioGemini as the filler clip.
//
// Usage:
//   POST {} → returns { file_uri, bytes, ms }
//
// Optional payload:
//   { text: "Hello", voice: "en-IN-NeerjaNeural", lang: "en-IN" }

import { BlobServiceClient } from 'npm:@azure/storage-blob@12.17.0';

// ─── Azure Blob private upload (replaces Core.UploadPrivateFile) ───
async function uploadPrivateToAzure(buffer, blobName, contentType = 'application/octet-stream') {
  const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
  if (!conn || !container) throw new Error('Azure Blob not configured');
  const svc = BlobServiceClient.fromConnectionString(conn);
  const blob = svc.getContainerClient(container).getBlockBlobClient(blobName);
  await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
  return `azblob://${container}/${blobName}`;
}

export default async function generateFillerClip(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const text = body.text || 'Hello';
    const voice = body.voice || 'en-IN-NeerjaNeural';
    const lang = body.lang || 'en-IN';

    const speechKey = Deno.env.get('AZURE_SPEECH_KEY');
    const speechRegion = Deno.env.get('AZURE_SPEECH_REGION');
    if (!speechKey || !speechRegion) {
      return c.json({ data: { error: 'Azure Speech credentials not configured' } }, 500);
    }

    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'>${text}</voice></speak>`;

    const ttsRes = await fetch(`https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': speechKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'raw-8khz-8bit-mono-mulaw'
      },
      body: ssml
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      return c.json({ data: { error: `Azure TTS failed: ${ttsRes.status} ${errText}` } }, 500);
    }

    const mulawBuffer = await ttsRes.arrayBuffer();
    const mulawBytes = new Uint8Array(mulawBuffer);

    // Upload to Azure Blob private storage (replaces Core.UploadPrivateFile)
    const blobName = `filler/filler_hello_${Date.now()}.mulaw`;
    const file_uri = await uploadPrivateToAzure(mulawBytes, blobName, 'application/octet-stream');

    return c.json({ data: {
      success: true,
      file_uri,
      bytes: mulawBytes.length,
      ms: Math.round(mulawBytes.length / 8000 * 1000),
      text,
      voice
    } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};