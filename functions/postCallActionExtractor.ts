import { createClient } from 'npm:@base44/sdk@0.8.20';

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
    // Entity automation — no user session, use service role directly (same as campaignPoller)
    const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

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

    // Skip very short transcripts (likely failed/dropped calls)
    if (callLog.transcript.length < 50) {
      return Response.json({ skipped: true, reason: 'Transcript too short' });
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

    // Use Azure OpenAI to extract action items
    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

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

Extract ALL action items from the conversation. Be thorough — capture anything that needs follow-up.

CRITICAL TIMEZONE RULE: All scheduled_date values MUST be in UTC (ISO 8601 format). Convert IST times to UTC by subtracting 5 hours 30 minutes.
Examples: 10:00 AM IST = 04:30 UTC, 12:00 PM IST = 06:30 UTC, 2:00 PM IST = 08:30 UTC, 6:00 PM IST = 12:30 UTC.

Return JSON with this exact structure:
{
  "lead_notes": "string — Key information about the lead: concerns, preferences, requirements, budget, timeline, decision criteria, personal details mentioned. Be detailed. Empty string if nothing notable.",
  "actions": [
    {
      "type": "call|email|demo|appointment|visit|meeting|task",
      "title": "Brief title for the activity",
      "description": "Details about what needs to happen",
      "scheduled_date": "ISO date-time string in UTC (converted from IST, or null if no specific time mentioned)",
      "scheduled_date_ist": "Human-readable IST time for reference (e.g. '17 March 2026 at 12:00 PM IST')",
      "priority": "low|medium|high",
      "trigger": "Exact quote or paraphrase from transcript that triggered this action"
    }
  ]
}

RULES — BE VERY SPECIFIC AND THOROUGH:

CALLBACK/RECALL SCHEDULING:
- "call me after 1 hour / 2 hours / 30 minutes" → create "call" activity with scheduled_date = current time + that duration (converted to UTC)
- "call me tomorrow" → create "call" at next business day 10:00 AM IST
- "call me at 3 PM / call at 3 baje" → create "call" at 3:00 PM IST today (or tomorrow if already past)
- "call me next week / Monday / Thursday" → create "call" at that day 10:00 AM IST
- "baad mein call karo / abhi busy hu" → create "call" in 2 hours from now
- "kal subah call karo" → create "call" tomorrow 10:00 AM IST
- "shaam ko call karo" → create "call" today/tomorrow 5:00 PM IST
- If customer seems interested but says "call later" without specific time → default 4 hours from now

EMAIL/SEND DETAILS:
- "send me details / pricing / brochure / information on email/WhatsApp" → create "email" activity scheduled IMMEDIATELY (now) with title "Send details/pricing to [name]" and high priority
- "email bhej do / details bhejo / price list bhejo" → create "email" activity IMMEDIATELY
- "mujhe mail karo with quotation / proposal" → create "email" with title "Send quotation/proposal"
- If customer asks to send anything (PDF, brochure, rate card, proposal) → create "email" immediately

DEMO/MEETING/VISIT:
- "let's schedule a demo/meeting" → create "demo" or "meeting" activity
- "I want to see a demo" → create "demo" with high priority
- "come to office / site visit chahiye" → create "visit" activity

AGREEMENT/CONVERSION:
- Customer agrees to buy/sign up/start → create "task" with title "Process order/signup for [name]" with HIGH priority
- "haan chalao / start karo / sign up karo" → create "task" for conversion processing

OTHER:
- If there's any follow-up commitment by the agent → create the corresponding activity
- If customer mentions visiting or a site visit → create "visit" activity
- If no specific date mentioned for callback, default to 4 hours from now
- For lead_notes: capture company size, budget range, pain points, competitor mentions, decision makers, timeline, product interests, specific questions asked
- Return empty actions array ONLY if customer clearly said "not interested" or "do not call"
- ALWAYS set priority: "high" for interested/demo/appointment/send-details, "medium" for callbacks, "low" for general follow-ups
- IMPORTANT: Extract EVERY actionable request — do NOT skip requests to send emails/details/pricing`
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
        // Map action type to Activity type enum
        const typeMap = {
          'call': 'call', 'followup': 'followup', 'email': 'email',
          'demo': 'demo', 'appointment': 'appointment', 'visit': 'visit',
          'meeting': 'meeting', 'task': 'task', 'booking': 'booking'
        };
        const activityType = typeMap[action.type] || 'task';

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
          const newActivity = await svc.entities.Activity.create({
            client_id: callLog.client_id,
            lead_id: callLog.lead_id || null,
            call_log_id: callLogId,
            type: activityType,
            title: action.title || `${activityType} follow-up`,
            description: `${action.description || ''}\n\n[Trigger: "${action.trigger || 'Extracted from call'}"]`,
            scheduled_date: scheduledDate,
            status: 'scheduled',
            priority: action.priority || 'medium',
            auto_created: true,
            assigned_to: callLog.agent_id || '',
            notes: `[Auto-extracted from call ${callLogId}]`
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