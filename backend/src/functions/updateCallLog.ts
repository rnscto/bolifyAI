import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function updateCallLog(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Called from streamAudio (no user session) — use service role
    const appId = Deno.env.get('BASE44_APP_ID');
    /* const base44 = ... */;

    const body = await c.req.json();
    const { action } = body;

    // === GET AGENT CONFIG action: find call log + load agent + knowledge base ===
    if (action === 'get_agent_config') {
      const { call_sid, stream_sid } = body;
      console.log(`[updateCallLog] get_agent_config: call_sid=${call_sid}, stream_sid=${stream_sid}`);

      let callLog = null;

      // Strategy 1: Match by call_sid
      if (call_sid) {
        const logs = await base44.entities.CallLog.filter({ call_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      // Strategy 2: Match by stream_sid
      if (!callLog && stream_sid) {
        const logs = await base44.entities.CallLog.filter({ stream_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      // Strategy 3: Most recent ringing/initiated call
      if (!callLog) {
        const recentLogs = await base44.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 1);
        if (recentLogs.length > 0) callLog = recentLogs[0];
        if (!callLog) {
          const initiatedLogs = await base44.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 1);
          if (initiatedLogs.length > 0) callLog = initiatedLogs[0];
        }
      }

      if (!callLog) {
        return c.json({ data: { success: false, error: 'Call log not found' } });
      }

      // Update call log with stream_sid/call_sid
      const updateFields = {};
      if (stream_sid && !callLog.stream_sid) updateFields.stream_sid = stream_sid;
      if (call_sid && callLog.call_sid !== call_sid) updateFields.call_sid = call_sid;
      if (Object.keys(updateFields).length > 0) {
        await base44.entities.CallLog.update(callLog.id, updateFields);
      }

      // Fetch agent
      let agent = null;
      let knowledgeDocs = [];
      if (callLog.agent_id) {
        try {
          agent = await base44.entities.Agent.get(callLog.agent_id);
        } catch (e) {
          console.error(`[updateCallLog] Agent fetch failed: ${e.message}`);
        }

        // Fetch knowledge base
        if (agent && agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
          for (const kbId of agent.knowledge_base_ids) {
            try {
              const doc = await base44.entities.KnowledgeBase.get(kbId);
              if (doc && doc.content) knowledgeDocs.push({ title: doc.title, content: doc.content });
            } catch (e) {
              console.error(`[updateCallLog] KB doc ${kbId} failed: ${e.message}`);
            }
          }
        }
      }

      return c.json({ data: {
        success: true,
        callLogId: callLog.id,
        agent: agent ? {
          id: agent.id,
          name: agent.name,
          system_prompt: agent.system_prompt || '',
          persona: agent.persona || {},
        } : null,
        knowledgeDocs
      } });
    }

    // === SEND WHATSAPP MEDIA action (real-time, mid-call) ===
    // The AI calls this the moment a customer asks for a PDF/image on WhatsApp.
    // It matches an intent (e.g. "pricing", "brochure") to a MediaAsset in the
    // client's library and sends it instantly while the call is still live.
    if (action === 'send_whatsapp_media') {
      const { call_log_id, intent, media_asset_id, to } = body;
      if (!call_log_id) {
        return c.json({ data: { success: false, error: 'call_log_id required' } });
      }

      const callLog = await base44.entities.CallLog.get(call_log_id).catch(() => null);
      if (!callLog || !callLog.client_id) {
        return c.json({ data: { success: false, error: 'Call log / client not found' } });
      }

      // Resolve recipient: explicit `to`, else lead's phone, else the callee number.
      let recipient = to || null;
      if (!recipient && callLog.lead_id) {
        const lead = await base44.entities.Lead.get(callLog.lead_id).catch(() => null);
        recipient = lead?.phone || null;
      }
      if (!recipient) recipient = callLog.callee_number || null;
      if (!recipient) {
        return c.json({ data: { success: false, error: 'No recipient phone number available' } });
      }

      // Resolve which asset to send.
      let assetId = media_asset_id || null;
      if (!assetId) {
        const assets = await base44.entities.MediaAsset.filter({
          client_id: callLog.client_id, is_active: true
        }).catch(() => []);
        if (!assets || assets.length === 0) {
          return c.json({ data: { success: false, error: 'No media assets configured for this client' } });
        }
        const wanted = String(intent || '').toLowerCase().trim();
        // Best match: exact intent match → partial → first active asset as fallback.
        let match = assets.find(a => (a.intent || '').toLowerCase() === wanted);
        if (!match && wanted) {
          match = assets.find(a =>
            (a.intent || '').toLowerCase().includes(wanted) ||
            (a.name || '').toLowerCase().includes(wanted)
          );
        }
        if (!match) match = assets[0];
        assetId = match.id;
      }

      try {
        const resp = await base44.functions.invoke('sendWhatsAppMedia', {
          client_id: callLog.client_id,
          to: recipient,
          media_asset_id: assetId,
          lead_id: callLog.lead_id || null,
          call_log_id,
          outreach_type: 'lead_followup'
        });
        const result = resp?.data || {};
        if (result?.success) {
          console.log(`[updateCallLog] ✅ Sent WhatsApp media (asset=${assetId}) to ${recipient} mid-call`);
          return c.json({ data: { success: true, message_id: result.message_id, asset_name: result.asset_name } });
        }
        return c.json({ data: { success: false, error: result?.error || 'Send failed' } });
      } catch (e) {
        console.error(`[updateCallLog] send_whatsapp_media error: ${e.message}`);
        return c.json({ data: { success: false, error: e.message } });
      }
    }

    // === DEFAULT: Update call log ===
    const { call_log_id, status, transcript, duration, call_end_time, conversation_summary } = body;

    if (!call_log_id) {
      return c.json({ data: { error: 'call_log_id required' } }, 400);
    }

    const validStatuses = ['initiated', 'ringing', 'answered', 'completed', 'failed', 'no_answer'];
    if (status && !validStatuses.includes(status)) {
      return c.json({ data: { error: 'Invalid status' } }, 400);
    }

    // Get current call log to check previous status
    const currentCallLog = await base44.entities.CallLog.get(call_log_id);

    const updateData = {};
    if (status) updateData.status = status;
    if (transcript) updateData.transcript = transcript;
    if (duration !== undefined) updateData.duration = duration;
    if (call_end_time) updateData.call_end_time = call_end_time;
    if (conversation_summary) updateData.conversation_summary = conversation_summary;

    const mergedCallLog = { ...currentCallLog, ...updateData, id: call_log_id };

    // ═══════════════════════════════════════════════════════════════════
    // POSTGRES-PRIMARY WRITE
    // Azure Postgres is now the authoritative store for CallLog operational
    // state. We write it FIRST and AWAIT it, so the call's status/duration/
    // transcript are durably persisted independent of Base44's rate limit.
    // pgLeadSync upserts with COALESCE so a partial update never clobbers
    // existing transcript/summary text.
    // ═══════════════════════════════════════════════════════════════════
    try {
      await base44.functions.invoke('pgLeadSync', { call_log: mergedCallLog });
    } catch (e) {
      console.error('[updateCallLog] PG primary write failed:', e.message);
    }

    // Mirror to Base44 best-effort. A Base44 429 here can no longer break the
    // call flow because Postgres already holds the authoritative record. The
    // dashboard still reads from Base44 today, so we keep this in sync.
    base44.entities.CallLog.update(call_log_id, updateData)
      .catch((e) => console.error('[updateCallLog] Base44 mirror failed:', e.message));

    // ═══════════════════════════════════════════════════════════════════
    // ZERO-CREDIT CAMPAIGN PROGRESSION (replaces credit-gated entity automation)
    // When a call reaches a terminal status, we must advance the campaign lead
    // (mark complete + trigger the next call). Previously this relied on the
    // `campaignPostCall` ENTITY AUTOMATION firing on this CallLog update — but
    // entity automations consume integration credits and stall when the
    // workspace runs out. So we invoke campaignPostCall DIRECTLY here (a plain
    // function call costs zero integration credits). Fire-and-forget so we never
    // block the voice path; idempotency guards inside campaignPostCall prevent
    // double-processing if the Smartflo webhook also handles the same call.
    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    if (status && terminalStatuses.includes(status)) {
      base44.functions.invoke('campaignPostCall', {
        event: { type: 'update', entity_name: 'CallLog', entity_id: call_log_id },
        data: { ...currentCallLog, ...updateData, id: call_log_id },
        old_data: { ...currentCallLog, status: currentCallLog.status }
      }).catch((e) => console.error('[updateCallLog] campaignPostCall direct invoke failed:', e.message));
    }

    return c.json({ data: { success: true } });
  } catch (error) {
    console.error('updateCallLog error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};