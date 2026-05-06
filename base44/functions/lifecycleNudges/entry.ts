import { createClient } from 'npm:@base44/sdk@0.8.25';

// Lifecycle nudges — daily cron-driven WhatsApp dispatcher for platform-managed
// onboarding / trial / payment events. NO Base44 integration credits used —
// all sends go through sendPlatformWhatsApp which calls RCS Digital directly.
//
// Trigger via cron-job.org: GET ?api_key=<CRON_API_KEY>
// Idempotent — uses OutreachLog.outreach_type+client_id+template_name to avoid duplicates.
Deno.serve(async (req) => {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronApiKey = url.searchParams.get('api_key');
      if (cronApiKey !== Deno.env.get('CRON_API_KEY')) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = createClient({ appId, asServiceRole: true });

    const cfgs = await svc.entities.PlatformMessagingConfig.list('-created_date', 1);
    if (cfgs.length === 0 || !cfgs[0].lifecycle_enabled) {
      return Response.json({ skipped: true, reason: 'Lifecycle disabled or not configured' });
    }
    const cfg = cfgs[0];
    if (cfg.whatsapp_status !== 'connected') {
      return Response.json({ skipped: true, reason: 'Platform WhatsApp not connected' });
    }
    const tmpls = cfg.lifecycle_templates || {};

    // Helper: send via internal sendPlatformWhatsApp (skips dedup if already sent)
    const sent = { welcome: 0, onboarding_d1: 0, onboarding_d3: 0, trial_2d: 0, trial_1d: 0, trial_0d: 0, errors: [] };

    const sendNudge = async ({ clientRecord, templateName, outreachType, variables }) => {
      if (!templateName) return false;
      // Find approved platform template
      const tList = await svc.entities.WhatsAppTemplate.filter({ client_id: 'PLATFORM', name: templateName, status: 'APPROVED' }, '-created_date', 1);
      if (tList.length === 0) { sent.errors.push(`No approved template: ${templateName}`); return false; }

      // Dedup — skip if already sent for this client + type + template
      const existing = await svc.entities.OutreachLog.filter({
        client_id: clientRecord.id, outreach_type: outreachType, template_name: templateName, status: 'sent'
      });
      if (existing.length > 0) return false;

      // Send via internal function
      try {
        const sendRes = await svc.functions.invoke('sendPlatformWhatsApp', {
          template_id: tList[0].id,
          to: clientRecord.phone,
          variables,
          client_id: clientRecord.id,
          outreach_type: outreachType
        });
        if (sendRes?.data?.success) return true;
        sent.errors.push(`${clientRecord.id}: ${sendRes?.data?.error || 'send failed'}`);
        return false;
      } catch (e) {
        sent.errors.push(`${clientRecord.id}: ${e.message}`);
        return false;
      }
    };

    const now = new Date();
    const daysBetween = (a, b) => Math.floor((a - b) / (1000 * 60 * 60 * 24));

    // Pull all clients (active/trial/onboarding)
    const clients = await svc.entities.Client.filter({}, '-created_date', 1000);
    for (const c of clients) {
      if (!c.phone) continue;
      const created = new Date(c.created_date);
      const daysSinceCreate = daysBetween(now, created);

      // 1) Welcome — fire on creation day (idempotent via OutreachLog dedup)
      if (daysSinceCreate === 0 && tmpls.welcome) {
        if (await sendNudge({ clientRecord: c, templateName: tmpls.welcome, outreachType: 'lifecycle_welcome', variables: [c.company_name || 'there'] })) sent.welcome++;
      }
      // 2) Onboarding D1
      if (daysSinceCreate === 1 && !c.onboarding_completed && tmpls.onboarding_d1) {
        if (await sendNudge({ clientRecord: c, templateName: tmpls.onboarding_d1, outreachType: 'lifecycle_onboarding', variables: [c.company_name || 'there'] })) sent.onboarding_d1++;
      }
      // 3) Onboarding D3
      if (daysSinceCreate === 3 && !c.onboarding_completed && tmpls.onboarding_d3) {
        if (await sendNudge({ clientRecord: c, templateName: tmpls.onboarding_d3, outreachType: 'lifecycle_onboarding', variables: [c.company_name || 'there'] })) sent.onboarding_d3++;
      }
      // 4-6) Trial expiry: 2d, 1d, 0d before trial_end_date
      if (c.trial_end_date && c.account_status === 'trial') {
        const trialEnd = new Date(c.trial_end_date);
        const daysToExpiry = daysBetween(trialEnd, now);
        if (daysToExpiry === 2 && tmpls.trial_2d) {
          if (await sendNudge({ clientRecord: c, templateName: tmpls.trial_2d, outreachType: 'lifecycle_trial', variables: [c.company_name || 'there', '2'] })) sent.trial_2d++;
        }
        if (daysToExpiry === 1 && tmpls.trial_1d) {
          if (await sendNudge({ clientRecord: c, templateName: tmpls.trial_1d, outreachType: 'lifecycle_trial', variables: [c.company_name || 'there', '1'] })) sent.trial_1d++;
        }
        if (daysToExpiry === 0 && tmpls.trial_0d) {
          if (await sendNudge({ clientRecord: c, templateName: tmpls.trial_0d, outreachType: 'lifecycle_trial', variables: [c.company_name || 'there', 'today'] })) sent.trial_0d++;
        }
      }
    }

    console.log('[lifecycleNudges] Done', sent);
    return Response.json({ success: true, ...sent });
  } catch (e) {
    console.error('[lifecycleNudges]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});