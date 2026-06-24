import { base44ORM as base44 } from "../db/orm.ts";
import { getSmartfloToken } from "../services/smartflo.ts";

export default async function fetchCallRecording(c: any) {
  try {
    const { call_log_id, bulk, force_refresh } = await c.req.json().catch(() => ({}));

    let token;
    try {
      token = await getSmartfloToken(force_refresh === true);
    } catch (e: any) {
      return c.json({ data: { error: e.message } }, 500);
    }

    let callLogs: any[] = [];
    if (call_log_id) {
      const log = await base44.entities.CallLog.get(call_log_id);
      if (log) callLogs = [log];
    } else if (bulk) {
      const recent = await base44.entities.CallLog.filter({ status: 'completed' }, '-created_date', 50);
      callLogs = recent.filter((l: any) => !l.recording_url && l.call_sid);
    }

    if (callLogs.length === 0) {
      return c.json({ data: { success: true, message: 'No calls to process', updated: 0 } });
    }

    console.log(`[fetchCallRecording] Processing ${callLogs.length} call(s)`);
    let updated = 0;
    const results: any[] = [];

    for (const log of callLogs) {
      try {
        const callSid = log.call_sid;
        if (!callSid) continue;

        let recordingUrl = null;

        let cdrResp = await fetch(
          `https://api-smartflo.tatateleservices.com/v1/call/records?call_id=${encodeURIComponent(callSid)}&limit=1`,
          { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
        );
        
        if (cdrResp.status === 401 || cdrResp.status === 403) {
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
          }
        }

        if (!recordingUrl) {
          const detailResp = await fetch(
            `https://api-smartflo.tatateleservices.com/v1/call/${encodeURIComponent(callSid)}`,
            { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
          );
          if (detailResp.ok) {
            const detail = await detailResp.json();
            const callDetail = detail.data || detail;
            recordingUrl = callDetail.recording_url || callDetail.recording || callDetail.record_url || null;
          }
        }

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
              const match = searchRecords.find((r: any) => {
                const rDur = parseInt(r.duration || r.billsec || 0);
                return Math.abs(rDur - (log.duration || 0)) <= 5;
              }) || searchRecords[0];
              if (match) {
                recordingUrl = match.recording_url || match.recording || match.record_url || null;
              }
            }
          }
        }

        if (recordingUrl) {
          await base44.entities.CallLog.update(log.id, { recording_url: recordingUrl });
          updated++;
          results.push({ id: log.id, call_sid: callSid, recording_url: recordingUrl });
        } else {
          results.push({ id: log.id, call_sid: callSid, recording_url: null, note: 'No recording found' });
        }
      } catch (err: any) {
        results.push({ id: log.id, error: err.message });
      }
    }

    return c.json({ data: { success: true, updated, total: callLogs.length, results } });
  } catch (error: any) {
    console.error('[fetchCallRecording] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }
}
