import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";



// ─── PG fallback for Option-A campaign CallLogs (Postgres-only) ───
function makePgClient() {
  return new PgClient({
    hostname: Deno.env.get('AZURE_PG_HOST'),
    port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
    database: Deno.env.get('AZURE_PG_DATABASE'),
    user: Deno.env.get('AZURE_PG_USER'),
    password: Deno.env.get('AZURE_PG_PASSWORD'),
    tls: { enabled: true, enforce: true },
    connection: { attempts: 1 },
  });
}
async function pgGetCallLog(id) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const res = await pg.queryObject`
      SELECT id, client_id, direction, call_sid, callee_number, caller_id,
             duration, call_start_time, created_date, recording_url
      FROM call_logs WHERE id = ${id} LIMIT 1`;
    return res.rows[0] || null;
  } catch (_) { return null; } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgSetRecording(id, url) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    await pg.queryObject`UPDATE call_logs SET recording_url = ${url}, updated_at = now() WHERE id = ${id}`;
  } catch (_) {} finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}

// Fetches call recording URL from Smartflo CDR API and updates CallLog.
// Called after a call completes (from smartfloWebhook) with a delay to allow
// Smartflo to process and store the recording.

// In-memory token cache. Tracks the credentials it was minted with so a
// SMARTFLO_PASSWORD change auto-invalidates the cache on the very next call.
// Also includes a global lockout guard: after 3 consecutive failed logins,
// further logins are paused for 15 minutes to prevent the Smartflo account
// from being locked by repeated bad-password attempts.
let _cachedToken = null;
let _tokenExpiry = 0;
let _cachedCredHash = '';
let _consecutiveFailures = 0;
let _lockoutUntil = 0;

function credHash(email, password) {
  return `${email}::${(password || '').length}::${(password || '').slice(-3)}`;
}

async function getSmartfloToken(forceRefresh = false) {
  const sfEmail = Deno.env.get('SMARTFLO_EMAIL');
  const sfPassword = Deno.env.get('SMARTFLO_PASSWORD');
  if (!sfEmail || !sfPassword) {
    throw new Error('Missing SMARTFLO_EMAIL or SMARTFLO_PASSWORD');
  }
  const currentHash = credHash(sfEmail, sfPassword);

  // Return cached token only if valid AND credentials unchanged
  if (!forceRefresh && _cachedToken && Date.now() < _tokenExpiry && _cachedCredHash === currentHash) {
    return _cachedToken;
  }

  // Credential change → invalidate cache + reset failure counter (fresh password attempt)
  if (_cachedCredHash && _cachedCredHash !== currentHash) {
    console.log('[fetchCallRecording] 🔄 Credentials changed — invalidating cached token and resetting failure counter');
    _cachedToken = null; _tokenExpiry = 0; _consecutiveFailures = 0; _lockoutUntil = 0;
  }

  // Lockout guard: refuse to attempt login if we just had repeated failures
  if (Date.now() < _lockoutUntil) {
    const waitMin = Math.ceil((_lockoutUntil - Date.now()) / 60000);
    throw new Error(`Smartflo login paused for ${waitMin} more minute(s) due to repeated failures — preventing account lockout`);
  }

  const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: sfEmail, password: sfPassword })
  });
  const loginData = await loginResp.json();
  const token = loginData.access_token || loginData.token;
  if (!loginResp.ok || !token) {
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= 3) {
      _lockoutUntil = Date.now() + 15 * 60 * 1000;
      console.error(`[fetchCallRecording] 🚨 ${_consecutiveFailures} consecutive login failures — pausing for 15 min to prevent Smartflo lockout`);
    }
    throw new Error(`Smartflo login failed: ${loginData.message || JSON.stringify(loginData)}`);
  }
  _cachedToken = token;
  _tokenExpiry = Date.now() + 10 * 60 * 1000;
  _cachedCredHash = currentHash;
  _consecutiveFailures = 0;
  _lockoutUntil = 0;
  console.log('[fetchCallRecording] Smartflo login successful (token cached)');
  return token;
}

