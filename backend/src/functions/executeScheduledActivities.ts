import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { EmailClient } from 'npm:@azure/communication-email@1.0.0';


// ─── Postgres client (CampaignLead is PG-primary) ───
function pgClient() { return client; }

let _emailClient: any;
function getEmailClient() {
  if (!_emailClient) {
    const ep = Deno.env.get('AZURE_COMM_ENDPOINT');
    const key = Deno.env.get('AZURE_COMM_KEY');
    if (!ep || !key) throw new Error("Missing AZURE_COMM_ENDPOINT or AZURE_COMM_KEY");
    _emailClient = new EmailClient(`endpoint=${ep};accesskey=${key}`);
  }
  return _emailClient;
}

// ─── Send email via Azure Communication Services ───
async function sendEmailViaACS({ to, fromName, subject, html }) {
  const message = {
    senderAddress: 'DoNotReply@vaaniai.io',
    displayName: fromName || 'VaaniAI',
    content: { subject, html },
    recipients: { to: [{ address: to }] }
  };
  const poller = await getEmailClient().beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') throw new Error(`ACS Email error: ${result.error?.message || result.status}`);
  return result;
}

// ─── Azure OpenAI helper (uses own keys, zero Base44 credits) ───
async function azureLLM(prompt, systemPrompt, jsonSchema) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// Follow-up Automation Engine — runs every 15 min.
// Can be invoked by Base44 scheduled automation OR external cron:
//   GET ?cron_secret=<SMARTFLO_WEBHOOK_SECRET>
// Picks up scheduled activities due NOW, executes them.

