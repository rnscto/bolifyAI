import { createClient } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    // Entity automation — no user session, use service role directly
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const payload = await req.json();
    const { event, data, old_data } = payload;

    // Only process Lead update events
    if (!event || event.entity_name !== 'Lead' || event.type !== 'update') {
      return Response.json({ success: true, skipped: 'not_lead_update' });
    }

    const lead = data;
    const leadId = event.entity_id;

    // Only run when score actually changed (AI scoring just happened)
    const scoreChanged = lead.score !== (old_data?.score ?? undefined);
    const sentimentChanged = lead.sentiment !== (old_data?.sentiment ?? undefined);
    if (!scoreChanged && !sentimentChanged) {
      return Response.json({ success: true, skipped: 'no_score_change' });
    }

    const score = lead.score || 0;
    const sentiment = lead.sentiment || 'neutral';
    const intents = lead.intent_signals || [];
    const status = lead.status || 'new';
    const clientId = lead.client_id;
    const existingActions = lead.auto_actions_taken || [];
    const oldTier = old_data?.qualification_tier || null;

    // ===== TIER CALCULATION =====
    let tier = 'cold';
    let reason = '';

    const highIntents = ['demo_request', 'budget_confirmed', 'timeline_mentioned', 'decision_maker'].filter(s => intents.includes(s));
    const negativeIntents = ['objection_price', 'objection_timing', 'objection_need'].filter(s => intents.includes(s));

    if (score >= 75 && ['very_positive', 'positive'].includes(sentiment)) {
      tier = 'hot';
      reason = `Score ${score}/100, ${sentiment} sentiment, strong signals: ${highIntents.join(', ') || 'high engagement'}`;
    } else if (score >= 75 && sentiment === 'neutral') {
      tier = 'warm';
      reason = `High score ${score}/100 but neutral sentiment — needs personal touch`;
    } else if (score >= 50 && ['very_positive', 'positive', 'neutral'].includes(sentiment)) {
      tier = 'warm';
      reason = `Moderate score ${score}/100, ${sentiment} sentiment, signals: ${highIntents.join(', ') || 'some interest'}`;
    } else if (score >= 25 && !['very_negative'].includes(sentiment)) {
      tier = 'nurture';
      reason = `Low-moderate score ${score}/100 — needs nurturing via email sequences`;
    } else if (score < 25 && ['negative', 'very_negative'].includes(sentiment)) {
      tier = 'disqualified';
      reason = `Very low score ${score}/100 with ${sentiment} sentiment. Objections: ${negativeIntents.join(', ') || 'general disinterest'}`;
    } else if (score < 25) {
      tier = 'cold';
      reason = `Low score ${score}/100 — minimal engagement detected`;
    }

    // Override: if status is converted, always hot
    if (status === 'converted') {
      tier = 'hot';
      reason = 'Lead already converted';
    }
    // Override: do_not_call = disqualified
    if (status === 'do_not_call') {
      tier = 'disqualified';
      reason = 'Marked as do not call';
    }

    console.log(`[leadQualification] Lead ${leadId}: score=${score}, sentiment=${sentiment}, tier=${tier}, reason=${reason}`);

    const newActions = [...existingActions];
    const results = { tier, reason, actions: [] };

    // ===== AUTOMATED ACTIONS (only on tier change) =====
    if (tier !== oldTier) {

      // --- HOT LEAD: Create urgent task for sales rep ---
      if (tier === 'hot') {
        const actionKey = `task_hot_${new Date().toISOString().slice(0, 10)}`;
        if (!existingActions.includes(actionKey)) {
          const dueDate = new Date();
          dueDate.setHours(dueDate.getHours() + 4); // 4-hour SLA

          await base44.asServiceRole.entities.Activity.create({
            client_id: clientId,
            lead_id: leadId,
            type: 'task',
            title: `🔥 HOT LEAD: Call ${lead.name || lead.phone} immediately`,
            description: `AI Qualification: ${reason}\n\nScore: ${score}/100 | Sentiment: ${sentiment}\nIntent Signals: ${intents.join(', ')}\n\nThis lead has high conversion potential. Contact within 4 hours.`,
            scheduled_date: new Date().toISOString(),
            due_date: dueDate.toISOString(),
            status: 'scheduled',
            priority: 'high',
            assigned_to: lead.assigned_to || '',
            auto_created: true
          });

          newActions.push(actionKey);
          results.actions.push('task_created_hot');
          console.log(`[leadQualification] Created HOT task for lead ${leadId}`);
        }

        // Also create a demo/meeting task if demo_request signal present
        if (intents.includes('demo_request')) {
          const demoKey = `task_demo_${new Date().toISOString().slice(0, 10)}`;
          if (!existingActions.includes(demoKey)) {
            const demoDate = new Date();
            demoDate.setDate(demoDate.getDate() + 1);
            demoDate.setHours(10, 0, 0, 0);

            await base44.asServiceRole.entities.Activity.create({
              client_id: clientId,
              lead_id: leadId,
              type: 'demo',
              title: `Schedule demo for ${lead.name || lead.phone}`,
              description: `Lead requested a demo during the call. Score: ${score}/100.\nContact: ${lead.phone} / ${lead.email || 'N/A'}`,
              scheduled_date: demoDate.toISOString(),
              due_date: demoDate.toISOString(),
              status: 'scheduled',
              priority: 'high',
              assigned_to: lead.assigned_to || '',
              auto_created: true
            });
            newActions.push(demoKey);
            results.actions.push('demo_task_created');
          }
        }
      }

      // --- WARM LEAD: Create follow-up task ---
      if (tier === 'warm') {
        const actionKey = `task_warm_${new Date().toISOString().slice(0, 10)}`;
        if (!existingActions.includes(actionKey)) {
          const followupDate = new Date();
          followupDate.setDate(followupDate.getDate() + 1);

          await base44.asServiceRole.entities.Activity.create({
            client_id: clientId,
            lead_id: leadId,
            type: 'followup',
            title: `Follow up with warm lead: ${lead.name || lead.phone}`,
            description: `AI Qualification: ${reason}\n\nScore: ${score}/100 | Sentiment: ${sentiment}\nThis lead shows interest but needs more engagement. Follow up within 24h.`,
            scheduled_date: followupDate.toISOString(),
            due_date: followupDate.toISOString(),
            status: 'scheduled',
            priority: 'medium',
            assigned_to: lead.assigned_to || '',
            auto_created: true
          });
          newActions.push(actionKey);
          results.actions.push('task_created_warm');
          console.log(`[leadQualification] Created WARM follow-up task for lead ${leadId}`);
        }
      }

      // --- NURTURE LEAD: Auto-enroll in email nurture sequence ---
      if (tier === 'nurture' && lead.email) {
        const enrollKey = `nurture_enrolled_${new Date().toISOString().slice(0, 10)}`;
        if (!existingActions.includes(enrollKey)) {
          // Find an active re_engagement or lead_followup sequence for this client
          const sequences = await base44.asServiceRole.entities.EmailSequence.filter({
            status: 'active'
          });
          
          // Prefer re_engagement, fallback to lead_followup
          let targetSequence = sequences.find(s => s.outreach_type === 're_engagement');
          if (!targetSequence) targetSequence = sequences.find(s => s.outreach_type === 'lead_followup');

          if (targetSequence) {
            // Check not already enrolled
            const existing = await base44.asServiceRole.entities.SequenceEnrollment.filter({
              sequence_id: targetSequence.id,
              lead_id: leadId,
              status: 'active'
            });

            if (existing.length === 0) {
              const steps = targetSequence.steps || [];
              const firstDelay = steps[0]?.delay_days || 1;
              const nextSend = new Date();
              nextSend.setDate(nextSend.getDate() + firstDelay);

              await base44.asServiceRole.entities.SequenceEnrollment.create({
                sequence_id: targetSequence.id,
                client_id: clientId,
                lead_id: leadId,
                recipient_email: lead.email,
                recipient_name: lead.name || '',
                status: 'active',
                current_step: 0,
                steps_completed: 0,
                total_steps: steps.length,
                next_send_date: nextSend.toISOString(),
                enrolled_date: new Date().toISOString()
              });

              // Update sequence enrollment count
              await base44.asServiceRole.entities.EmailSequence.update(targetSequence.id, {
                total_enrolled: (targetSequence.total_enrolled || 0) + 1
              });

              newActions.push(enrollKey);
              results.actions.push(`nurture_enrolled:${targetSequence.name}`);
              console.log(`[leadQualification] Enrolled lead ${leadId} into nurture sequence: ${targetSequence.name}`);
            } else {
              results.actions.push('nurture_already_enrolled');
            }
          } else {
            results.actions.push('no_active_nurture_sequence');
            console.log(`[leadQualification] No active nurture sequence found`);
          }
        }
      }

      // --- DISQUALIFIED LEAD: Flag for removal, create cleanup task ---
      if (tier === 'disqualified') {
        const actionKey = `flagged_removal_${new Date().toISOString().slice(0, 10)}`;
        if (!existingActions.includes(actionKey)) {
          await base44.asServiceRole.entities.Activity.create({
            client_id: clientId,
            lead_id: leadId,
            type: 'task',
            title: `Review disqualified lead: ${lead.name || lead.phone}`,
            description: `AI flagged this lead for removal.\nReason: ${reason}\n\nScore: ${score}/100 | Sentiment: ${sentiment}\nPlease review and confirm removal or re-assign.`,
            scheduled_date: new Date().toISOString(),
            due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
            status: 'scheduled',
            priority: 'low',
            assigned_to: lead.assigned_to || '',
            auto_created: true
          });
          newActions.push(actionKey);
          results.actions.push('flagged_for_removal');
          console.log(`[leadQualification] Flagged lead ${leadId} for removal review`);
        }
      }

      // --- COLD LEAD: Create low-priority re-engagement task ---
      if (tier === 'cold') {
        const actionKey = `task_cold_${new Date().toISOString().slice(0, 10)}`;
        if (!existingActions.includes(actionKey)) {
          const reengageDate = new Date();
          reengageDate.setDate(reengageDate.getDate() + 7);

          await base44.asServiceRole.entities.Activity.create({
            client_id: clientId,
            lead_id: leadId,
            type: 'followup',
            title: `Re-engage cold lead: ${lead.name || lead.phone}`,
            description: `This lead scored low (${score}/100). Consider a different approach or channel.\nSentiment: ${sentiment}\n\nSuggestion: Try a different value proposition or wait for a better time.`,
            scheduled_date: reengageDate.toISOString(),
            due_date: reengageDate.toISOString(),
            status: 'scheduled',
            priority: 'low',
            assigned_to: lead.assigned_to || '',
            auto_created: true
          });
          newActions.push(actionKey);
          results.actions.push('task_created_cold_reengage');
        }
      }
    }

    // ===== UPDATE LEAD WITH TIER =====
    await base44.asServiceRole.entities.Lead.update(leadId, {
      qualification_tier: tier,
      qualification_reason: reason,
      auto_actions_taken: newActions.slice(-20) // Keep last 20 actions
    });

    console.log(`[leadQualification] Completed. Tier: ${tier}, Actions: ${results.actions.join(', ') || 'none'}`);
    return Response.json({ success: true, ...results });

  } catch (error) {
    console.error('[leadQualification] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});