export default async function fetchCallRecording(c: any) {
  const req = c.req.raw || c.req;
  const appId = Deno.env.get('BASE44_APP_ID');
  /* const base44 = ... */;

  try {
    const { call_log_id } = await c.req.json();
    if (!call_log_id) {
      return c.json({ data: { error: 'call_log_id required' } }, 400);
    }

    let callLog = await base44.entities.CallLog.get(call_log_id).catch(() => null);
    let isPgOnly = false;
    if (!callLog) {
      callLog = await pgGetCallLog(call_log_id);
      isPgOnly = !!callLog;
    }
    if (!callLog) {
      return c.json({ data: { error: 'CallLog not found' } }, 404);
    }

    // Skip if recording already exists
    if (callLog.recording_url) {
      console.log(`[fetchCallRecording] ${call_log_id} already has recording: ${callLog.recording_url.substring(0, 80)}`);
      return c.json({ data: { success: true, already_exists: true } });
    }

    // Step 1: Get Smartflo JWT token (with caching to avoid rate-limiting)
    const token = await getSmartfloToken();

    // Step 2: Query CDR API to find the recording
    // Build date range: call date ± 1 day
    const callDate = new Date(callLog.call_start_time || callLog.created_date);
    const fromDate = new Date(callDate.getTime() - 24 * 3600 * 1000);
    const toDate = new Date(callDate.getTime() + 24 * 3600 * 1000);
    const fmt = (d) => d.toISOString().replace('T', ' ').substring(0, 19);

    // Strategy 1: Search by call_id if we have a Smartflo-format call_id
    // Smartflo call_ids look like "1715235734.129662"
    let recordingUrl = null;
    const callSid = callLog.call_sid || '';
    
    // Try searching by call_id first
    const params = new URLSearchParams({
      from_date: fmt(fromDate),
      to_date: fmt(toDate),
      limit: '50',
      page: '1'
    });

    // Try by callerid (the phone number called)
    const callerNumber = callLog.direction === 'outbound'
      ? (callLog.callee_number || '').replace(/[^0-9]/g, '')
      : (callLog.caller_id || '').replace(/[^0-9]/g, '');
    
    if (callerNumber) {
      params.set('callerid', callerNumber);
    }

    if (callLog.direction) {
      params.set('direction', callLog.direction);
    }

    console.log(`[fetchCallRecording] Querying CDR: callerid=${callerNumber}, direction=${callLog.direction}, from=${fmt(fromDate)}, to=${fmt(toDate)}`);

    const cdrResp = await fetch(`https://api-smartflo.tatateleservices.com/v1/call/records?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!cdrResp.ok) {
      const errText = await cdrResp.text();
      console.error(`[fetchCallRecording] CDR API error: ${cdrResp.status} ${errText}`);
      return c.json({ data: { error: `CDR API error: ${cdrResp.status}` } }, 500);
    }

    const cdrData = await cdrResp.json();
    const results = cdrData.results || [];
    console.log(`[fetchCallRecording] CDR returned ${results.length} records for callerid=${callerNumber}`);

    // Match the recording by multiple strategies
    const cleanCallSid = callSid.replace(/[^0-9.]/g, '');
    
    for (const record of results) {
      // Strategy A: Exact call_id match
      if (record.call_id && (record.call_id === callSid || record.call_id === cleanCallSid)) {
        if (record.recording_url) {
          recordingUrl = record.recording_url;
          console.log(`[fetchCallRecording] ✅ Matched by call_id: ${record.call_id}`);
          break;
        }
      }
    }

    // Strategy B: Match by phone number + approximate time + duration
    if (!recordingUrl && results.length > 0) {
      const callDuration = callLog.duration || 0;
      const callTime = callDate.getTime();

      for (const record of results) {
        if (!record.recording_url) continue;

        // Check phone number match
        const recordClientNum = (record.client_number || '').replace(/[^0-9]/g, '');
        const recordCallerIdNum = (record.caller_id_num || '').replace(/[^0-9]/g, '');
        const ourCallee = (callLog.callee_number || '').replace(/[^0-9]/g, '');
        const ourCaller = (callLog.caller_id || '').replace(/[^0-9]/g, '');

        const phoneMatch = 
          (ourCallee && (recordClientNum.slice(-10) === ourCallee.slice(-10) || recordCallerIdNum.slice(-10) === ourCallee.slice(-10))) ||
          (ourCaller && (recordClientNum.slice(-10) === ourCaller.slice(-10) || recordCallerIdNum.slice(-10) === ourCaller.slice(-10)));

        if (!phoneMatch) continue;

        // Check time proximity (within 5 minutes)
        const recordTime = new Date(`${record.date} ${record.time}`).getTime();
        const timeDiff = Math.abs(callTime - recordTime);
        if (timeDiff > 5 * 60 * 1000) continue;

        // Duration similarity check (within 30 seconds)
        if (callDuration > 0 && record.call_duration) {
          const durationDiff = Math.abs(callDuration - record.call_duration);
          if (durationDiff > 30) continue;
        }

        recordingUrl = record.recording_url;
        console.log(`[fetchCallRecording] ✅ Matched by phone+time+duration: ${record.call_id}, client_number=${record.client_number}`);
        break;
      }
    }

    // Strategy C: If still no match and only 1 result with recording, use it (likely our call)
    if (!recordingUrl && results.length === 1 && results[0].recording_url) {
      recordingUrl = results[0].recording_url;
      console.log(`[fetchCallRecording] ✅ Single CDR result with recording — using it: ${results[0].call_id}`);
    }

    if (!recordingUrl) {
      console.log(`[fetchCallRecording] ❌ No recording found for call ${call_log_id} (callSid=${callSid}, callee=${callerNumber})`);
      return c.json({ data: { success: false, message: 'No recording found in Smartflo CDR' } });
    }

    // Step 3: Update CallLog with recording URL (PG for Option-A campaign calls,
    // Base44 otherwise). For PG-only calls we also mirror to campaign_leads so the
    // CampaignDetail UI shows the recording.
    if (isPgOnly) {
      await pgSetRecording(call_log_id, recordingUrl);
    } else {
      await base44.entities.CallLog.update(call_log_id, { recording_url: recordingUrl });
    }
    console.log(`[fetchCallRecording] ✅ Recording saved to CallLog ${call_log_id}${isPgOnly ? ' (PG)' : ''}: ${recordingUrl.substring(0, 80)}`);

    // Step 4: Send Telegram notification with recording link (for personal accounts)
    if (callLog.client_id && callLog.client_id !== 'unknown') {
      try {
        const client = await base44.entities.Client.get(callLog.client_id);
        if (client && client.account_type === 'personal' && client.telegram_connected && client.telegram_chat_id && !client.dnd_enabled && client.owner_notification_channel === 'telegram') {
          const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
          if (tgToken) {
            const callerDisplay = callLog.direction === 'inbound' ? (callLog.caller_id || 'Unknown') : (callLog.callee_number || 'Unknown');
            const msg = `🎧 <b>Call Recording Available</b>\n\n📱 ${callLog.direction === 'inbound' ? 'From' : 'To'}: <b>${callerDisplay}</b>\n⏱️ Duration: ${callLog.duration ? Math.round(callLog.duration) + 's' : 'N/A'}\n\n🎧 <a href="${recordingUrl}">Play Recording</a>`;
            await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: client.telegram_chat_id, text: msg, parse_mode: 'HTML', disable_web_page_preview: false })
            });
          }
        }
      } catch (_) {}
    }

    return c.json({ data: { success: true, recording_url: recordingUrl } });
  } catch (error) {
    console.error('[fetchCallRecording] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};