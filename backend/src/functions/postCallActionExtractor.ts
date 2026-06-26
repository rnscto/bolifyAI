import { client } from '../db/index.ts';
import { runActivityDispatcher } from '../cron/activityDispatcher.ts';
import { sendWebhookEvent } from '../integrations/webhooks.ts';

export async function postCallActionExtractorCore(callLogId: string) {
  try {
    if (!callLogId) {
      return { success: false, error: 'Missing call_log_id' };
    }

    const callLogRes = await (client as any).queryObject('SELECT * FROM calllog WHERE id = $1', [callLogId]);
    const callLog = callLogRes.rows[0];
    if (!callLog || !callLog.transcript) {
      return { success: false, skipped: true, reason: 'No transcript available' };
    }

    if (callLog.transcript.length < 100) {
      return { success: false, skipped: true, reason: 'Transcript too short' };
    }

    if (['no_answer', 'failed'].includes(callLog.status)) {
      return { success: false, skipped: true, reason: `Call status: ${callLog.status}` };
    }

    // Auto-resolve lead_id if missing
    if (!callLog.lead_id && callLog.client_id) {
      const phoneToSearch = callLog.direction === 'inbound' ? (callLog.caller_id || callLog.callee_number) : (callLog.callee_number || callLog.caller_id);
      if (phoneToSearch) {
        try {
          const cleanPhone = phoneToSearch.replace(/\D/g, '');
          const clientLeadsRes = await (client as any).queryObject('SELECT * FROM lead WHERE client_id = $1', [callLog.client_id]);
          const clientLeads = clientLeadsRes.rows;
          const matchedLead = clientLeads.find((l: any) => {
            const lPhone = (l.phone || '').replace(/\D/g, '');
            return lPhone && (lPhone === cleanPhone || lPhone.endsWith(cleanPhone.slice(-10)) || cleanPhone.endsWith(lPhone.slice(-10)));
          });
          if (matchedLead) {
            callLog.lead_id = matchedLead.id;
            await (client as any).queryObject('UPDATE calllog SET lead_id = $2 WHERE id = $1', [callLogId, matchedLead.id]);
          } else if (cleanPhone.length >= 10) {
            const newLeadRes = await (client as any).queryObject(`
              INSERT INTO lead (id, created_at, client_id, name, phone, status, source, last_call_date, notes)
              VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7)
              RETURNING id
            `, [
              callLog.client_id,
              callLog.direction === 'inbound' ? `Inbound caller ${cleanPhone.slice(-10)}` : `Lead ${cleanPhone.slice(-10)}`,
              cleanPhone,
              'contacted',
              callLog.direction === 'inbound' ? 'inbound_call' : 'auto_created',
              new Date().toISOString(),
              `Auto-created from call ${callLogId}`
            ]);
            callLog.lead_id = newLeadRes.rows[0].id;
            await (client as any).queryObject('UPDATE calllog SET lead_id = $2 WHERE id = $1', [callLogId, callLog.lead_id]);
          }
        } catch (e) {
          console.warn(`[ActionExtractor] Lead resolve/create failed:`, e);
        }
      }
    }

    const now = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const todayStr = istNow.toISOString().split('T')[0];
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istNow.getDay()];
    const istTimeStr = `${istNow.getUTCHours().toString().padStart(2,'0')}:${istNow.getUTCMinutes().toString().padStart(2,'0')} IST`;

    let baseUrlRaw = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const _oi = baseUrlRaw.indexOf('/openai/'); 
    if (_oi > 0) baseUrlRaw = baseUrlRaw.substring(0, _oi);
    
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

    const responsesUrl = `${baseUrlRaw}/openai/v1/responses`;
    const sysPrompt = `You are an expert at extracting actionable items from sales call transcripts. Today is ${dayOfWeek}, ${todayStr}, current time is ${istTimeStr} (IST timezone, UTC+5:30).

Extract action items from the conversation. Be thorough but ACCURATE — only create actions that are grounded in the actual conversation.

CRITICAL TIMEZONE RULE: All scheduled_date values MUST be in UTC (ISO 8601 format). Convert IST times to UTC by subtracting 5 hours 30 minutes.

Return JSON with this exact structure:
{
  "lead_notes": "string",
  "actions": [
    {
      "type": "call|email|whatsapp|calendar_invite|human_attention|demo|appointment|visit|meeting|task|followup",
      "title": "string",
      "description": "string",
      "scheduled_date": "ISO date-time string in UTC (converted from IST, or null if no specific time mentioned)",
      "scheduled_date_ist": "string",
      "priority": "low|medium|high",
      "confirmed": boolean,
      "trigger": "string"
    }
  ]
}

CONFIRMED vs UNCONFIRMED ACTIONS:
You MUST set "confirmed": true or false for EVERY action.
CONFIRMED: Customer explicitly agreed or requested.
UNCONFIRMED: AI agent proposed but customer did not confirm.
If unconfirmed, ALWAYS use type "task" or "followup" — NEVER "demo", "appointment", "meeting", or "visit". Priority should be "medium".

CALLBACK/RECALL SCHEDULING:
- "call me after 1 hour" → create "call" (confirmed: true)
- Agent proposes callback but no confirmation → create "task" (confirmed: false)

WHATSAPP & EMAIL:
- If the customer asked to send details via WhatsApp, create a "whatsapp" action (confirmed: true, priority: high).
- If the customer asked for details via email, create an "email" action.

HUMAN ATTENTION & CALENDAR:
- If the customer is very angry, asks to speak to a manager, or asks complex questions the AI couldn't answer, create a "human_attention" action (priority: high).
- If the customer agreed to a meeting/demo, create a "calendar_invite" action (confirmed: true).

IMPORTANT: Output ONLY valid JSON. Do not include markdown formatting or backticks.`;

    const userPrompt = `Call transcript:\n\n${callLog.transcript}\n\n${callLog.conversation_summary ? `AI Summary: ${callLog.conversation_summary.substring(0, 500)}` : ''}`;

    const extractionResponse = await fetch(
      responsesUrl,
      {
        method: 'POST',
        headers: { 'api-key': apiKey || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: deployment,
          instructions: sysPrompt,
          input: userPrompt,
          max_output_tokens: 1000,
          text: { format: { type: 'json_object' } }
        })
      }
    );

    if (!extractionResponse.ok) {
      return { success: false, error: 'AI extraction failed', status: extractionResponse.status };
    }

    const extractionData = await extractionResponse.json();
    
    let rawContent = extractionData.output_text || '';
    if (!rawContent && Array.isArray(extractionData.output)) {
      for (const item of extractionData.output) {
        const parts = item?.content || [];
        for (const p of parts) {
          if ((p.type === 'output_text' || p.type === 'text') && p.text) { rawContent += p.text; }
        }
      }
    }
    
    const cleanContent = rawContent.replace(/^```(?:json)?\n?/i, '').replace(/```$/i, '').trim();

    let extracted;
    try {
      extracted = JSON.parse(cleanContent);
    } catch (_) {
      return { success: false, error: 'AI response parse error' };
    }

    const results: any = { lead_notes_updated: false, activities_created: 0, skipped_duplicates: 0, details: [] };

    let isCampaignCall = false;
    if (callLog.id) {
      try {
        const clByCallLog = await (client as any).queryObject('SELECT * FROM campaignlead WHERE call_log_id = $1', [callLog.id]);
        if (clByCallLog.rows.length > 0) isCampaignCall = true;
      } catch (_) {}
    }
    if (!isCampaignCall && callLog.lead_id) {
      try {
        const campaignLeads = await (client as any).queryObject('SELECT * FROM campaignlead WHERE lead_id = $1', [callLog.lead_id]);
        isCampaignCall = campaignLeads.rows.some((cl: any) => ['pending', 'calling', 'processing', 'completed'].includes(cl.status));
      } catch (_) {}
    }
    const leadInActiveCampaign = isCampaignCall;

    let existingActivities: any[] = [];
    if (callLog.lead_id) {
      try {
        const actRes = await (client as any).queryObject("SELECT * FROM activity WHERE lead_id = $1 AND status = 'scheduled'", [callLog.lead_id]);
        existingActivities = actRes.rows;
      } catch (_) {}
    }

    if (callLog.lead_id && extracted.lead_notes && extracted.lead_notes.trim().length > 10) {
      try {
        const leadRes = await (client as any).queryObject('SELECT notes FROM lead WHERE id = $1', [callLog.lead_id]);
        const lead = leadRes.rows[0];
        if (lead) {
          const existingNotes = lead.notes || '';
          const dateTag = `[${todayStr}]`;
          const updatedNotes = existingNotes ? `${existingNotes}\n\n${dateTag} ${extracted.lead_notes}` : `${dateTag} ${extracted.lead_notes}`;
          await (client as any).queryObject('UPDATE lead SET notes = $2, updated_date = NOW() WHERE id = $1', [callLog.lead_id, updatedNotes]);
          results.lead_notes_updated = true;
        }
      } catch (e) {}
    }

    if (extracted.actions && Array.isArray(extracted.actions)) {
      for (const action of extracted.actions) {
        const isConfirmed = action.confirmed === true;
        let activityType = 'task';

        if (isConfirmed) {
          const typeMap: any = { 'call': 'call', 'followup': 'followup', 'email': 'email', 'whatsapp': 'whatsapp', 'calendar_invite': 'meeting', 'human_attention': 'task', 'demo': 'demo', 'appointment': 'appointment', 'visit': 'visit', 'meeting': 'meeting', 'task': 'task', 'booking': 'booking' };
          activityType = typeMap[action.type] || 'task';
          
          if (action.type === 'human_attention') {
            action.priority = 'high';
            action.title = `🚨 URGENT: ${action.title}`;
          }
        } else {
          const softTypes: any = { 'call': 'followup', 'email': 'task', 'whatsapp': 'task', 'followup': 'followup', 'calendar_invite': 'task', 'human_attention': 'task' };
          activityType = softTypes[action.type] || 'task';
          action.priority = 'medium';
        }

        if (leadInActiveCampaign && activityType === 'followup') {
          results.skipped_duplicates++;
          continue;
        }

        const hasSimilar = existingActivities.some(ea => ea.type === activityType && ea.title?.toLowerCase().includes(action.title?.toLowerCase().substring(0, 20) || ''));
        const recentSameType = existingActivities.find(ea => {
          if (ea.type !== activityType) return false;
          const created = new Date(ea.created_at || new Date());
          const hoursAgo = (now.getTime() - created.getTime()) / (1000 * 60 * 60);
          return hoursAgo < 4;
        });

        if (recentSameType && isConfirmed && action.scheduled_date) {
          const existingTime = new Date(recentSameType.scheduled_date).getTime();
          const newTime = new Date(action.scheduled_date).getTime();
          if (Math.abs(existingTime - newTime) > 5 * 60 * 1000) {
            try {
              await (client as any).queryObject(`
                UPDATE activity 
                SET scheduled_date = $2,
                    description = $3,
                    reminder_sent = false,
                    notes = $4,
                    updated_date = NOW()
                WHERE id = $1
              `, [
                recentSameType.id,
                action.scheduled_date,
                `✅ CONFIRMED by customer (RESCHEDULED)\n\n${action.description || ''}\n\n[Trigger: "${action.trigger || ''}"]`,
                `[Auto-extracted from call ${callLogId}] [confirmed, rescheduled]`
              ]);
              results.activities_created++;
              results.details.push({ type: activityType, title: action.title, scheduled: action.scheduled_date, rescheduled: true });
              continue;
            } catch (e) {}
          }
        }

        if (hasSimilar || recentSameType) {
          results.skipped_duplicates++;
          continue;
        }

        let scheduledDate = action.scheduled_date;
        if (!scheduledDate) {
          const defaultDate = new Date();
          let daysAdded = 0;
          while (daysAdded < 2) {
            defaultDate.setDate(defaultDate.getDate() + 1);
            const day = defaultDate.getDay();
            if (day !== 0 && day !== 6) daysAdded++;
          }
          defaultDate.setUTCHours(5, 30, 0, 0);
          scheduledDate = defaultDate.toISOString();
        }

        try {
          const confirmTag = isConfirmed ? '✅ CONFIRMED by customer' : '⏳ UNCONFIRMED — needs customer confirmation';
          const newActRes = await (client as any).queryObject(`
            INSERT INTO activity (id, created_at, client_id, lead_id, call_log_id, type, title, description, scheduled_date, status, priority, auto_created, assigned_to, notes)
            VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
          `, [
            callLog.client_id,
            callLog.lead_id || null,
            callLogId,
            activityType,
            action.title || `${activityType} follow-up`,
            `${confirmTag}\n\n${action.description || ''}\n\n[Trigger: "${action.trigger || 'Extracted from call'}"]`,
            scheduledDate,
            'scheduled',
            action.priority || 'medium',
            true,
            callLog.agent_id || null,
            `[Auto-extracted from call ${callLogId}] [${isConfirmed ? 'confirmed' : 'unconfirmed'}]`
          ]);

          existingActivities.push({ ...newActRes.rows[0], type: activityType, created_at: now.toISOString() });
          results.activities_created++;
          results.details.push({ type: activityType, title: action.title, scheduled: scheduledDate, priority: action.priority });
        } catch (e) {}
      }
    }

    if (callLog.lead_id && results.activities_created > 0) {
      const callActivities = (extracted.actions || []).filter((a: any) => ['call', 'followup'].includes(a.type) && a.scheduled_date);
      if (callActivities.length > 0) {
        const earliest = callActivities.map((a: any) => new Date(a.scheduled_date)).sort((a: any, b: any) => a.getTime() - b.getTime())[0];
        try {
          await (client as any).queryObject('UPDATE lead SET next_followup_date = $2, updated_date = NOW() WHERE id = $1', [callLog.lead_id, earliest.toISOString()]);
        } catch (_) {}
      }

      // Auto-enroll the lead into an email sequence if the AI extracted follow-ups
      try {
        const leadRes = await (client as any).queryObject('SELECT * FROM lead WHERE id = $1', [callLog.lead_id]);
        const leadForEnroll = leadRes.rows[0];
        if (leadForEnroll && leadForEnroll.qualification_tier && leadForEnroll.client_id) {
          const baseUrl = Deno.env.get('APP_BASE_URL_INTERNAL') || `http://localhost:${Deno.env.get('PORT') || '8000'}`;
          await fetch(`${baseUrl}/api/crm/auto-enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': Deno.env.get('CRON_API_KEY') || '' },
            body: JSON.stringify({
              lead_id: leadForEnroll.id,
              client_id: leadForEnroll.client_id,
              qualification_tier: leadForEnroll.qualification_tier
            })
          }).catch(() => {});
        }
      } catch (_) {}
    }

    if (results.activities_created > 0) {
      // Execute the dispatcher immediately in the background for instant gratification
      runActivityDispatcher().catch(e => console.error('[ActionExtractor] Immediate dispatcher error:', e));
    }

    // Fire webhook to Zapier/Make with the extracted data
    try {
      const webhookPayload = {
        call_log_id: callLogId,
        lead_id: callLog.lead_id,
        summary: callLog.conversation_summary,
        transcript: callLog.transcript,
        extracted_notes: extracted.lead_notes,
        activities_created: results.details,
      };
      sendWebhookEvent(callLog.client_id, "call.analyzed", webhookPayload).catch(e => console.error('[ActionExtractor] Webhook error:', e));
    } catch (e) {}

    return { success: true, ...results };

  } catch (error: any) {
    console.error('[ActionExtractor] Fatal error:', error);
    return { success: false, error: error.message };
  }
}

export default async function postCallActionExtractor(c: any) {
  try {
    const body = await c.req.json();
    let callLogId = body.call_log_id;
    if (body.event?.entity_name === 'CallLog' && body.event?.type === 'update') {
      const data = body.data;
      const oldData = body.old_data;
      if (!data?.transcript || (oldData?.transcript && oldData.transcript === data.transcript)) {
        return c.json({ data: { skipped: true, reason: 'No new transcript' } });
      }
      callLogId = body.event.entity_id;
    }
    const result = await postCallActionExtractorCore(callLogId);
    if (!result.success && !result.skipped) return c.json({ data: result }, 400);
    return c.json({ data: result });
  } catch (err: any) {
    return c.json({ data: { success: false, error: err.message } }, 500);
  }
}
