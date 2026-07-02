import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";


// Post-Call AI Action Extractor - v2: Force redeploy
// Analyzes call transcripts to extract specific action items:
//  - Lead notes (key concerns, preferences, requirements mentioned)
//  - Scheduled follow-up calls with specific dates/times
//  - Email requests ("send me the pricing", "email me details")
//  - Demo/appointment/visit bookings
//  - Meeting scheduling
// Then auto-creates Activity records + updates Lead notes accordingly.

export default async function postCallActionExtractor(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Entity automation — no user session, use service role from request
    const client = base44;;
    const svc = client.asServiceRole;

    // Accept either direct invocation or entity automation payload
    const body = await c.req.json();
    let callLogId = body.call_log_id;

    // Entity automation format
    if (body.event?.entity_name === 'CallLog' && body.event?.type === 'update') {
      const data = body.data;
      const oldData = body.old_data;
      // Only trigger when transcript is newly populated
      if (!data?.transcript || (oldData?.transcript && oldData.transcript === data.transcript)) {
        return c.json({ data: { skipped: true, reason: 'No new transcript' } });
      }
      callLogId = body.event.entity_id;
    }

    if (!callLogId) {
      return c.json({ data: { error: 'Missing call_log_id' } }, 400);
    }

    // Accept a pre-resolved CallLog (passed by postCallOrchestrator for PG-only
    // dials whose CallLog lives in Postgres and would 404 on a Base44 .get).
    let callLog = body.call_log || null;
    if (!callLog) {
      callLog = await svc.entities.CallLog.get(callLogId).catch(() => null);
    }
    if (!callLog || !callLog.transcript) {
      return c.json({ data: { skipped: true, reason: 'No transcript available' } });
    }

    // Skip very short transcripts (likely failed/dropped calls or voicemail)
    if (callLog.transcript.length < 100) {
      return c.json({ data: { skipped: true, reason: 'Transcript too short (likely voicemail/no-answer)' } });
    }

    // ── AUTO-PROCESS SCREENING CALLS ──
    // If this CallLog is associated with a screening call, trigger processScreeningResult
    if (callLog.agent_config_cache?.is_screening_call) {
      const screeningCallId = callLog.agent_config_cache.screening_call_id;
      console.log(`[ActionExtractor] 🎯 Screening call detected (${screeningCallId}), triggering processScreeningResult`);
      svc.functions.invoke('processScreeningResult', { screening_call_id: screeningCallId, call_log_id: callLogId }).catch(e => {
        console.error(`[ActionExtractor] processScreeningResult failed: ${e.message}`);
      });
      // Still continue with normal action extraction below — screening calls may also contain actionable items
    }

    // Skip non-answer/voicemail calls based on call status
    if (['no_answer', 'failed'].includes(callLog.status)) {
      return c.json({ data: { skipped: true, reason: `Call status: ${callLog.status} — no real conversation` } });
    }

    // ── AUTO-RESOLVE lead_id if missing ──
    // For inbound calls or calls where lead wasn't linked, try to find lead by phone number
    if (!callLog.lead_id && callLog.client_id) {
      const phoneToSearch = callLog.callee_number || callLog.caller_id;
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
            // Also update the CallLog record so future references have the lead linked
            await svc.entities.CallLog.update(callLogId, { lead_id: matchedLead.id });
            console.log(`[ActionExtractor] Auto-linked lead ${matchedLead.name} (${matchedLead.id}) to call ${callLogId} via phone match`);
          }
        } catch (e) {
          console.warn(`[ActionExtractor] Lead phone lookup failed: ${e.message}`);
        }
      }
    }

    // Get current date/time for AI context — IST = UTC + 5:30
    const now = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const todayStr = istNow.toISOString().split('T')[0];
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istNow.getDay()];
    const istTimeStr = `${istNow.getUTCHours().toString().padStart(2,'0')}:${istNow.getUTCMinutes().toString().padStart(2,'0')} IST`;

    // ── RESOLVE INDUSTRY BLUEPRINT (off the call path — call already ended) ──
    // Used to (a) extract industry custom fields and (b) pick a pipeline stage.
    let blueprint = null;
    if (callLog.client_id) {
      try {
        const bpClient = await svc.entities.Client.get(callLog.client_id).catch(() => null);
        if (bpClient) {
          const bpKey = bpClient.blueprint_key
            || (bpClient.industry
                ? String(bpClient.industry).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
                : null);
          if (bpKey) {
            let bps = await svc.entities.IndustryBlueprint.filter({ industry_key: bpKey, status: 'active' }).catch(() => []);
            if (!bps || bps.length === 0) {
              const rawLabel = String(bpClient.industry || '').trim().toLowerCase();
              const all = await svc.entities.IndustryBlueprint.filter({ status: 'active' }).catch(() => []);
              bps = (all || []).filter((b) => (b.aliases || []).some((a) => String(a).trim().toLowerCase() === rawLabel));
            }
            blueprint = bps?.[0] || null;
          }
        }
      } catch (e) {
        console.warn(`[ActionExtractor] blueprint resolve failed: ${e.message}`);
      }
    }

    // Build blueprint extraction instructions (appended to the SAME LLM call —
    // no extra round-trip, so no added latency).
    let blueprintInstr = '';
    if (blueprint) {
      const fields = (blueprint.custom_fields || []).filter(f => f.key);
      const stages = (blueprint.pipeline_stages || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      const fieldLines = fields.map(f => {
        const opts = f.type === 'select' && f.options?.length ? ` (one of: ${f.options.join(', ')})` : '';
        return `  - ${f.key} [${f.type}]: ${f.label}${opts}`;
      }).join('\n');
      const stageLines = stages.map(s => `  - ${s.key}: ${s.label}`).join('\n');
      blueprintInstr = `\n\n═══ INDUSTRY FIELDS & PIPELINE (${blueprint.label}) ═══
Also return a "blueprint" object:
{
  "custom_fields": { ${fields.map(f => `"${f.key}": <value or null>`).join(', ')} },
  "pipeline_stage": "<stage key or null>"
}
${fieldLines ? `Custom fields to extract ONLY if clearly stated in the call (else null):\n${fieldLines}` : ''}
${stageLines ? `Pick the pipeline_stage that best matches the call outcome (or null if unclear):\n${stageLines}` : ''}
Never guess — use null when the conversation does not provide the value.`;
    }

    // Use Azure OpenAI to extract action items
                const extractionResponse = await fetch(
      "__CHAT_COMPLETIONS_MIGRATED__",
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
- IMPORTANT: Extract EVERY actionable request — do NOT skip email/detail requests${blueprintInstr}`
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
      return c.json({ data: { error: 'AI extraction failed', status: extractionResponse.status, detail: errText.substring(0, 500) } }, 500);
    }

    const extractionData = await extractionResponse.json();
    const rawContent = extractionData.choices?.[0]?.message?.content || '{}';

    let extracted;
    try {
      extracted = JSON.parse(rawContent);
    } catch (_) {
      console.error('[ActionExtractor] Failed to parse AI response');
      return c.json({ data: { error: 'AI response parse error' } }, 500);
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

    // ── HYBRID WHATSAPP + EMAIL DISPATCH ──
    // Fire in parallel for ANY completed call (campaign or group-scoped):
    // they internally check for matching CampaignTemplateMapping / EmailIntentMapping
    // and only send if a valid mapping exists for this campaign or the lead's groups.
    svc.functions.invoke('dispatchPostCallWhatsApp', { call_log_id: callLogId })
      .then(r => console.log(`[ActionExtractor] dispatchPostCallWhatsApp:`, JSON.stringify(r?.data || {}).substring(0, 200)))
      .catch(e => console.error(`[ActionExtractor] dispatchPostCallWhatsApp failed: ${e.message}`));
    svc.functions.invoke('dispatchPostCallEmail', { call_log_id: callLogId })
      .then(r => console.log(`[ActionExtractor] dispatchPostCallEmail:`, JSON.stringify(r?.data || {}).substring(0, 200)))
      .catch(e => console.error(`[ActionExtractor] dispatchPostCallEmail failed: ${e.message}`));

    // Fallback: if this was a Vaani Sales call and the AI agreed to a demo but
    // didn't call book_demo mid-call, extract & book from the transcript.
    svc.functions.invoke('extractDemoBookingFromCall', { call_log_id: callLogId })
      .then(r => console.log(`[ActionExtractor] extractDemoBookingFromCall:`, JSON.stringify(r?.data || {}).substring(0, 200)))
      .catch(e => console.error(`[ActionExtractor] extractDemoBookingFromCall failed: ${e.message}`));

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

    // Resolve the client owner email — activities must be assigned to a User email
    // so downstream automations (like Google Calendar sync) can find the right user.
    let ownerEmail = '';
    if (callLog.client_id) {
      try {
        const client = await svc.entities.Client.get(callLog.client_id);
        ownerEmail = client?.email || '';
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

    // 1b. Apply blueprint custom fields + pipeline stage to the lead (additive merge).
    if (blueprint && callLog.lead_id && extracted.blueprint) {
      try {
        const bp = extracted.blueprint;
        const incoming = bp.custom_fields || {};
        // Keep only non-null/non-empty values so we never wipe existing data.
        const cleaned = {};
        for (const [k, v] of Object.entries(incoming)) {
          if (v !== null && v !== undefined && v !== '') cleaned[k] = v;
        }
        const stageKeys = (blueprint.pipeline_stages || []).map(s => s.key);
        const newStage = bp.pipeline_stage && stageKeys.includes(bp.pipeline_stage) ? bp.pipeline_stage : null;

        if (Object.keys(cleaned).length > 0 || newStage) {
          const lead = await svc.entities.Lead.get(callLog.lead_id);
          const mergedCustom = { ...(lead.custom_fields || {}), ...cleaned };
          if (newStage) mergedCustom.pipeline_stage = newStage;
          await svc.entities.Lead.update(callLog.lead_id, { custom_fields: mergedCustom });
          console.log(`[ActionExtractor] Blueprint applied: fields=${Object.keys(cleaned).join(',') || 'none'}, stage=${newStage || 'unchanged'}`);
        }
      } catch (e) {
        console.error(`[ActionExtractor] Blueprint apply failed: ${e.message}`);
      }
    }

    // 2. Create Activity records for each extracted action
    // ── ONCE-PER-CALL GUARD for meeting-link dispatch ──
    // The LLM frequently emits MULTIPLE meeting actions for one call (e.g. a
    // "demo" + a "send demo invite" email + a duplicate "demo"). Each Activity
    // create fires the "Auto-create Google Calendar event" entity automation, and
    // the dispatch block below ALSO calls createCalendarEvent — so a single call
    // could fire 4-6 concurrent createCalendarEvent invocations. Those collide on
    // the Base44 rate limit (429) and throw BEFORE writing calendar_sync_error,
    // leaving demo activities with no meet_link and no error — which is exactly
    // why the meeting link never reached WhatsApp/email for some leads. We now
    // run the calendar+dispatch flow AT MOST ONCE per call.
    let meetingDispatchDone = false;
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
        const hasSimilar = existingActivities.some(ea =>
          ea.type === activityType &&
          ea.title?.toLowerCase().includes(action.title?.toLowerCase().substring(0, 20) || '') 
        );
        // Also check for same-type activity created from a recent call (within last 4 hours)
        const hasRecentSameType = existingActivities.some(ea => {
          if (ea.type !== activityType) return false;
          const created = new Date(ea.created_date);
          const hoursAgo = (now - created) / (1000 * 60 * 60);
          return hoursAgo < 4;
        });

        if (hasSimilar || hasRecentSameType) {
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
            assigned_to: ownerEmail || '',
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

          // ── AUTO-SEND MEETING LINK (email + WhatsApp) ──
          // Fires in TWO cases:
          //  (a) An "email" action whose text is a "send/resend meeting link" request, OR
          //  (b) ANY confirmed demo/meeting/appointment activity — when a customer agrees
          //      to a meeting they expect the join link on WhatsApp + email automatically.
          // Previously only case (a) ran, so "send me the link on WhatsApp and email"
          // (which the LLM extracts as a DEMO action, not an email) silently sent nothing.
          const titleLower = (action.title || '').toLowerCase();
          const descLower = (action.description || '').toLowerCase();
          const combined = titleLower + ' ' + descLower;
          const isMeetLinkEmail = activityType === 'email'
            && /meeting link|meet link|demo link|calendar invite|invite|join link/i.test(combined)
            && /send|resend|share|forward|email|whatsapp/i.test(combined);
          const isScheduledMeeting = ['demo', 'meeting', 'appointment'].includes(activityType);

          if ((isMeetLinkEmail || isScheduledMeeting) && callLog.lead_id && !meetingDispatchDone) {
            // Guard: run the calendar+dispatch flow only ONCE per call, regardless
            // of how many meeting/email actions the LLM emitted. This prevents the
            // concurrent createCalendarEvent storm that caused 429s + missing links.
            meetingDispatchDone = true;
            console.log(`[ActionExtractor] 🎥 Meeting-link dispatch (${isScheduledMeeting ? 'scheduled-meeting' : 'explicit-request'}) — ensuring a Meet link, then sending email + WhatsApp`);
            // Run async so we don't block the rest of extraction.
            (async () => {
              try {
                // Prefer the demo/meeting activity we just created (if it is one); else
                // reuse an existing lead activity that already has a Meet link.
                let targetActivity = isScheduledMeeting ? newActivity : null;

                const leadActivities = await svc.entities.Activity.filter({ lead_id: callLog.lead_id });
                const existingWithLink = leadActivities.find(
                  a => ['demo', 'meeting', 'appointment'].includes(a.type) && a.meet_link
                );

                // If no activity has a Meet link yet, generate one. Use the meeting
                // activity we created when available, otherwise REUSE any existing
                // demo/meeting activity for this lead before creating a new one — this
                // prevents a second link-less demo when the call produced both a "demo"
                // action and a separate "send link" email action.
                if (!existingWithLink) {
                  if (!targetActivity) {
                    targetActivity = leadActivities.find(
                      a => ['demo', 'meeting', 'appointment'].includes(a.type)
                    ) || null;
                  }
                  if (!targetActivity) {
                    let demoDate = action.scheduled_date;
                    if (!demoDate) {
                      const d = new Date();
                      d.setDate(d.getDate() + 1);
                      d.setUTCHours(5, 30, 0, 0);
                      demoDate = d.toISOString();
                    }
                    targetActivity = await svc.entities.Activity.create({
                      client_id: callLog.client_id,
                      lead_id: callLog.lead_id,
                      call_log_id: callLogId,
                      type: 'demo',
                      title: action.title?.replace(/send|resend|share|email|whatsapp/gi, '').trim() || 'Scheduled Demo',
                      description: 'Auto-created to generate a Google Meet link requested by the customer on the call.',
                      scheduled_date: demoDate,
                      status: 'scheduled',
                      priority: 'high',
                      auto_created: true,
                      assigned_to: ownerEmail || '',
                      duration_minutes: 30
                    });
                  }
                  // AWAIT createCalendarEvent so meet_link is saved before dispatch.
                  // (The Activity-create automation also runs this, but it's async and
                  // may race the dispatch — awaiting here guarantees the link exists.)
                  // Retry on transient failures (notably 429 rate-limit during the
                  // post-call fan-out): without this the calendar event silently
                  // never gets created and the meet link never reaches the lead.
                  for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                      const calRes = await svc.functions.invoke('createCalendarEvent', { activity_id: targetActivity.id });
                      const calData = calRes?.data || {};
                      console.log(`[ActionExtractor] createCalendarEvent (attempt ${attempt + 1}):`, JSON.stringify(calData).substring(0, 200));
                      if (calData.meet_link || calData.success || calData.skipped) break;
                    } catch (e) {
                      console.error(`[ActionExtractor] createCalendarEvent attempt ${attempt + 1} failed: ${e.message}`);
                    }
                    // Back off before retrying so the rate-limit window clears.
                    if (attempt < 2) await new Promise(r => setTimeout(r, 2500));
                  }
                }

                // Dispatch the link on BOTH channels (each picks the demo activity that has a meet_link).
                svc.functions.invoke('sendMeetingLinkEmail', {
                  lead_id: callLog.lead_id,
                  email_activity_id: newActivity.id
                }).then(r => console.log(`[ActionExtractor] sendMeetingLinkEmail result:`, JSON.stringify(r?.data || {}).substring(0, 200)))
                  .catch(e => console.error(`[ActionExtractor] sendMeetingLinkEmail failed: ${e.message}`));
                svc.functions.invoke('sendMeetingLinkWhatsApp', {
                  lead_id: callLog.lead_id,
                  email_activity_id: newActivity.id
                }).then(r => console.log(`[ActionExtractor] sendMeetingLinkWhatsApp result:`, JSON.stringify(r?.data || {}).substring(0, 200)))
                  .catch(e => console.error(`[ActionExtractor] sendMeetingLinkWhatsApp failed: ${e.message}`));
              } catch (e) {
                console.error(`[ActionExtractor] Meet-link ensure/dispatch failed: ${e.message}`);
              }
            })();
          }
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
    return c.json({ data: { success: true, ...results } });

  } catch (error) {
    console.error('[ActionExtractor] Fatal error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};
export async function postCallActionExtractorCore(callLogId: string) {
  const c = { req: { json: async () => ({ call_log_id: callLogId }) }, json: (data: any) => data };
  return await postCallActionExtractor(c);
}
