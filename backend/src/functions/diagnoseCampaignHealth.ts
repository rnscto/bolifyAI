import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// ─────────────────────────────────────────────────────────────────────────────
// ADMIN-ONLY DIAGNOSTIC — read-only. Does NOT change any data or place any calls.
//
// Pinpoints why campaign calls get stuck in "ringing" → "not answered":
//   1. Live Smartflo channel usage (are all concurrent channels busy?)
//   2. Stuck CallLogs (ringing/initiated/answered older than X min) per agent/DID
//   3. Per-DID active-call counts vs configured caps (DID saturation deadlock)
//   4. Campaign lead status breakdown
//
// Pass { campaign_id } to scope to one campaign, or omit for a platform-wide scan.
// ─────────────────────────────────────────────────────────────────────────────

export default async function diagnoseCampaignHealth(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const campaignId = body.campaign_id || null;
    const svc = base44.asServiceRole;
    const now = Date.now();

    const out = { generated_at: new Date().toISOString() };

    // ── 1. Live Smartflo channel usage ────────────────────────────────────────
    try {
      const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: Deno.env.get('SMARTFLO_EMAIL'),
          password: Deno.env.get('SMARTFLO_PASSWORD')
        })
      });
      const loginData = await loginRes.json();
      const token = loginData.access_token || loginData.token;
      if (token) {
        const liveRes = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });
        if (liveRes.ok) {
          const liveData = await liveRes.json();
          const liveCalls = Array.isArray(liveData) ? liveData : (liveData.data || []);
          out.smartflo_live_calls = {
            active_count: liveCalls.length,
            calls: liveCalls.slice(0, 20).map(c => ({
              call_id: c.call_id || c.uuid,
              status: c.status || c.call_status,
              did: c.did,
              customer: c.customer_number,
              duration: c.duration
            }))
          };
        } else {
          out.smartflo_live_calls = { error: `live_calls API ${liveRes.status}`, hint: 'Could not read live channel usage.' };
        }
      } else {
        out.smartflo_live_calls = { error: 'Smartflo login returned no token' };
      }
    } catch (e) {
      out.smartflo_live_calls = { error: e.message };
    }

    // ── 2. Stuck CallLogs (still in an active status for too long) ─────────────
    // Serialize (not Promise.all) with pacing so we never add to the 429 pressure
    // that is itself part of the problem we're diagnosing.
    const sleepA = (ms) => new Promise(r => setTimeout(r, ms));
    const STUCK_MIN = 3;
    const initiatedLogs = await svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 100); await sleepA(200);
    const ringingLogs = await svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 100); await sleepA(200);
    const answeredLogs = await svc.entities.CallLog.filter({ status: 'answered' }, '-created_date', 100); await sleepA(200);
    const ageMin = (l) => Math.round((now - new Date(l.created_date).getTime()) / 60000);
    const activeLogs = [...initiatedLogs, ...ringingLogs, ...answeredLogs];
    const stuck = activeLogs.filter(l => ageMin(l) >= STUCK_MIN);

    out.active_calllogs = {
      total_active: activeLogs.length,
      initiated: initiatedLogs.length,
      ringing: ringingLogs.length,
      answered: answeredLogs.length,
      stuck_over_3min: stuck.length,
      stuck_sample: stuck.slice(0, 15).map(l => ({
        id: l.id, status: l.status, age_min: ageMin(l),
        agent_id: l.agent_id, did: l.caller_id, callee: l.callee_number,
        has_transcript: !!(l.transcript && l.transcript.length > 30)
      }))
    };

    // ── 3. Per-DID active count vs cap (saturation deadlock detector) ──────────
    // Group active logs by caller_id (DID) and compare to the DID's max_concurrent_calls.
    const didActiveCount = {};
    for (const l of activeLogs) {
      if (!l.caller_id) continue;
      didActiveCount[l.caller_id] = (didActiveCount[l.caller_id] || 0) + 1;
    }
    const allDIDs = await svc.entities.DID.list('-created_date', 300);
    const didCapByNumber = {};
    for (const d of allDIDs) {
      const cleaned = (d.number || '').replace(/\D/g, '');
      didCapByNumber[d.number] = d.max_concurrent_calls || 1;
      didCapByNumber[cleaned] = d.max_concurrent_calls || 1;
    }
    out.did_saturation = Object.entries(didActiveCount).map(([did, active]) => {
      const cap = didCapByNumber[did] ?? didCapByNumber[(did || '').replace(/\D/g, '')] ?? 1;
      return { did, active_calls: active, cap, saturated: active >= cap };
    }).sort((a, b) => b.active_calls - a.active_calls);
    out.saturated_did_count = out.did_saturation.filter(d => d.saturated).length;

    // ── 4. Campaign lead breakdown (scoped or platform-wide) ──────────────────
    // Lightweight, rate-limit-safe: read first page (200) per active status only.
    // For deeper counts use the campaign page UI — this diagnostic favors safety under load.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const summarizeCampaign = async (camp) => {
      const countStatus = async (st) => {
        const page = await svc.entities.CampaignLead.filter(
          { campaign_id: camp.id, status: st }, 'created_date', 200
        );
        const n = page ? page.length : 0;
        return n >= 200 ? '200+' : n;
      };
      const calling = await countStatus('calling'); await sleep(150);
      const processing = await countStatus('processing'); await sleep(150);
      const pending = await countStatus('pending');
      return {
        id: camp.id, name: camp.name, status: camp.status,
        agent_id: camp.agent_id, max_concurrent: camp.max_concurrent_calls || 5,
        leads: { pending, calling, processing }
      };
    };

    if (campaignId) {
      const camp = await svc.entities.Campaign.get(campaignId).catch(() => null);
      out.campaign = camp ? await summarizeCampaign(camp) : { error: 'Campaign not found' };
    } else {
      const running = await svc.entities.Campaign.filter({ status: 'running' });
      out.running_campaigns = [];
      for (const camp of running.slice(0, 5)) {
        out.running_campaigns.push(await summarizeCampaign(camp));
        await sleep(200);
      }
    }

    // ── 5. Verdict ────────────────────────────────────────────────────────────
    const verdicts = [];
    if (out.saturated_did_count > 0) {
      verdicts.push(`${out.saturated_did_count} DID(s) are at concurrency cap — new calls are being blocked (saturation deadlock). Stuck "ringing" logs inflate this.`);
    }
    if (out.active_calllogs.stuck_over_3min > 5) {
      verdicts.push(`${out.active_calllogs.stuck_over_3min} CallLogs stuck in active status >3min — the AI voice stream likely never connected (channel busy or wrong Dynamic-endpoint/stream URL in Smartflo).`);
    }
    if (out.smartflo_live_calls?.active_count !== undefined && out.active_calllogs.total_active > out.smartflo_live_calls.active_count + 3) {
      verdicts.push(`Your DB shows ${out.active_calllogs.total_active} active calls but Smartflo only has ${out.smartflo_live_calls.active_count} live — the extra DB logs are PHANTOM (stuck), confirming missing terminal webhooks/streams.`);
    }
    if (verdicts.length === 0) verdicts.push('No obvious saturation/stuck-call deadlock detected at this moment.');
    out.verdict = verdicts;

    return c.json({ data: { success: true, ...out } });
  } catch (error) {
    console.error('[diagnoseCampaignHealth] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};