export default async function executeScheduledActivities(c: any) {
  const _req = c.req.raw || c.req;
  try {
    // Auth handled by Base44 gateway via ?api_key= — no internal check needed
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = base44;;

    const now = new Date();
    const results = {
      calls_initiated: 0,
      emails_sent: 0,
      admin_alerts_sent: 0,
      reminders_sent: 0,
      marked_overdue: 0,
      skipped: 0,
      errors: []
    };

    // ── Fetch DUE + near-future scheduled activities (paginated) ──
    // BUG FIX: the old code fetched only the oldest-100 'scheduled' activities by
    // scheduled_date ASC with NO pagination. When many clients each have dozens of
    // FUTURE-dated reminders, those oldest rows filled the 100-row page and were all
    // `skipped` (not yet due) — so genuinely DUE activities beyond row 100 were never
    // reached, their status never flipped, and they sat "scheduled" forever (exactly
    // the symptom on /ClientActivities). We now paginate the full 'scheduled' set so
    // every due activity across every client is processed each run. The 30-min demo
    // reminder window (future-dated) is still handled inside the loop.
    const nowIso = now.toISOString();
    const activities = [];
    const PAGE = 200;
    let pageIdx = 0;
    while (true) {
      let page = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          page = await svc.entities.Activity.filter(
            { status: 'scheduled' }, 'scheduled_date', PAGE, pageIdx * PAGE
          );
          break;
        } catch (e) {
          if (/429|rate limit/i.test(e.message || '') && attempt < 2) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      if (!page || page.length === 0) break;
      activities.push(...page);
      pageIdx++;
      if (pageIdx > 100) break; // safety cap: 20k scheduled activities
      await new Promise(r => setTimeout(r, 120)); // pace between pages
    }
    console.log(`[FollowupEngine] Fetched ${activities.length} scheduled activities (now=${nowIso})`);

    // ── Per-run budget + wall-clock guard ──
    // Each due activity does slow work (ACS email + azureLLM + Smartflo + several
    // Base44 reads), so processing the whole backlog serially blew past the 180s
    // function limit → the run 504'd mid-way and the NEXT cron cycle restarted from
    // the oldest, so later due activities were never reached and their status never
    // changed. We bound each run: stop after MAX_ACTIONS heavy actions OR when we're
    // close to the time limit. Processed activities flip out of the 'scheduled'-due
    // set (reminder_sent / status change), so the next cycle advances to the rest.
    const RUN_STARTED_AT = Date.now();
    const TIME_BUDGET_MS = 150 * 1000; // leave headroom under the 180s limit
    const MAX_ACTIONS = 40;            // cap heavy actions (calls/emails/alerts) per run
    let actionsThisRun = 0;
    let budgetHit = false;

    // ── Batched active-campaign lead lookup (replaces per-activity CampaignLead reads) ──
    // Previously each call/followup did 2-3 Base44 reads just to check "is this lead in
    // an active campaign?" — burning most of the run on rows that get skipped. CampaignLead
    // is PG-primary, so we fetch the full set of lead_ids currently pending/calling in ONE
    // Postgres query and check it in-memory. If PG is unreachable we fall back to the old
    // per-activity check so behaviour is never lost.
    const activeCampaignLeadIds = new Set();
    let pgCampaignOk = false;
    {
      const candidateLeadIds = [...new Set(
        activities.filter(a => ['call', 'followup'].includes(a.type) && a.lead_id).map(a => a.lead_id)
      )];
      if (candidateLeadIds.length > 0) {
        const pg = pgClient();
        try {
          ; /* pg.connect() not needed */
          const res = await pg.queryObject(
            `SELECT DISTINCT lead_id FROM campaign_leads
             WHERE status IN ('pending','calling') AND lead_id = ANY($ids)`,
            { ids: candidateLeadIds }
          );
          res.rows.forEach(r => { if (r.lead_id) activeCampaignLeadIds.add(r.lead_id); });
          pgCampaignOk = true;
          console.log(`[FollowupEngine] Active-campaign leads: ${activeCampaignLeadIds.size} of ${candidateLeadIds.length} candidates (PG)`);
        } catch (e) {
          console.warn(`[FollowupEngine] PG campaign lookup failed (${e.message}) — falling back to per-activity check`);
        } finally {
          try { ; /* pg.end() not needed */ } catch (_) {}
        }
      } else {
        pgCampaignOk = true; // nothing to look up
      }
    }

    for (const activity of activities) {
      // Stop cleanly when out of budget — remaining due activities resume next cycle.
      if (actionsThisRun >= MAX_ACTIONS || (Date.now() - RUN_STARTED_AT) > TIME_BUDGET_MS) {
        budgetHit = true;
        console.log(`[FollowupEngine] Budget reached (actions=${actionsThisRun}, elapsed=${Math.round((Date.now()-RUN_STARTED_AT)/1000)}s) — deferring remaining activities to next cycle`);
        break;
      }
      // ── Per-activity try/catch so one failure doesn't kill the whole run ──
      try {
        const scheduledDate = new Date(activity.scheduled_date);

        // ── CHEAP early-skip for not-yet-due, non-reminder activities ──
        // Done BEFORE any DB read so future-dated rows (the bulk of the backlog)
        // cost nothing and never consume the per-run budget. Demo/meeting/appointment
        // rows fall through so their T-30min reminder window is still evaluated.
        const NEEDS_FUTURE_CHECK = ['demo', 'meeting', 'appointment'];
        if (scheduledDate > now && !NEEDS_FUTURE_CHECK.includes(activity.type)) {
          results.skipped++;
          continue;
        }

        // ════════════════════════════════════════════════════════════════
        // T-30min DEMO LINK REMINDER (Email + WhatsApp only)
        // Fires ONCE per demo/meeting/appointment activity ~30 min before it
        // starts — sends the demo/Meet join link via Email + WhatsApp. Runs
        // while the activity is still in the FUTURE, so it's checked BEFORE the
        // "skip future activities" guard below. Engine runs every 15 min → the
        // 22–38 min window covers the 30-min mark without double-firing
        // (idempotent via reminder_30_sent).
        // ════════════════════════════════════════════════════════════════
        const REMINDER_TYPES = ['demo', 'meeting', 'appointment'];
        if (REMINDER_TYPES.includes(activity.type) && !activity.reminder_30_sent) {
          const minsUntil = (scheduledDate - now) / (1000 * 60);
          if (minsUntil >= 22 && minsUntil <= 38) {
            try {
              // Email + WhatsApp: reuse the meeting-link senders (they attach the Meet link).
              svc.functions.invoke('sendMeetingLinkEmail', { activity_id: activity.id })
                .catch(e => console.error(`[FollowupEngine] 30min email failed: ${e.message}`));
              svc.functions.invoke('sendMeetingLinkWhatsApp', { activity_id: activity.id })
                .catch(e => console.error(`[FollowupEngine] 30min whatsapp failed: ${e.message}`));

              // AI REMINDER CALL — create a regular scheduled `call` activity due now.
              // The existing call handler (section 1) picks it up and places the call
              // via the same agent, automatically injecting prior call history. The
              // description marks it clearly as an upcoming-demo reminder call.
              const rLead = activity.lead_id ? await svc.entities.Lead.get(activity.lead_id).catch(() => null) : null;
              if (rLead?.phone && rLead.status !== 'do_not_call') {
                const istWhen = new Date(scheduledDate.getTime() + (5.5 * 60 * 60 * 1000))
                  .toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
                await svc.entities.Activity.create({
                  client_id: activity.client_id,
                  lead_id: activity.lead_id,
                  call_log_id: activity.call_log_id || undefined,
                  type: 'call',
                  title: `Demo reminder call — ${activity.title}`,
                  description: `REMINDER CALL: ${rLead.name || 'this customer'} has a ${activity.type} ("${activity.title}") scheduled in about 30 minutes at ${istWhen} IST. Politely remind them the ${activity.type} is starting soon, confirm they will join, and mention the join link was sent on Email and WhatsApp. Keep it short — do NOT pitch.`,
                  scheduled_date: now.toISOString(),
                  priority: 'high',
                  auto_created: true,
                  notes: `[Engine] Auto-created demo reminder call for activity ${activity.id}`
                }).catch(e => console.error(`[FollowupEngine] 30min reminder call create failed: ${e.message}`));
              }

              await svc.entities.Activity.update(activity.id, {
                reminder_30_sent: true,
                notes: (activity.notes || '') + `\n[Engine] 30-min reminder sent (email+WhatsApp + AI call scheduled) at ${now.toISOString()}`
              });
              results.reminders_sent++;
              actionsThisRun++;
              console.log(`[FollowupEngine] ⏰ 30-min demo link reminder fired for ${activity.type} "${activity.title}"`);
            } catch (remErr) {
              console.error(`[FollowupEngine] 30-min reminder error for ${activity.id}: ${remErr.message}`);
            }
          }
          // Don't `continue` — let normal due-date processing happen later if applicable.
        }

        // Skip future activities (not yet due)
        if (scheduledDate > now) {
          results.skipped++;
          continue;
        }

        const hoursPast = (now - scheduledDate) / (1000 * 60 * 60);
        const activityType = activity.type;

        // Only mark as overdue if >24h past AND it's a human-action type.
        // AI-handled types (call, followup) should NOT be overdue — they auto-execute.
        const humanActionTypes = ['email', 'task', 'demo', 'visit', 'meeting', 'appointment', 'booking'];
        if (hoursPast > 24 && humanActionTypes.includes(activityType)) {
          await svc.entities.Activity.update(activity.id, { status: 'overdue' });
          results.marked_overdue++;
          console.log(`[FollowupEngine] Marked overdue: ${activity.id} (${activity.title}) — requires human attention`);
          continue;
        }
        // For AI-handled types that are very old (>48h), mark them as overdue too (safety net)
        if (hoursPast > 48 && !humanActionTypes.includes(activityType)) {
          await svc.entities.Activity.update(activity.id, { status: 'overdue' });
          results.marked_overdue++;
          console.log(`[FollowupEngine] Marked overdue (safety net): ${activity.id} (${activity.title}) — 48h+ past`);
          continue;
        }

        // Skip if already processed
        if (activity.reminder_sent) {
          results.skipped++;
          continue;
        }

        // Load lead + client (with safe error handling)
        let lead = null, client = null;
        if (activity.lead_id) {
          try { lead = await svc.entities.Lead.get(activity.lead_id); } catch (e) {
            console.warn(`[FollowupEngine] Lead ${activity.lead_id} not found: ${e.message}`);
          }
        }
        if (activity.client_id) {
          try { client = await svc.entities.Client.get(activity.client_id); } catch (e) {
            console.warn(`[FollowupEngine] Client ${activity.client_id} not found: ${e.message}`);
          }
        }

        // If client doesn't exist, skip but don't crash
        if (!client) {
          console.warn(`[FollowupEngine] Skipping activity ${activity.id}: client not found`);
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + '\n[Engine] Skipped: client not found'
          });
          results.skipped++;
          continue;
        }

        console.log(`[FollowupEngine] Processing: ${activity.id} | type=${activityType} | title="${activity.title}" | lead=${lead?.name || 'N/A'}`);

        // ============================================================
        // 1. CALL / FOLLOWUP → Auto-initiate call with SAME agent
        // ============================================================
        if (activityType === 'call' || activityType === 'followup') {
          // ── TRAI QUIET-HOURS GATE (9 PM – 9 AM IST) ──
          // TRAI Telecom Commercial Communications Customer Preference Regulations
          // forbid commercial voice calls between 21:00 and 09:00 IST. We reschedule
          // the activity to the next 9 AM IST slot instead of placing the call now.
          const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
          const istHour = istNow.getUTCHours();
          if (istHour >= 21 || istHour < 9) {
            // Compute the next 9 AM IST in UTC
            const next = new Date(istNow);
            if (istHour >= 21) next.setUTCDate(next.getUTCDate() + 1);
            next.setUTCHours(9, 0, 0, 0);
            const nextUtc = new Date(next.getTime() - (5.5 * 60 * 60 * 1000));
            await svc.entities.Activity.update(activity.id, {
              scheduled_date: nextUtc.toISOString(),
              notes: (activity.notes || '') + `\n[Engine] Rescheduled to ${nextUtc.toISOString()} — TRAI quiet hours (9 PM – 9 AM IST)`
            });
            results.skipped++;
            console.log(`[FollowupEngine] ⏰ TRAI quiet-hours: rescheduled ${activity.id} to ${nextUtc.toISOString()}`);
            continue;
          }

          // ── DEDUP CHECK 1: Lead-level cooldown (skip if called within last 2 hours) ──
          // EXCEPTION: Confirmed callbacks bypass cooldown — the customer expects this call
          const isConfirmedCallback = (activity.notes || '').includes('[confirmed]') || (activity.title || '').includes('[confirmed]');
          if (lead?.id && !isConfirmedCallback) {
            try {
              const recentCallsCheck = await svc.entities.CallLog.filter(
                { lead_id: lead.id, direction: 'outbound' }, '-created_date', 1
              );
              if (recentCallsCheck.length > 0) {
                const lastCallTime = new Date(recentCallsCheck[0].call_start_time || recentCallsCheck[0].created_date);
                const hoursSinceLastCall = (now - lastCallTime) / (1000 * 60 * 60);
                if (hoursSinceLastCall < 2) {
                  console.log(`[FollowupEngine] Skipped ${activity.id}: lead ${lead.name} was called ${hoursSinceLastCall.toFixed(1)}h ago (cooldown)`);
                  await svc.entities.Activity.update(activity.id, {
                    reminder_sent: true,
                    notes: (activity.notes || '') + `\n[Engine] Skipped: lead called ${hoursSinceLastCall.toFixed(1)}h ago (2h cooldown)`
                  });
                  results.skipped++;
                  continue;
                }
              }
            } catch (e) {
              console.warn(`[FollowupEngine] Cooldown check failed: ${e.message}`);
            }
          } else if (isConfirmedCallback) {
            console.log(`[FollowupEngine] Confirmed callback — bypassing cooldown for ${activity.id} (${lead?.name || 'unknown'})`);
          }

          // ── DEDUP CHECK 2: Skip if lead is in an active/running campaign ──
          // Uses the batched PG Set when available (zero per-row reads); falls back to
          // the per-activity Base44 query only if the upfront PG lookup failed.
          if (lead?.id) {
            let inActiveCampaign = false;
            if (pgCampaignOk) {
              inActiveCampaign = activeCampaignLeadIds.has(lead.id);
            } else {
              try {
                const activeCampaignLeads = await svc.entities.CampaignLead.filter({ lead_id: lead.id });
                inActiveCampaign = activeCampaignLeads.some(cl => ['pending', 'calling'].includes(cl.status));
              } catch (e) {
                console.warn(`[FollowupEngine] Campaign check failed: ${e.message}`);
              }
            }
            if (inActiveCampaign) {
              console.log(`[FollowupEngine] Skipped ${activity.id}: lead ${lead.name} is in an active campaign`);
              await svc.entities.Activity.update(activity.id, {
                reminder_sent: true,
                notes: (activity.notes || '') + `\n[Engine] Skipped: lead is in active campaign`
              });
              results.skipped++;
              continue;
            }
          }

          if (!lead?.phone) {
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + '\n[Engine] Skipped: no lead phone'
            });
            results.skipped++;
            console.log(`[FollowupEngine] Skipped ${activity.id}: no lead phone`);
            continue;
          }

          if (lead.status === 'do_not_call') {
            await svc.entities.Activity.update(activity.id, {
              status: 'cancelled',
              notes: (activity.notes || '') + '\n[Engine] Cancelled: do_not_call'
            });
            results.skipped++;
            console.log(`[FollowupEngine] Cancelled ${activity.id}: do_not_call`);
            continue;
          }

          // Find the SAME agent from the original call (via call_log_id on activity)
          let agent = null;
          if (activity.call_log_id) {
            try {
              const origCall = await svc.entities.CallLog.get(activity.call_log_id);
              if (origCall?.agent_id) {
                try {
                  agent = await svc.entities.Agent.get(origCall.agent_id);
                  if (agent?.status !== 'active') {
                    console.log(`[FollowupEngine] Original agent ${origCall.agent_id} not active, looking for fallback`);
                    agent = null;
                  }
                } catch (e) {
                  console.warn(`[FollowupEngine] Agent ${origCall.agent_id} not found: ${e.message}`);
                }
              }
            } catch (e) {
              console.warn(`[FollowupEngine] CallLog ${activity.call_log_id} not found: ${e.message}`);
            }
          }

          // Fallback: any active agent for this client
          if (!agent) {
            try {
              const agents = await svc.entities.Agent.filter({ client_id: activity.client_id, status: 'active' });
              agent = agents.find(a => (a.assigned_dids?.length > 0) || a.assigned_did);
              if (agent) console.log(`[FollowupEngine] Using fallback agent: ${agent.name}`);
            } catch (e) {
              console.warn(`[FollowupEngine] Error finding fallback agents: ${e.message}`);
            }
          }

          if (!agent) {
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + '\n[Engine] Skipped: no active agent'
            });
            try {
              await sendAdminAlert(svc, client, activity, lead, 'auto_call_failed', 'No active agent with DID available for follow-up call.');
            } catch (alertErr) {
              console.error(`[FollowupEngine] Admin alert failed: ${alertErr.message}`);
            }
            results.skipped++;
            continue;
          }

          const callerDID = (agent.assigned_dids?.length > 0) ? agent.assigned_dids[0] : agent.assigned_did;
          if (!callerDID) {
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + '\n[Engine] Skipped: agent has no DID assigned'
            });
            console.warn(`[FollowupEngine] Agent ${agent.name} has no DID assigned`);
            results.skipped++;
            continue;
          }

          // Build lead context INLINE
          const ctxParts = [`CUSTOMER PROFILE:`, `- Name: ${lead.name || 'Unknown'}`];
          if (lead.phone) ctxParts.push(`- Phone: ${lead.phone}`);
          if (lead.email) ctxParts.push(`- Email: ${lead.email}`);
          if (lead.company) ctxParts.push(`- Company: ${lead.company}`);
          if (lead.status) ctxParts.push(`- Status: ${lead.status}`);
          if (lead.score) ctxParts.push(`- Score: ${lead.score}/100`);
          if (lead.qualification_tier) ctxParts.push(`- Tier: ${lead.qualification_tier.toUpperCase()}`);
          if (lead.notes) ctxParts.push(`\nLEAD NOTES:\n${lead.notes.substring(0, 500)}`);

          // Get recent call history
          try {
            const recentCalls = await svc.entities.CallLog.filter({ lead_id: lead.id }, '-created_date', 3);
            if (recentCalls.length > 0) {
              ctxParts.push(`\nPREVIOUS CALLS (${recentCalls.length}):`);
              recentCalls.forEach((c, i) => {
                const dt = c.call_start_time ? new Date(c.call_start_time).toLocaleDateString('en-IN') : '?';
                ctxParts.push(`  ${i+1}. ${dt} (${c.status}) — ${(c.conversation_summary || '').substring(0, 200)}`);
              });
            }
          } catch (_) {}

          ctxParts.push(`\nFOLLOW-UP CONTEXT:`);
          ctxParts.push(`- Reason: ${activity.title || 'Scheduled follow-up'}`);
          ctxParts.push(`- Details: ${activity.description || 'N/A'}`);
          if (activity.notes) ctxParts.push(`- Notes: ${activity.notes}`);
          ctxParts.push(`\nCRITICAL RULES:`);
          ctxParts.push(`- Address customer by name "${lead.name || 'Sir/Madam'}".`);
          ctxParts.push(`- Reference your previous conversation naturally.`);
          ctxParts.push(`- This is a SCHEDULED follow-up — the customer expects this call.`);
          const leadContext = ctxParts.join('\n');

          // Knowledge base
          let kbContent = '';
          if (agent.knowledge_base_ids?.length > 0) {
            for (const kbId of agent.knowledge_base_ids) {
              try {
                const doc = await svc.entities.KnowledgeBase.get(kbId);
                if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
              } catch (_) {}
            }
          }

          // ── WHATSAPP DELIVERY OPTIONS (group-scoped) ──
          let whatsappContext = '';
          try {
            const groupIds = Array.isArray(lead.group_ids) ? lead.group_ids : [];
            if (groupIds.length > 0) {
              const mappingArrays = await Promise.all(groupIds.map(gid =>
                svc.entities.CampaignTemplateMapping.filter({ group_id: gid }).catch(() => [])
              ));
              const aiMappings = mappingArrays.flat().filter(m =>
                m.enabled !== false && m.template_id &&
                (m.trigger_condition === 'ai_requested' || !m.trigger_condition)
              );
              if (aiMappings.length > 0) {
                const intentList = [...new Set(aiMappings.map(m =>
                  m.intent === 'custom' ? (m.custom_intent_label || 'custom') : m.intent
                ))].map(i => `  - ${i}`).join('\n');
                whatsappContext = `\n\n--- WHATSAPP DELIVERY OPTIONS ---
You CAN send the following on WhatsApp if the customer requests:
${intentList}

When the customer asks for any of these on WhatsApp:
1. Acknowledge naturally: "Theek hai, abhi WhatsApp pe bhej raha hoon"
2. Continue the conversation
3. The system will auto-deliver after the call ends — do NOT promise things outside this list.`;
              }
            }
          } catch (e) {
            console.error('[FollowupEngine] WhatsApp options inject failed:', e.message);
          }

          const personalizedPrompt = [
            agent.system_prompt || '',
            `\n\n--- FOLLOW-UP CALL CONTEXT (YOU MUST USE THIS DATA) ---\n${leadContext}`,
            whatsappContext
          ].filter(Boolean).join('\n');

          const callSid = `followup_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
          const callLog = await svc.entities.CallLog.create({
            client_id: activity.client_id,
            agent_id: agent.id,
            lead_id: lead.id,
            call_sid: callSid,
            caller_id: callerDID,
            callee_number: lead.phone,
            direction: 'outbound',
            status: 'initiated',
            call_start_time: now.toISOString(),
            conversation_summary: `[AUTO-FOLLOWUP] ${activity.title}\n${leadContext.substring(0, 500)}`,
            agent_config_cache: {
              agent_name: agent.name,
              system_prompt: personalizedPrompt,
              persona: agent.persona || {},
              knowledge_base_content: kbContent,
              lead_context: leadContext,
              greeting_message: agent.greeting_message || ''
            }
          });

          // Smartflo call — use agent's own API token
          const cleanPhone = lead.phone.replace(/\D/g, '');
          let followupApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
          try {
            const clientData = await svc.entities.Client.get(activity.client_id);
            if (clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding')) {
              followupApiKey = Deno.env.get('SMARTFLO_API_KEY');
            }
          } catch (_) {}

          const smartfloRes = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: followupApiKey,
              customer_number: cleanPhone,
              caller_id: callerDID.replace(/^\+/, ''),
              async: 1
            })
          });

          const smartfloData = await smartfloRes.json();
          if (!smartfloRes.ok || smartfloData.success === false) {
            await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
            await svc.entities.Activity.update(activity.id, {
              reminder_sent: true,
              notes: (activity.notes || '') + `\n[Engine] Call failed: ${smartfloData.message || 'Unknown'}`
            });
            results.errors.push({ activity_id: activity.id, error: smartfloData.message });
            console.error(`[FollowupEngine] Smartflo call failed for ${lead.name}: ${smartfloData.message}`);
            continue;
          }

          const actualSid = smartfloData.call_id || smartfloData.call_sid || smartfloData.ref_id || callSid;
          await svc.entities.CallLog.update(callLog.id, { call_sid: actualSid, status: 'ringing' });

          await svc.entities.Activity.update(activity.id, {
            status: 'completed',
            completed_date: now.toISOString(),
            reminder_sent: true,
            outcome: `Auto-call initiated (${callLog.id})`,
            notes: (activity.notes || '') + `\n[Engine] Call initiated: ${callLog.id}`
          });

          await svc.entities.Lead.update(lead.id, { status: 'contacted', last_call_date: now.toISOString() });
          results.calls_initiated++;
          actionsThisRun++;
          console.log(`[FollowupEngine] ✅ Call initiated: ${lead.name} → ${lead.phone} (activity ${activity.id})`);
        }

        // ============================================================
        // 2. EMAIL → Human action required (alert admin to send specific content)
        //    Email activities from postCallActionExtractor are requests like
        //    "send pricing", "email brochure" — these need human crafted content,
        //    NOT auto-generated AI emails.
        // ============================================================
        else if (activityType === 'email') {
          try {
            await sendAdminAlert(svc, client, activity, lead, 'human_action_required',
              `Lead requested specific content via email. Please send the appropriate materials manually.`);
            results.admin_alerts_sent++;
            actionsThisRun++;
          } catch (alertErr) {
            console.error(`[FollowupEngine] Admin alert for email failed: ${alertErr.message}`);
          }

          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + `\n[Engine] Admin alerted — human email required at ${now.toISOString()}`
          });
        }

        // ============================================================
        // 3. APPOINTMENT / DEMO / VISIT / MEETING → Human action needed
        //    Send reminder to lead + alert to client admin
        // ============================================================
        else if (['appointment', 'demo', 'visit', 'meeting', 'booking'].includes(activityType)) {
          // Send reminder to lead — format time in IST
          if (lead?.email) {
            try {
              // Convert UTC scheduled date to IST for display in email
              const istScheduled = new Date(scheduledDate.getTime() + (5.5 * 60 * 60 * 1000));
              const istDateStr = istScheduled.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
              const reminderContent = await azureLLM(
                `Write a brief reminder email for ${lead.name || 'customer'} about their ${activityType}: "${activity.title}". Scheduled: ${istDateStr} IST. From ${client?.company_name || 'VaaniAI'}. Under 80 words, HTML body only. IMPORTANT: Show the time as ${istDateStr} IST in the email.`,
                'You are an email copywriter. Always respond in valid JSON.',
                { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" } } }
              );
              await sendEmailViaACS({
                to: lead.email,
                fromName: client?.company_name || 'VaaniAI',
                subject: reminderContent.subject,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${reminderContent.body_html}</div>`
              });
              results.reminders_sent++;
              console.log(`[FollowupEngine] ✅ Reminder sent to ${lead.email}`);
            } catch (e) {
              console.error(`[FollowupEngine] Lead reminder failed: ${e.message}`);
            }
          }

          // ALERT CLIENT ADMIN — human action required
          try {
            await sendAdminAlert(svc, client, activity, lead, 'human_action_required',
              `${activityType.toUpperCase()} scheduled. Human agent action needed.`);
            results.admin_alerts_sent++;
            actionsThisRun++;
          } catch (alertErr) {
            console.error(`[FollowupEngine] Admin alert failed: ${alertErr.message}`);
          }

          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + `\n[Engine] Reminder + admin alert sent at ${now.toISOString()}`
          });
        }

        // ============================================================
        // 4. TASK → Alert admin, mark overdue
        // ============================================================
        else if (activityType === 'task') {
          try {
            await sendAdminAlert(svc, client, activity, lead, 'task_due',
              `Task is due and requires attention.`);
            results.admin_alerts_sent++;
            actionsThisRun++;
          } catch (alertErr) {
            console.error(`[FollowupEngine] Admin alert failed: ${alertErr.message}`);
          }

          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true, status: hoursPast > 4 ? 'overdue' : 'scheduled',
            notes: (activity.notes || '') + `\n[Engine] Admin alerted at ${now.toISOString()}`
          });
          if (hoursPast > 4) results.marked_overdue++;
        }

        else {
          console.log(`[FollowupEngine] Unknown type: ${activityType}, skipping`);
          results.skipped++;
        }

      } catch (activityErr) {
        // ── Per-activity error: log it and continue to next ──
        console.error(`[FollowupEngine] Error processing activity ${activity.id} (${activity.title}): ${activityErr.message}`);
        results.errors.push({ activity_id: activity.id, title: activity.title, error: activityErr.message });
        // Mark as processed to avoid retrying the same broken activity forever
        try {
          await svc.entities.Activity.update(activity.id, {
            reminder_sent: true,
            notes: (activity.notes || '') + `\n[Engine] Error: ${activityErr.message}`
          });
        } catch (_) {}
      }
    }

    console.log(`[FollowupEngine] Done. Calls:${results.calls_initiated} Emails:${results.emails_sent} Alerts:${results.admin_alerts_sent} Overdue:${results.marked_overdue} Errors:${results.errors.length} BudgetHit:${budgetHit}`);
    return c.json({ data: { success: true, fetched: activities.length, actions_this_run: actionsThisRun, budget_hit: budgetHit, ...results } });

  } catch (error) {
    console.error('[FollowupEngine] Fatal error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};


// ============================================================
// ADMIN EMAIL ALERT — Uses Azure Communication Services
// ============================================================
async function sendAdminAlert(svc, client, activity, lead, alertType, reason) {
  if (!client?.email) {
    console.warn(`[FollowupEngine] Cannot send admin alert: no client email`);
    return;
  }

  const leadName = lead?.name || 'Unknown Lead';
  const leadPhone = lead?.phone || 'N/A';
  const leadEmail = lead?.email || 'N/A';
  const companyName = client.company_name || 'Your Company';

  const typeLabels = {
    human_action_required: '🏃 Human Action Required',
    task_due: '📋 Task Due',
    auto_call_failed: '⚠️ Auto-Call Failed'
  };
  const label = typeLabels[alertType] || '🔔 Activity Alert';

  const actionGuide = {
    'visit': 'Send location details to the lead and confirm the visit timing.',
    'demo': 'Prepare the demo environment and send meeting link/instructions.',
    'appointment': 'Confirm the appointment and prepare relevant materials.',
    'meeting': 'Send meeting details (agenda, link) to all participants.',
    'booking': 'Confirm the booking and share details with the lead.',
    'task': 'Complete the assigned task and update the lead status.'
  };
  const suggestedAction = actionGuide[activity.type] || 'Review and take appropriate action.';

  const emailBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,#dc2626,#b91c1c);padding:20px 30px;border-radius:12px 12px 0 0;">
        <h2 style="color:white;margin:0;">${label}</h2>
        <p style="color:#fecaca;margin:4px 0 0;font-size:13px;">${companyName} — VaaniAI Automation Engine</p>
      </div>
      <div style="padding:24px 30px;background:white;border:1px solid #e2e8f0;border-top:none;">
        <h3 style="color:#1e293b;margin:0 0 8px;">${activity.title || activity.type}</h3>
        <p style="color:#64748b;margin:0 0 16px;font-size:14px;">${reason}</p>
        
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#64748b;width:120px;">Lead Name:</td><td style="padding:8px 0;color:#1e293b;font-weight:600;">${leadName}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Phone:</td><td style="padding:8px 0;color:#1e293b;">${leadPhone}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Email:</td><td style="padding:8px 0;color:#1e293b;">${leadEmail}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Type:</td><td style="padding:8px 0;color:#1e293b;">${activity.type?.toUpperCase()}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Priority:</td><td style="padding:8px 0;color:${activity.priority === 'high' ? '#dc2626' : '#1e293b'};font-weight:600;">${(activity.priority || 'medium').toUpperCase()}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Scheduled:</td><td style="padding:8px 0;color:#1e293b;">${new Date(activity.scheduled_date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST</td></tr>
        </table>

        ${activity.description ? `<div style="margin:16px 0;padding:12px;background:#f8fafc;border-radius:8px;border-left:3px solid #3b82f6;"><p style="margin:0;color:#334155;font-size:13px;">${activity.description}</p></div>` : ''}
        ${activity.notes ? `<div style="margin:8px 0;padding:12px;background:#fffbeb;border-radius:8px;border-left:3px solid #f59e0b;"><p style="margin:0;color:#92400e;font-size:13px;"><strong>Notes:</strong> ${activity.notes.substring(0, 300)}</p></div>` : ''}

        <div style="margin:20px 0;padding:16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
          <p style="margin:0;color:#166534;font-size:14px;"><strong>✅ Suggested Action:</strong> ${suggestedAction}</p>
        </div>

        ${lead?.notes ? `<div style="margin:12px 0;padding:12px;background:#f1f5f9;border-radius:8px;"><p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;">LEAD HISTORY:</p><p style="margin:0;color:#334155;font-size:13px;">${lead.notes.substring(0, 400)}</p></div>` : ''}
      </div>
      <div style="padding:16px 30px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
        <p style="margin:0;color:#94a3b8;font-size:12px;">Sent by VaaniAI Follow-up Automation Engine</p>
      </div>
    </div>`;

  await sendEmailViaACS({
    to: client.email,
    fromName: 'VaaniAI Automation',
    subject: `[${label}] ${activity.title || activity.type} — ${leadName}`,
    html: emailBody
  });
  console.log(`[FollowupEngine] Admin alert sent to ${client.email}: ${alertType}`);
}