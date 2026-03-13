import { createClient } from 'npm:@base44/sdk@0.8.20';

// Post-Call AI Action Extractor
// Analyzes call transcripts to extract specific action items:
//  - Lead notes (key concerns, preferences, requirements mentioned)
//  - Scheduled follow-up calls with specific dates/times
//  - Email requests ("send me the pricing", "email me details")
//  - Demo/appointment/visit bookings
//  - Meeting scheduling
// Then auto-creates Activity records + updates Lead notes accordingly.

Deno.serve(async (req) => {
  try {
    // Entity automation — no user session, use service role directly
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });
    const svc = base44;

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

    // Get current date/time for AI context
    const now = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const todayStr = istNow.toISOString().split('T')[0];
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istNow.getDay()];

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
              content: `You are an expert at extracting actionable items from sales call transcripts. Today is ${dayOfWeek}, ${todayStr} (IST timezone).

Extract ALL action items from the conversation. Be thorough — capture anything that needs follow-up.

Return JSON with this exact structure:
{
  "lead_notes": "string — Key information about the lead: concerns, preferences, requirements, budget, timeline, decision criteria, personal details mentioned. Be detailed. Empty string if nothing notable.",
  "actions": [
    {
      "type": "call|email|demo|appointment|visit|meeting|task",
      "title": "Brief title for the activity",
      "description": "Details about what needs to happen",
      "scheduled_date": "ISO date-time string in IST (or null if no specific time mentioned)",
      "priority": "low|medium|high",
      "trigger": "Exact quote or paraphrase from transcript that triggered this action"
    }
  ]
}

RULES:
- If customer says "call me tomorrow/next week/Thursday" → create a "call" activity with the correct date (business hours 10:00 IST default)
- If customer says "send me pricing/brochure/details/email" → create an "email" activity scheduled immediately
- If customer says "let's schedule a demo/meeting" → create appropriate activity
- If customer mentions visiting or a site visit → create "visit" activity
- If there's any follow-up commitment by the agent → create the corresponding activity
- If no specific date mentioned for callback, default to 2 business days from today at 11:00 IST
- For lead_notes: capture company size, budget range, pain points, competitor mentions, decision makers, timeline, product interests
- Return empty actions array if no follow-up actions are needed (e.g., do_not_call, clear rejection)
- ALWAYS set priority: "high" for interested/demo/appointment, "medium" for callbacks, "low" for general follow-ups`
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

    // ── DEDUP: Check if this lead is in an active campaign (pending/calling) ──
    // If yes, skip creating call/followup activities to prevent duplicate calls
    let leadInActiveCampaign = false;
    if (callLog.lead_id) {
      try {
        const campaignLeads = await svc.entities.CampaignLead.filter({ lead_id: callLog.lead_id });
        leadInActiveCampaign = campaignLeads.some(cl => ['pending', 'calling'].includes(cl.status));
        if (leadInActiveCampaign) {
          console.log(`[ActionExtractor] Lead ${callLog.lead_id} is in active campaign — will skip call/followup activities`);
        }
      } catch (_) {}
    }

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

        // ── DEDUP CHECK 1: Skip call/followup if lead is in active campaign ──
        if (leadInActiveCampaign && ['call', 'followup'].includes(activityType)) {
          console.log(`[ActionExtractor] Skipped ${activityType} "${action.title}": lead in active campaign`);
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

        // Determine scheduled date
        let scheduledDate = action.scheduled_date;
        if (!scheduledDate) {
          const defaultDate = new Date(istNow);
          let daysAdded = 0;
          while (daysAdded < 2) {
            defaultDate.setDate(defaultDate.getDate() + 1);
            const day = defaultDate.getDay();
            if (day !== 0 && day !== 6) daysAdded++;
          }
          defaultDate.setHours(11, 0, 0, 0);
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