import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// fetchTwilioRecording — Downloads the Twilio call recording, uploads to
// Azure Blob (public container), and updates CallLog.recording_url with
// a long-lived SAS URL. Parallel to functions/fetchCallRecording (Smartflo).
//
// Twilio recordings are fetched via:
//   GET https://api.twilio.com/2010-04-01/Accounts/{SID}/Recordings.json?CallSid=...
// or directly from RecordingUrl already saved by the webhook (preferred).
// ═══════════════════════════════════════════════════════════════════════


import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from 'npm:@azure/storage-blob@12.17.0';

function parseConnString(conn) {
  const parts = Object.fromEntries(conn.split(';').filter(Boolean).map((p) => {
    const idx = p.indexOf('=');
    return [p.slice(0, idx), p.slice(idx + 1)];
  }));
  return { accountName: parts.AccountName, accountKey: parts.AccountKey };
}

export default async function fetchTwilioRecording(c: any) {
  const req = c.req.raw || c.req;
  try {
    const { call_log_id } = await c.req.json();
    if (!call_log_id) return c.json({ data: { error: 'call_log_id required' } }, 400);

    /* const base44 = ... */;
    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) return c.json({ data: { error: 'CallLog not found' } }, 404);
    if (callLog.provider !== 'twilio') {
      return c.json({ data: { skipped: 'not_twilio_call' } });
    }

    const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    if (!twilioSid || !twilioToken) {
      return c.json({ data: { error: 'Twilio credentials not configured' } }, 500);
    }
    const auth = btoa(`${twilioSid}:${twilioToken}`);

    // Resolve recording URL — prefer the one already saved by webhook
    let recordingUrl = callLog.recording_url;
    if (!recordingUrl || !recordingUrl.includes('twilio.com')) {
      // Fall back to API lookup
      const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Recordings.json?CallSid=${encodeURIComponent(callLog.call_sid)}`;
      const r = await fetch(listUrl, { headers: { 'Authorization': `Basic ${auth}` } });
      if (!r.ok) {
        return c.json({ data: { error: `Twilio recording lookup failed: ${r.status}` } }, 500);
      }
      const data = await r.json();
      const rec = (data.recordings || [])[0];
      if (!rec) return c.json({ data: { skipped: 'no_recording_available' } });
      recordingUrl = `https://api.twilio.com${rec.uri.replace(/\.json$/, '.mp3')}`;
    }

    // Already on Azure Blob? skip.
    if (recordingUrl && !recordingUrl.includes('twilio.com')) {
      return c.json({ data: { success: true, recording_url: recordingUrl, skipped: 'already_on_blob' } });
    }

    // Download recording with Twilio auth
    const dl = await fetch(recordingUrl, { headers: { 'Authorization': `Basic ${auth}` } });
    if (!dl.ok) return c.json({ data: { error: `Recording download failed: ${dl.status}` } }, 500);
    const audioBytes = new Uint8Array(await dl.arrayBuffer());

    // Upload to Azure Blob (public)
    const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    const containerName = Deno.env.get('AZURE_STORAGE_CONTAINER_PUBLIC');
    if (!conn || !containerName) {
      return c.json({ data: { error: 'Azure Blob not configured' } }, 500);
    }
    const svc = BlobServiceClient.fromConnectionString(conn);
    const container = svc.getContainerClient(containerName);
    const blobName = `recordings/twilio/${callLog.id}-${Date.now()}.mp3`;
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadData(audioBytes, { blobHTTPHeaders: { blobContentType: 'audio/mpeg' } });

    // SAS URL (10 years)
    let publicUrl = blob.url;
    try {
      const { accountName, accountKey } = parseConnString(conn);
      if (accountName && accountKey) {
        const cred = new StorageSharedKeyCredential(accountName, accountKey);
        const expiresOn = new Date();
        expiresOn.setFullYear(expiresOn.getFullYear() + 10);
        const sas = generateBlobSASQueryParameters({
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse('r'),
          startsOn: new Date(Date.now() - 60_000),
          expiresOn,
          protocol: 'https'
        }, cred).toString();
        publicUrl = `${blob.url}?${sas}`;
      }
    } catch (e) {
      console.warn('[fetchTwilioRecording] SAS gen failed:', e.message);
    }

    await base44.entities.CallLog.update(callLog.id, { recording_url: publicUrl });
    console.log(`[fetchTwilioRecording] ✅ Saved recording for ${callLog.id}: ${audioBytes.length} bytes`);
    return c.json({ data: { success: true, recording_url: publicUrl, bytes: audioBytes.length } });
  } catch (error) {
    console.error('[fetchTwilioRecording] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};