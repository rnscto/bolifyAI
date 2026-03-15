import { createClient } from 'npm:@base44/sdk@0.8.20';

// Scheduled function: checks for leads with no response in 48h and creates follow-up tasks
Deno.serve(async (req) => {
  try {
    // Support external cron: allow GET requests with shared secret or CRON_API_KEY
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronSecret = url.searchParams.get('cron_secret');
      const cronApiKey = url.searchParams.get('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      console.log('[crmFollowupCheck] Triggered by external cron');
    }

    // Scheduled automation — no user session, use service role directly
    const base44 = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let createdCount = 0;

    // Get all clients with active CRM
    const clients = await base44.entities.Client.filter({ has_custom_crm: true });

    for (const client of clients) {
      // Get leads that haven't been engaged in 48h
      const leads = await base44.entities.Lead.filter({
        client_id: client.id,
        status: 'contacted'
      });

      for (const lead of leads) {
        const lastEngagement = lead.last_engagement_date || lead.last_call_date || lead.updated_date;
        if (!lastEngagement || new Date(lastEngagement) > new Date(cutoff)) continue;

        // Check if there's already a pending follow-up
        const existingActivities = await base44.entities.Activity.filter({
          client_id: client.id,
          lead_id: lead.id,
          status: 'scheduled',
          type: 'followup'
        });

        if (existingActivities.length === 0) {
          await base44.entities.Activity.create({
            client_id: client.id,
            lead_id: lead.id,
            type: 'followup',
            title: `Auto follow-up: No response from ${lead.name || lead.phone}`,
            description: 'This lead has not responded in 48 hours. Please follow up.',
            scheduled_date: new Date().toISOString(),
            status: 'scheduled',
            priority: 'high',
            assigned_to: lead.assigned_to || '',
            auto_created: true
          });
          createdCount++;
        }
      }
    }

    console.log(`[CRM Follow-up Check] Created ${createdCount} follow-up tasks`);
    return Response.json({ success: true, created: createdCount });
  } catch (error) {
    console.error('[CRM Follow-up Check] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});