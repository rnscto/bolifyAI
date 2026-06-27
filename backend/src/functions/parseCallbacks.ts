import { base44ORM as base44 } from "../db/orm.ts";

// parseCallbacks — FAST READ-ONLY version.
// Returns callbacks instantly from already-stored Lead / Activity / CallLog data.
// NO live LLM call on page load (that was the 2-minute bottleneck).
// AI re-extraction of callback timing is handled separately by the
// "Backfill Past Calls" button → backfillCallbackActivities → postCallActionExtractor,
// which writes results onto the Lead (next_followup_date) and Activity records that we read here.

export default async function parseCallbacks(c: any) {
  try {
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id } = await c.req.json().catch(() => ({}));

    // Fetch callback AND interested leads for this client
    const callbackLeads = await base44.entities.Lead.filter({ client_id, status: 'callback' }, '-created_at', 500);
    const interestedLeads = await base44.entities.Lead.filter({ client_id, status: 'interested' }, '-created_at', 500);
    const allCallbackLeads = [...callbackLeads, ...interestedLeads];

    // Fetch recent campaign leads with callback or interested outcome
    const campaignCallbacks = await base44.entities.CampaignLead.filter({ client_id, outcome: 'callback' }, '-created_at', 500);
    const campaignInterested = await base44.entities.CampaignLead.filter({ client_id, outcome: 'interested' }, '-created_at', 500);
    const campaignLeads = [...campaignCallbacks, ...campaignInterested];

    // Fetch scheduled followup activities (all types that need action)
    const followupActivities = await base44.entities.Activity.filter({ client_id, type: 'followup', status: 'scheduled' }, '-scheduled_date', 200);
    const callActivities = await base44.entities.Activity.filter({ client_id, type: 'call', status: 'scheduled' }, '-scheduled_date', 200);
    const activities = [...followupActivities, ...callActivities];

    // Also surface auto-scheduled callbacks where the Lead's status is NOT
    // 'callback'/'interested' but a call/followup activity is queued.
    const activityLeadIds = new Set(activities.map((a: any) => a.lead_id).filter(Boolean));
    const extraLeadIds = [...activityLeadIds].filter(id => !allCallbackLeads.find(l => l.id === id));
    if (extraLeadIds.length > 0) {
      const extraLeads = await Promise.all(
        extraLeadIds.map(id => base44.entities.Lead.get(id as string).catch(() => null))
      );
      for (const l of extraLeads) if (l) allCallbackLeads.push(l);
    }

    // Fetch recent completed call logs for this client (batch, lightweight indexing)
    const callLogs = await base44.entities.CallLog.filter({ client_id, status: 'completed' }, '-created_at', 200);
    const callLogByLead: Record<string, any> = {};
    for (const log of callLogs) {
      if (log.lead_id && !callLogByLead[log.lead_id]) {
        callLogByLead[log.lead_id] = log;
      }
    }

    const fmtIST = (d: any) => new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
    });

    const callbackItems = [];
    for (const lead of allCallbackLeads) {
      const matchingLog = callLogByLead[lead.id];
      const matchingCL = campaignLeads.find((cl: any) => cl.lead_id === lead.id);
      const matchingActivity = activities.find((a: any) => a.lead_id === lead.id);

      const summary = (matchingCL?.conversation_summary || matchingLog?.conversation_summary || '').split('\\n---')[0].trim();

      // Use the callback datetime that was already extracted at call time and
      // stored on the Lead / scheduled Activity — no LLM needed.
      const callbackDatetime = lead.next_followup_date || matchingActivity?.scheduled_date || null;

      const isAuto = !!(matchingActivity && ['call', 'followup'].includes(matchingActivity.type));

      callbackItems.push({
        lead_id: lead.id,
        lead_name: lead.name || 'Unknown',
        lead_phone: lead.phone,
        lead_email: lead.email || '',
        lead_company: lead.company || '',
        lead_score: lead.score || 0,
        qualification_tier: lead.qualification_tier || 'cold',
        sentiment: lead.sentiment || 'neutral',
        intent_signals: lead.intent_signals || [],
        summary,
        existing_followup_date: callbackDatetime,
        activity_id: matchingActivity?.id || null,
        activity_title: matchingActivity?.title || null,
        activity_type: matchingActivity?.type || null,
        auto_scheduled: isAuto,
        auto_scheduled_at: isAuto ? matchingActivity.scheduled_date : null,
        call_date: matchingLog?.call_start_time || matchingCL?.created_at || null,
        call_duration: matchingLog?.duration || matchingCL?.call_duration || 0,
        campaign_lead_id: matchingCL?.id || null,
        extracted: {
          callback_datetime: callbackDatetime,
          callback_description: callbackDatetime
            ? fmtIST(callbackDatetime)
            : 'No specific time — needs scheduling',
          reason: summary || lead.qualification_reason || 'Follow-up requested during call',
          specific_requests: lead.intent_signals || [],
          confidence: callbackDatetime ? 'high' : 'low',
          urgency: lead.qualification_tier === 'hot' ? 'high'
            : lead.qualification_tier === 'warm' ? 'medium' : 'low',
        },
      });
    }

    // Sort by urgency: high first, then by callback datetime
    const urgencyOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    callbackItems.sort((a, b) => {
      const uA = urgencyOrder[a.extracted?.urgency] ?? 2;
      const uB = urgencyOrder[b.extracted?.urgency] ?? 2;
      if (uA !== uB) return uA - uB;
      const dA = a.extracted?.callback_datetime ? new Date(a.extracted.callback_datetime).getTime() : Infinity;
      const dB = b.extracted?.callback_datetime ? new Date(b.extracted.callback_datetime).getTime() : Infinity;
      return dA - dB;
    });

    return c.json({
      data: {
        success: true,
        callbacks: callbackItems,
        total: callbackItems.length,
        parsed_at: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('[parseCallbacks] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
