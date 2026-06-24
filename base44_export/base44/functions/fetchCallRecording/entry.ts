import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.31';

// Fetch call recording URL from Smartflo CDR API for a given call
// Can be called per-call or in bulk for recent calls missing recordings

// ─── Cross-isolate token cache via SmartfloAuth entity ───
// Smartflo locks the account if you log in too frequently from multiple functions.
// This shared DB-backed cache ensures all functions reuse one token.
const TOKEN_TTL_MS = 50 * 60 * 1000;
let _localCache = { token: null, expiresAt: 0 };

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  // 1. Fast path — in-memory cache
  if (!forceRefresh && _localCache.token && _localCache.expiresAt > now) {
    return _localCache.token;
  }
  // 2. Check shared DB cache
  const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
  const records = await svc.entities.SmartfloAuth.list('-updated_date', 1).catch(() => []);
  const rec = records[0] || null;
  if (rec) {
    // Check if rate-limited
    if (rec.blocked_until && new Date(rec.blocked_until).getTime() > now) {
      const waitSec = Math.ceil((new Date(rec.blocked_until).getTime() - now) / 1000);
      throw new Error(`Smartflo login is rate-limited (shared) — retry in ${waitSec}s`);
    }
    // Use cached token if still valid
    if (!forceRefresh && rec.token && rec.expires_at && new Date(rec.expires_at).getTime() > now + 60000) {
      _localCache = { token: rec.token, expiresAt: new Date(rec.expires_at).getTime() };
      return rec.token;
    }
  }
  // 3. Login (with single-isolate mutex to prevent concurrent logins from same isolate)
  if (_loginPromise) return _loginPromise;
  _loginPromise = (async () => {
    try {
      const email = Deno.env.get('SMARTFLO_EMAIL');
      const password = Deno.env.get('SMARTFLO_PASSWORD');
      if (!email || !password) throw new Error('SMARTFLO_EMAIL/PASSWORD not configured');
      const r = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const d = await r.json().catch(() => ({}));
      const token = d.access_token || d.token;
      if (!token) {
        if (r.status === 429 || d.retry_after) {
          let cooldownMs = 10 * 60 * 1000;
          if (d.retry_after) {
            const ra = new Date(d.retry_after.replace(' ', 'T') + '+05:30').getTime();
            if (!isNaN(ra) && ra > Date.now()) cooldownMs = ra - Date.now() + 5000;
          }
          const blockedUntilIso = new Date(Date.now() + cooldownMs).toISOString();
          // Persist block to shared DB so other functions know
          if (rec) await svc.entities.SmartfloAuth.update(rec.id, { blocked_until: blockedUntilIso, last_429_retry_after: d.retry_after || '' }).catch(() => {});
          else await svc.entities.SmartfloAuth.create({ blocked_until: blockedUntilIso, last_429_retry_after: d.retry_after || '' }).catch(() => {});
          throw new Error(`Smartflo rate-limited (retry_after=${d.retry_after || 'n/a'})`);
        }
        throw new Error('Smartflo login failed: ' + JSON.stringify(d));
      }
      console.log('[fetchCallRecording] Login successful (shared token cached)');
      const expiresAtIso = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
      _localCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
      // Save to shared DB cache
      if (rec) await svc.entities.SmartfloAuth.update(rec.id, { token, expires_at: expiresAtIso, blocked_until: '' }).catch(() => {});
      else await svc.entities.SmartfloAuth.create({ token, expires_at: expiresAtIso }).catch(() => {});
      return token;
    } finally { _loginPromise = null; }
  })();
  return _loginPromise;
}
let _loginPromise = null;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { call_log_id, bulk, force_refresh } = await req.json();

    // Force-flush cached token if requested (e.g. after Smartflo password change)
    if (force_refresh) {
      _localCache = { token: null, expiresAt: 0 };
      console.log('[fetchCallRecording] Force-refresh requested — token cache cleared');
    }

    // Get cached Smartflo bearer token (single login shared across calls)
    let token;
    try {
      token = await getSmartfloToken(force_refresh === true);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }

    // Determine which calls to process — use service role for entity access
    let callLogs = [];
    if (call_log_id) {
      const log = await base44.asServiceRole.entities.CallLog.get(call_log_id);
      if (log) callLogs = [log];
    } else if (bulk) {
      // Fetch recent completed calls without recording_url
      const recent = await base44.asServiceRole.entities.CallLog.filter({ status: 'completed' }, '-created_date', 50);
      callLogs = recent.filter(l => !l.recording_url && l.call_sid);
    }

    if (callLogs.length === 0) {
      return Response.json({ success: true, message: 'No calls to process', updated: 0 });
    }

    console.log(`[fetchCallRecording] Processing ${callLogs.length} call(s)`);
    let updated = 0;
    const results = [];

    for (const log of callLogs) {
      try {
        // Try fetching CDR by call_id from Smartflo
        const callSid = log.call_sid;
        if (!callSid) continue;

        // Smartflo CDR API - try multiple endpoints
        let recordingUrl = null;

        // Method 1: CDR search by call_id
        let cdrResp = await fetch(
          `https://api-smartflo.tatateleservices.com/v1/call/records?call_id=${encodeURIComponent(callSid)}&limit=1`,
          { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
        );
        // Auto-refresh token on 401/403 (stale token after password change)
        if (cdrResp.status === 401 || cdrResp.status === 403) {
          console.log(`[fetchCallRecording] Token rejected (${cdrResp.status}) — refreshing and retrying`);
          _localCache = { token: null, expiresAt: 0 };
          token = await getSmartfloToken(true);
          cdrResp = await fetch(
            `https://api-smartflo.tatateleservices.com/v1/call/records?call_id=${encodeURIComponent(callSid)}&limit=1`,
            { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
          );
        }
        if (cdrResp.ok) {
          const cdrData = await cdrResp.json();
          const records = cdrData.data || cdrData.records || cdrData.results || (Array.isArray(cdrData) ? cdrData : []);
          if (records.length > 0) {
            recordingUrl = records[0].recording_url || records[0].recording || records[0].record_url || records[0].recordingUrl || null;
            console.log(`[fetchCallRecording] CDR for ${callSid}: found=${!!recordingUrl}`);
          }
        } else {
          console.log(`[fetchCallRecording] CDR API ${cdrResp.status} for ${callSid}`);
        }

        // Method 2: Try call detail endpoint directly
        if (!recordingUrl) {
          const detailResp = await fetch(
            `https://api-smartflo.tatateleservices.com/v1/call/${encodeURIComponent(callSid)}`,
            { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
          );
          if (detailResp.ok) {
            const detail = await detailResp.json();
            const callDetail = detail.data || detail;
            recordingUrl = callDetail.recording_url || callDetail.recording || callDetail.record_url || null;
            console.log(`[fetchCallRecording] Detail for ${callSid}: found=${!!recordingUrl}`);
          }
        }

        // Method 3: Try CDR search by phone number + date range
        if (!recordingUrl && log.callee_number) {
          const cleanPhone = log.callee_number.replace(/[^0-9]/g, '');
          const startDate = log.call_start_time ? new Date(log.call_start_time).toISOString().split('T')[0] : '';
          if (startDate && cleanPhone) {
            const searchResp = await fetch(
              `https://api-smartflo.tatateleservices.com/v1/call/records?phone=${encodeURIComponent(cleanPhone)}&start_date=${startDate}&limit=5`,
              { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
            );
            if (searchResp.ok) {
              const searchData = await searchResp.json();
              const searchRecords = searchData.data || searchData.records || searchData.results || [];
              // Find matching record by duration or timestamp proximity
              const match = searchRecords.find(r => {
                const rDur = parseInt(r.duration || r.billsec || 0);
                return Math.abs(rDur - (log.duration || 0)) <= 5;
              }) || searchRecords[0];
              if (match) {
                recordingUrl = match.recording_url || match.recording || match.record_url || null;
                console.log(`[fetchCallRecording] Phone search for ${cleanPhone}: found=${!!recordingUrl}`);
              }
            }
          }
        }

        if (recordingUrl) {
          await base44.asServiceRole.entities.CallLog.update(log.id, { recording_url: recordingUrl });
          updated++;
          results.push({ id: log.id, call_sid: callSid, recording_url: recordingUrl });
          console.log(`[fetchCallRecording] ✅ Updated ${log.id}: ${recordingUrl.substring(0, 80)}`);
        } else {
          results.push({ id: log.id, call_sid: callSid, recording_url: null, note: 'No recording found' });
        }
      } catch (err) {
        console.error(`[fetchCallRecording] Error for ${log.id}: ${err.message}`);
        results.push({ id: log.id, error: err.message });
      }
    }

    return Response.json({ success: true, updated, total: callLogs.length, results });
  } catch (error) {
    console.error('[fetchCallRecording] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});