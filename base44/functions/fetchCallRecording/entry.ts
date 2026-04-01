import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Fetch call recording URL from Smartflo CDR API for a given call
// Can be called per-call or in bulk for recent calls missing recordings

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { call_log_id, bulk } = await req.json();

    const sfEmail = Deno.env.get('SMARTFLO_EMAIL');
    const sfPassword = Deno.env.get('SMARTFLO_PASSWORD');
    if (!sfEmail || !sfPassword) {
      return Response.json({ error: 'SMARTFLO_EMAIL/PASSWORD not configured' }, { status: 500 });
    }

    // Login to Smartflo
    const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email: sfEmail, password: sfPassword })
    });
    const loginData = await loginResp.json();
    const token = loginData.access_token || loginData.token;
    if (!token) {
      return Response.json({ error: 'Smartflo login failed', details: loginData }, { status: 500 });
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
        const cdrResp = await fetch(
          `https://api-smartflo.tatateleservices.com/v1/call/records?call_id=${encodeURIComponent(callSid)}&limit=1`,
          { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
        );
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