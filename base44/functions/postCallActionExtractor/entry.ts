import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Post-Call AI Action Extractor - v2: Force redeploy
// Analyzes call transcripts to extract specific action items:
//  - Lead notes (key concerns, preferences, requirements mentioned)
//  - Scheduled follow-up calls with specific dates/times
//  - Email requests ("send me the pricing", "email me details")
//  - Demo/appointment/visit bookings
//  - Meeting scheduling
// Then auto-creates Activity records + updates Lead notes accordingly.

Deno.serve(async (req) => {
  try {
    // Entity automation or fire-and-forget — use service role
    const base44_client = createClientFromRequest(req);
    const svc = base44_client.asServiceRole;

    // Accept either direct invocation or entity automation payload
    const body = await req.json();
    let callLogId = body.call_log_id;

    // Entity automation format
    if (body.event?.entity_name === 'CallLog' && body.event?.type === 'update') {
      const data = body.data;
      const oldData = body.old_data;
      // Only trigger when transcript is newly populated
      if (!data?.transcript || (oldData?.transcript && oldData.transcript === data.transcript)) {
        return Response.json({ skipped: true, reason: 'No new transcript' });
      }
      callLogId = body.event.entity_id;
    }

    if (!callLogId) {
      return Response.json({ error: 'Missing call_log_id' }, { status: 400 });
    }

    const callLog = await svc.entities.CallLog.get(callLogId);
    if (!callLog || !callLog.transcript) {
      return Response.json({ skipped: true, reason: 'No transcript available' });
    }

    // Skip very short transcripts (likely failed/dropped calls or voicemail)
    if (callLog.transcript.length < 100) {
      return Response.json({ skipped: true, reason: 'Transcript too short (likely voicemail/no-answer)' });
    }

    // Skip non-answer/voicemail calls based on call status
    if (['no_answer', 'failed'].includes(callLog.status)) {
      return Response.json({ skipped: true, reason: `Call status: ${callLog.status} — no real conversation` });
    }

    // ── AUTO-RESOLVE lead_id if missing ──
    // For inbound calls or calls where lead wasn't linked, try to find lead by phone number.
    // If no match exists, create a new Lead so callback activities have a phone to dial.
    if (!callLog.lead_id && callLog.client_id) {
      const phoneToSearch = callLog.direction === 'inbound' ? (callLog.caller_id || callLog.callee_number) : (callLog.callee_number || callLog.caller_id);
      if (phoneToSearch) {
        try {
          const cleanPhone = phoneToSearch.replace(/\D/g, '');
          const clientLeads = await svc.entities.Lead.filter({ client_id: callLog.client_id });
          const matchedLead = clientLeads.find(l => {
            const lPhone = (l.phone || '').replace(/\D/g, '');
            return lPhone && (lPhone === cleanPhone || lPhone.endsWith(cleanPhone.slice(-10)) || cleanPhone.endsWith(lPhone.slice(-10)));
          });
          if (matchedLead) {
            callLog.lead_id = matchedLead.id;
            await svc.entities.CallLog.update(callLogId, { lead_id: matchedLead.id });
            console.log(`[ActionExtractor] Auto-linked lead ${matchedLead.name} (${matchedLead.id}) to call ${callLogId} via phone match`);
          } else if (cleanPhone.length >= 10) {
            // No matching lead — create a new one so callback activities are actionable
            const newLead = await svc.entities.Lead.create({
              client_id: callLog.client_id,
              name: callLog.direction === 'inbound' ? `Inbound caller ${cleanPhone.slice(-10)}` : `Lead ${cleanPhone.slice(-10)}`,
              phone: cleanPhone,
              status: 'contacted',
              source: callLog.direction === 'inbound' ? 'inbound_call' : 'auto_created',
              last_call_date: new Date().toISOString(),
              notes: `Auto-created from call ${callLogId} (${callLog.direction || 'unknown'} direction)`
            });
            callLog.lead_id = newLead.id;
            await svc.entities.CallLog.update(callLogId, { lead_id: newLead.id });
            console.log(`[ActionExtractor] Auto-created lead ${newLead.id} (phone=${cleanPhone}) for call ${callLogId}`);
          }
        } catch (e) {
          console.warn(`[ActionExtractor] Lead resolve/create failed: ${e.message}`);
        }
      }
    }

    // Get current date/time for AI context — IST = UTC + 5:30
    const now = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const todayStr = istNow.toISOString().split('T')[0];
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istNow.getDay()];
    const istTimeStr = `${istNow.getUTCHours().toString().padStart(2,'0')}:${istNow.getUTCMinutes().toString().padStart(2,'0')} IST`;

    // Use Azure OpenAI to extract action items
    let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
    // Normalize: strip /openai/... or /api/projects/... from AI Foundry endpoints
    const oIdx = baseUrl.indexOf('/openai/'); if (oIdx > 0) baseUrl = baseUrl.substring(0, oIdx);
    const pIdx = baseUrl.indexOf('/api/projects'); if (pIdx > 0) baseUrl = baseUrl.substring(0, pIdx);

    const extractionResponse = await fetch(
      `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
      {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `You are an expert at extracting actionable items from sales call transcripts. Today is ${dayOfWeek}, ${todayStr}, current time is ${istTimeStr} (IST timezone, UTC+5:30).

Extract action items from the conversation. Be thorough but ACCURATE — only create actions that are grounded in the actual conversation.

CRITICAL TIMEZONE RULE: All scheduled_date values MUST be in UTC (ISO 8601 format). Convert IST times to UTC by subtracting 5 hours 30 minutes.
Examples: 10:00 AM IST = 04:30 UTC, 12:00 PM IST = 06:30 UTC, 2:00 PM IST = 08:30 UTC, 6:00 PM IST = 12:30 UTC.

DATE CONTEXT RULE: The transcript may have happened TODAY or on a PREVIOUS day. When the transcript references "kal" (tomorrow), "aaj" (today), "next Monday" etc., compute dates RELATIVE TO THE CALL DATE, not relative to today. If the call summary mentions a date like [2026-03-22], use THAT as the base date for relative calculations.

Return JSON with this exact structure:
{
  "lead_notes": "string — Key information about the lead: concerns, preferences, requirements, budget, timeline, decision criteria, personal details mentioned. Be detailed. Empty string if nothing notable.",
  "actions": [
    {
      "type": "call|email|demo|appointment|visit|meeting|task|followup",
      "title": "Brief title for the activity",
      "description": "Details about what needs to happen",
      "scheduled_date": "ISO date-time string in UTC (converted from IST, or null if no specific time mentioned)",
      "scheduled_date_ist": "Human-readable IST time for reference (e.g. '17 March 2026 at 12:00 PM IST')",
      "priority": "low|medium|high",
      "confirmed": true/false,
      "trigger": "Exact quote or paraphrase from transcript that triggered this action"
    }
  ]
}

═══ CRITICAL: CONFIRMED vs UNCONFIRMED ACTIONS ═══

You MUST set "confirmed": true or false for EVERY action:

CONFIRMED (confirmed: true) — The CUSTOMER explicitly agreed, requested, or confirmed:
- Customer says "yes, schedule the demo" / "haan, demo kar do" / "ok, call me at 3"
- Customer asks for something: "send me details" / "mujhe email karo"
- Customer agrees to a proposed time: "haan, 11 baje theek hai"

UNCONFIRMED (confirmed: false) — The AI AGENT proposed something but the customer did NOT confirm:
- Agent says "shall we schedule a demo?" but customer didn't respond or gave a vague answer
- Agent proposes "kal 11 baje ya 4 baje?" but customer says nothing / gives no clear yes
- Agent leaves a voicemail with proposed times — customer hasn't responded at all
- Agent suggests sending details but customer didn't acknowledge
- One-sided calls where only the agent spoke (voicemail, no pickup, etc.)

ACTION TYPE RULES FOR UNCONFIRMED:
- If unconfirmed, ALWAYS use type "task" or "followup" — NEVER "demo", "appointment", "meeting", or "visit"
- Title should reflect the unconfirmed nature: "Follow up to confirm demo time with [name]" NOT "Schedule demo"
- Priority should be "medium" for unconfirmed (not "high")
- Description should say what was proposed and that confirmation is needed

═══ ONE-SIDED CALLS / VOICEMAIL ═══
If the transcript shows ONLY the AI agent speaking with NO customer responses:
- This is a voicemail or dropped call
- Do NOT create demo/appointment/meeting activities
- Create a "followup" or "task" to re-contact the lead
- Title: "Follow up after voicemail to [name]" or "Re-attempt call to [name]"
- Priority: "medium"

═══ CALLBACK/RECALL SCHEDULING ═══
- "call me after 1 hour / 2 hours / 30 minutes" → create "call" activity (confirmed: true)
- "call me tomorrow" → create "call" at next business day 10:00 AM IST (confirmed: true)
- "call me at 3 PM / call at 3 baje" → create "call" at 3:00 PM IST (confirmed: true)
- "baad mein call karo / abhi busy hu" → create "call" in 2 hours from now (confirmed: true)
- Agent proposes callback time but customer doesn't confirm → create "task" to confirm callback (confirmed: false)

═══ EMAIL/SEND DETAILS ═══
- Customer explicitly asks: "send me details / pricing" → create "email" IMMEDIATELY, high priority (confirmed: true)
- Agent offers to send but customer doesn't acknowledge → create "task" to follow up (confirmed: false)

═══ DEMO/MEETING/VISIT ═══
- Customer confirms: "haan, demo schedule karo" → create "demo" (confirmed: true)
- Agent proposes demo, customer is vague or silent → create "task": "Follow up to confirm demo with [name]" (confirmed: false)

═══ OTHER RULES ═══
- For lead_notes: capture company size, budget range, pain points, competitor mentions, decision makers, timeline
- Return empty actions array ONLY if customer clearly said "not interested" or "do not call"
- For confirmed actions: "high" priority for demos/appointments/send-details, "medium" for callbacks
- For unconfirmed actions: always "medium" priority
- IMPORTANT: Extract EVERY actionable request — do NOT skip email/detail requests`
            },
            {
              role: 'user',
              content: `Call transcript:\n\n${callLog.transcript}\n\n${callLog.conversation_summary ? `AI Summary: ${callLog.conversation_summary.substring(0, 500)}` : ''}`
            }
          ],
          max_completion_tokens: 1000,
          response_format: { type: "json_object" }
        })
      }
    );

    if (!extractionResponse.ok) {
      const errText = await extractionResponse.text();
      console.error('[ActionExtractor] AI extraction failed:', extractionResponse.status, errText);
      console.error('[ActionExtractor] URL used:', `${baseUrl}/openai/deployments/${deployment}/chat/completions`);
      return Response.json({ error: 'AI extraction failed', status: extractionResponse.status, detail: errText.substring(0, 500) }, { status: 500 });
    }

    const extractionData = await extractionResponse.json();
    const rawContent = extractionData.choices?.[0]?.message?.content || '{}';

    let extracted;
    try {
      extracted = JSON.parse(rawContent);
    } catch (_) {
      console.error('[ActionExtractor] Failed to parse AI response');
      return Response.json({ error: 'AI response parse error' }, { status: 500 });
    }

    const results = { lead_notes_updated: false, activities_created: 0, skipped_duplicates: 0, details: [] };

    // Campaign calls: still extract actions (emails, callbacks, specific requests)
    // Only skip generic tier-based activities that campaignPostCall already creates
    let isCampaignCall = false;
    if (callLog.id) {
      try {
        const clByCallLog = await svc.entities.CampaignLead.filter({ call_log_id: callLog.id });
        if (clByCallLog.length > 0) isCampaignCall = true;
      } catch (_) {}
    }
    if (!isCampaignCall && callLog.lead_id) {
      try {
        const campaignLeads = await svc.entities.CampaignLead.filter({ lead_id: callLog.lead_id });
        isCampaignCall = campaignLeads.some(cl => ['pending', 'calling', 'processing', 'completed'].includes(cl.status));
      } catch (_) {}
    }
    if (isCampaignCall) {
      console.log(`[ActionExtractor] Campaign call detected — will extract specific actions (emails, timed callbacks) but skip generic followups`);
    }
    const leadInActiveCampaign = isCampaignCall;

    // ── DEDUP: Load existing pending activities for this lead to avoid duplicates ──
    let existingActivities = [];
    if (callLog.lead_id) {
      try {
        existingActivities = await svc.entities.Activity.filter({
          lead_id: callLog.lead_id, status: 'scheduled'
        });
      } catch (_) {}
    }

    // 1. Update lead notes with extracted information
    if (callLog.lead_id && extracted.lead_notes && extracted.lead_notes.trim().length > 10) {
      try {
        const lead = await svc.entities.Lead.get(callLog.lead_id);
        const existingNotes = lead.notes || '';
        const dateTag = `[${todayStr}]`;
        
        // Append new notes (don't overwrite — preserve history)
        const updatedNotes = existingNotes
          ? `${existingNotes}\n\n${dateTag} ${extracted.lead_notes}`
          : `${dateTag} ${extracted.lead_notes}`;

        await svc.entities.Lead.update(callLog.lead_id, { notes: updatedNotes });
        results.lead_notes_updated = true;
        console.log(`[ActionExtractor] Lead ${callLog.lead_id} notes updated`);
      } catch (e) {
        console.error(`[ActionExtractor] Lead notes update failed: ${e.message}`);
      }
    }

    // 2. Create Activity records for each extracted action
    if (extracted.actions && Array.isArray(extracted.actions)) {
      for (const action of extracted.actions) {
        const isConfirmed = action.confirmed === true;

        // Map action type to Activity type enum
        // For UNCONFIRMED actions: force type to "task" or "followup" — never create
        // demo/appointment/meeting/visit for unconfirmed proposals
        let activityType;
        if (isConfirmed) {
          const typeMap = {
            'call': 'call', 'followup': 'followup', 'email': 'email',
            'demo': 'demo', 'appointment': 'appointment', 'visit': 'visit',
            'meeting': 'meeting', 'task': 'task', 'booking': 'booking'
          };
          activityType = typeMap[action.type] || 'task';
        } else {
          // Unconfirmed — downgrade to task/followup
          const softTypes = { 'call': 'followup', 'email': 'task', 'followup': 'followup' };
          activityType = softTypes[action.type] || 'task';
          // Also override priority for unconfirmed
          action.priority = 'medium';
          console.log(`[ActionExtractor] Unconfirmed action "${action.title}" → downgraded to ${activityType}`);
        }

        // ── For campaign calls: skip only generic "followup" activities (campaignPostCall creates those)
        // BUT allow specific actions: email, demo, call (with specific time), task, visit, meeting
        if (leadInActiveCampaign && activityType === 'followup') {
          console.log(`[ActionExtractor] Skipped generic followup "${action.title}" for campaign call — handled by campaignPostCall`);
          results.skipped_duplicates++;
          continue;
        }

        // ── DEDUP CHECK 2: Skip if similar activity already exists for this lead ──
        // BUT: if customer explicitly requested a new specific time (action has scheduled_date AND
        // confirmed=true), update the existing activity instead of skipping. This handles cases like
        // "actually call me at 2:15 instead of 1:30" — the new time should override the old one.
        const hasSimilar = existingActivities.some(ea =>
          ea.type === activityType &&
          ea.title?.toLowerCase().includes(action.title?.toLowerCase().substring(0, 20) || '')
        );
        const recentSameType = existingActivities.find(ea => {
          if (ea.type !== activityType) return false;
          const created = new Date(ea.created_date);
          const hoursAgo = (now - created) / (1000 * 60 * 60);
          return hoursAgo < 4;
        });

        // If customer confirmed a new specific time and a recent same-type activity exists,
        // UPDATE that activity's scheduled_date instead of creating a duplicate.
        if (recentSameType && isConfirmed && action.scheduled_date) {
          const existingTime = new Date(recentSameType.scheduled_date).getTime();
          const newTime = new Date(action.scheduled_date).getTime();
          if (Math.abs(existingTime - newTime) > 5 * 60 * 1000) {
            try {
              await svc.entities.Activity.update(recentSameType.id, {
                scheduled_date: action.scheduled_date,
                description: `✅ CONFIRMED by customer (RESCHEDULED)\n\n${action.description || ''}\n\n[Trigger: "${action.trigger || ''}"]`,
                reminder_sent: false,
                notes: `[Auto-extracted from call ${callLogId}] [confirmed, rescheduled]`
              });
              console.log(`[ActionExtractor] Rescheduled ${activityType} "${recentSameType.title}" from ${recentSameType.scheduled_date} → ${action.scheduled_date}`);
              results.activities_created++;
              results.details.push({ type: activityType, title: action.title, scheduled: action.scheduled_date, rescheduled: true });
              continue;
            } catch (e) {
              console.error(`[ActionExtractor] Reschedule failed: ${e.message}`);
            }
          }
        }

        if (hasSimilar || recentSameType) {
          console.log(`[ActionExtractor] Skipped duplicate ${activityType} "${action.title}": similar activity exists`);
          results.skipped_duplicates++;
          continue;
        }

        // Determine scheduled date (all dates should be in UTC already from LLM)
        let scheduledDate = action.scheduled_date;
        if (!scheduledDate) {
          // Default: 2 business days from now at 11:00 AM IST = 05:30 UTC
          const defaultDate = new Date();
          let daysAdded = 0;
          while (daysAdded < 2) {
            defaultDate.setDate(defaultDate.getDate() + 1);
            const day = defaultDate.getDay();
            if (day !== 0 && day !== 6) daysAdded++;
          }
          defaultDate.setUTCHours(5, 30, 0, 0); // 11:00 AM IST = 05:30 UTC
          scheduledDate = defaultDate.toISOString();
        }

        try {
          const confirmTag = isConfirmed ? '✅ CONFIRMED by customer' : '⏳ UNCONFIRMED — needs customer confirmation';
          const newActivity = await svc.entities.Activity.create({
            client_id: callLog.client_id,
            lead_id: callLog.lead_id || null,
            call_log_id: callLogId,
            type: activityType,
            title: action.title || `${activityType} follow-up`,
            description: `${confirmTag}\n\n${action.description || ''}\n\n[Trigger: "${action.trigger || 'Extracted from call'}"]`,
            scheduled_date: scheduledDate,
            status: 'scheduled',
            priority: action.priority || 'medium',
            auto_created: true,
            assigned_to: callLog.agent_id || '',
            notes: `[Auto-extracted from call ${callLogId}] [${isConfirmed ? 'confirmed' : 'unconfirmed'}]`
          });

          // Add to existing list so next iteration can dedup against it
          existingActivities.push({ ...newActivity, type: activityType, created_date: now.toISOString() });

          results.activities_created++;
          results.details.push({
            type: activityType, title: action.title,
            scheduled: scheduledDate, priority: action.priority
          });

          console.log(`[ActionExtractor] Created ${activityType}: "${action.title}" scheduled ${scheduledDate}`);
        } catch (e) {
          console.error(`[ActionExtractor] Activity creation failed: ${e.message}`);
        }
      }
    }

    // 3. Update lead's next_followup_date if we created any call/followup activities
    if (callLog.lead_id && results.activities_created > 0) {
      const callActivities = (extracted.actions || []).filter(a => 
        ['call', 'followup'].includes(a.type) && a.scheduled_date
      );
      if (callActivities.length > 0) {
        // Set next_followup_date to the earliest scheduled call
        const earliest = callActivities
          .map(a => new Date(a.scheduled_date))
          .sort((a, b) => a - b)[0];
        
        try {
          await svc.entities.Lead.update(callLog.lead_id, {
            next_followup_date: earliest.toISOString()
          });
          console.log(`[ActionExtractor] Lead next_followup_date set to ${earliest.toISOString()}`);
        } catch (_) {}
      }
    }

    console.log(`[ActionExtractor] Done for call ${callLogId}: notes=${results.lead_notes_updated}, activities=${results.activities_created}`);
    return Response.json({ success: true, ...results });

  } catch (error) {
    console.error('[ActionExtractor] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});