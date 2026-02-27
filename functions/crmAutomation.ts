import { createClient } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    // Entity automation — no user session, use service role directly
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });
    const payload = await req.json();

    const { event, data, old_data } = payload;

    if (!event || !data) {
      return Response.json({ success: false, error: 'Invalid payload' }, { status: 400 });
    }

    const entityName = event.entity_name;
    const eventType = event.type;
    const entityId = event.entity_id;

    console.log(`[CRM Automation] ${eventType} on ${entityName} (${entityId})`);

    // --- DEAL AUTOMATIONS ---
    if (entityName === 'Deal') {
      // Auto-move to "Proposal Sent" when proposal is uploaded
      if (eventType === 'update' && data.proposal_uploaded && !old_data?.proposal_uploaded) {
        console.log(`[CRM Automation] Proposal uploaded for deal ${entityId}, checking for stage update`);

        if (data.client_id) {
          const configs = await base44.asServiceRole.entities.CRMConfig.filter({ client_id: data.client_id });
          if (configs.length > 0) {
            const config = configs[0];
            const proposalStage = (config.deal_stages || []).find(s =>
              s.name.toLowerCase().includes('proposal')
            );
            if (proposalStage && data.stage !== proposalStage.name) {
              await base44.asServiceRole.entities.Deal.update(entityId, {
                stage: proposalStage.name,
                last_activity_date: new Date().toISOString()
              });
              console.log(`[CRM Automation] Deal ${entityId} moved to ${proposalStage.name}`);
            }
          }
        }
      }

      // Auto-create follow-up activity when deal is created
      if (eventType === 'create' && data.client_id) {
        const followupDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await base44.asServiceRole.entities.Activity.create({
          client_id: data.client_id,
          deal_id: entityId,
          lead_id: data.lead_id || '',
          type: 'followup',
          title: `Follow up on deal: ${data.title}`,
          scheduled_date: followupDate,
          status: 'scheduled',
          priority: 'medium',
          assigned_to: data.assigned_to || '',
          auto_created: true
        });
        console.log(`[CRM Automation] Auto follow-up created for deal ${entityId}`);
      }
    }

    // --- LEAD AUTOMATIONS ---
    if (entityName === 'Lead') {
      // GUARD: Skip if this update was made by automation (check for score field change only)
      // to prevent infinite loops: score update -> triggers update event -> score update again
      const isScoreOnlyChange = old_data && data.score !== old_data.score &&
        data.status === old_data.status && data.engagement_count !== old_data.engagement_count;
      if (isScoreOnlyChange) {
        console.log(`[CRM Automation] Skipping score-only update to prevent loop for lead ${entityId}`);
        return Response.json({ success: true, skipped: 'score_only_update' });
      }

      // Update lead score based on status changes
      if (eventType === 'update' && data.status !== old_data?.status) {
        const scoreMap = {
          new: 10, contacted: 25, interested: 60,
          not_interested: 5, callback: 40, converted: 100, do_not_call: 0
        };
        const newScore = scoreMap[data.status] || data.score || 0;

        await base44.asServiceRole.entities.Lead.update(entityId, {
          score: newScore,
          last_engagement_date: new Date().toISOString(),
          engagement_count: (data.engagement_count || 0) + 1
        });
        console.log(`[CRM Automation] Lead ${entityId} score updated to ${newScore}`);
      }

      // Auto-create deal when lead becomes "interested"
      if (eventType === 'update' && data.status === 'interested' && old_data?.status !== 'interested') {
        if (data.client_id) {
          // Check if client has CRM enabled
          const configs = await base44.asServiceRole.entities.CRMConfig.filter({ client_id: data.client_id });
          if (configs.length === 0) {
            console.log(`[CRM Automation] Client ${data.client_id} has no CRM config, skipping deal creation`);
            return Response.json({ success: true, skipped: 'no_crm_config' });
          }

          const existingDeals = await base44.asServiceRole.entities.Deal.filter({
            client_id: data.client_id,
            lead_id: entityId
          });

          if (existingDeals.length === 0) {
            const firstStage = configs[0]?.deal_stages?.[0]?.name || 'new';

            await base44.asServiceRole.entities.Deal.create({
              client_id: data.client_id,
              title: `Deal with ${data.name || data.phone}`,
              lead_id: entityId,
              stage: firstStage,
              source: data.source || '',
              assigned_to: data.assigned_to || '',
              status: 'open',
              probability: 30
            });
            console.log(`[CRM Automation] Auto-created deal for interested lead ${entityId}`);
          }
        }
      }
    }

    // --- CALL LOG AUTOMATIONS ---
    if (entityName === 'CallLog') {
      // Auto-create follow-up if call completed
      if (eventType === 'update' && data.status === 'completed' && old_data?.status !== 'completed') {
        if (data.client_id && data.lead_id) {
          // Only create if client has CRM
          const configs = await base44.asServiceRole.entities.CRMConfig.filter({ client_id: data.client_id });
          if (configs.length > 0) {
            const followupDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
            await base44.asServiceRole.entities.Activity.create({
              client_id: data.client_id,
              lead_id: data.lead_id,
              call_log_id: entityId,
              type: 'followup',
              title: `Follow up after call`,
              scheduled_date: followupDate,
              status: 'scheduled',
              priority: 'medium',
              auto_created: true
            });
            console.log(`[CRM Automation] Auto follow-up created after call ${entityId}`);
          }
        }
      }
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('[CRM Automation] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});