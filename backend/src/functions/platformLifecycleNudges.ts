import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Hourly cron: scans all clients and sends lifecycle nudges (Email + WhatsApp).
// Triggers (each at most once per client via LifecycleNudgeLog):
//  - welcome:        onboarding_completed=true and account_status='trial' and trial_start_date < 1.5h
//  - onboarding_d1:  onboarding_completed=false, signup ≥24h, <72h
//  - onboarding_d3:  onboarding_completed=false, signup ≥72h
//  - trial_2d / 1d / 0d: trial active, X days left
//
// HTML email always sent. WhatsApp sent only if a platform template_id is configured for that nudge.



const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const LOGO_URL = 'https://media.base44.com/images/public/698823c19043e168a5daaa86/00fe0d8ce_vaani-removebg-preview.png';
const APP_URL = 'https://app.vaaniai.io';

const THEMES = {
  welcome: { gradient: 'linear-gradient(135deg,#667eea,#764ba2)', accent: '#667eea', emoji: '🎉', label: 'Welcome' },
  onboarding: { gradient: 'linear-gradient(135deg,#f093fb,#f5576c)', accent: '#f5576c', emoji: '👋', label: 'Reminder' },
  trial_warning: { gradient: 'linear-gradient(135deg,#ffa751,#ffe259)', accent: '#f59e0b', emoji: '⏰', label: 'Trial Ending' },
};

function renderEmail({ kind, heading, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  const t = THEMES[kind] || THEMES.welcome;
  const ctaBtn = ctaLabel && ctaUrl ? `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto;"><tr><td style="background:${t.accent};border-radius:8px;"><a href="${ctaUrl}" style="display:inline-block;padding:14px 32px;color:#fff;font-weight:600;font-size:15px;text-decoration:none;">${ctaLabel}</a></td></tr></table>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:32px 16px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);"><tr><td style="background:${t.gradient};padding:40px 32px;text-align:center;"><img src="${LOGO_URL}" alt="VaaniAI" style="height:48px;margin-bottom:16px;filter:brightness(0) invert(1);"/><div style="font-size:48px;line-height:1;margin-bottom:8px;">${t.emoji}</div><div style="color:#fff;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;opacity:0.9;">${t.label}</div><h1 style="color:#fff;font-size:28px;font-weight:700;margin:8px 0 0 0;line-height:1.3;">${heading}</h1></td></tr><tr><td style="padding:40px 40px 24px 40px;color:#1f2937;font-size:16px;line-height:1.6;">${bodyHtml}${ctaBtn}</td></tr><tr><td style="padding:24px 40px 32px 40px;border-top:1px solid #e5e7eb;text-align:center;color:#6b7280;font-size:13px;line-height:1.6;">${footerNote ? `<p style="margin:0 0 12px 0;">${footerNote}</p>` : ''}<p style="margin:0;"><strong style="color:#111827;">VaaniAI</strong> · AI Voice Agents for Sales & Support<br/><a href="${APP_URL}" style="color:${t.accent};text-decoration:none;">app.vaaniai.io</a> · <a href="mailto:support@vaaniai.io" style="color:${t.accent};text-decoration:none;">support@vaaniai.io</a></p><p style="margin:12px 0 0 0;color:#9ca3af;font-size:11px;">© ${new Date().getFullYear()} VaaniAI. All rights reserved.</p></td></tr></table></td></tr></table></body></html>`;
}

function welcomeEmail(name) {
  return renderEmail({
    kind: 'welcome',
    heading: `Welcome to VaaniAI, ${name || 'there'}!`,
    bodyHtml: `<p>We're thrilled to have you on board! Your account is set up and your AI voice agent is ready to go.</p><p><strong>Here's what you can do right now:</strong></p><ul style="padding-left:20px;color:#374151;"><li>Add your first leads (CSV or Google Sheets)</li><li>Customize your voice agent's greeting and persona</li><li>Make your first AI call — it takes less than a minute</li></ul><p>You have <strong>3 days of free trial</strong> with up to <strong>10 free calls</strong>. Make them count!</p>`,
    ctaLabel: 'Open Dashboard', ctaUrl: `${APP_URL}/ClientDashboard`,
    footerNote: 'Need help? Just reply to this email — a human will respond within hours.',
  });
}

function onboardingEmail(name, day) {
  const isDay3 = day === 3;
  return renderEmail({
    kind: 'onboarding',
    heading: isDay3 ? `Don't lose your spot, ${name || 'there'}!` : 'Finish setting up — it takes 2 minutes',
    bodyHtml: `<p>Hi ${name || 'there'},</p><p>${isDay3 ? "We noticed you signed up but haven't completed your setup yet. <strong>Your trial clock is ticking</strong>." : "You signed up yesterday but haven't finished your setup yet. We saved your progress."}</p><p><strong>What you'll get when you finish:</strong></p><ul style="padding-left:20px;color:#374151;"><li>A working AI voice agent in your chosen language</li><li>A dedicated phone number to test calls</li><li>10 free trial calls to try it out</li></ul><p>It really only takes 2 minutes.</p>`,
    ctaLabel: 'Complete Onboarding →', ctaUrl: `${APP_URL}/Onboarding`,
    footerNote: "Stuck somewhere? Reply to this email and we'll walk you through it.",
  });
}

function trialEndingEmailHtml(name, daysLeft) {
  const heading = daysLeft === 0 ? 'Your trial ends today' : daysLeft === 1 ? '1 day left in your trial' : `${daysLeft} days left in your trial`;
  return renderEmail({
    kind: 'trial_warning',
    heading,
    bodyHtml: `<p>Hi ${name || 'there'},</p><p>Your free trial ${daysLeft === 0 ? 'ends today' : `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}. We hope you've enjoyed seeing what VaaniAI can do!</p><p><strong>Don't lose your data and setup</strong> — pick an option below:</p><table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0;"><tr><td width="50%" style="padding:8px;vertical-align:top;"><div style="border:2px solid #f59e0b;border-radius:12px;padding:20px;text-align:center;"><div style="font-size:14px;color:#92400e;font-weight:600;">Quick Top-up</div><div style="font-size:24px;font-weight:700;color:#111827;margin:8px 0;">₹1,000</div><div style="font-size:13px;color:#6b7280;">+5 days · Unlimited calls</div></div></td><td width="50%" style="padding:8px;vertical-align:top;"><div style="border:2px solid #10b981;border-radius:12px;padding:20px;text-align:center;"><div style="font-size:14px;color:#065f46;font-weight:600;">Full Subscription</div><div style="font-size:24px;font-weight:700;color:#111827;margin:8px 0;">₹9,999/mo</div><div style="font-size:13px;color:#6b7280;">Unlimited everything</div></div></td></tr></table>`,
    ctaLabel: 'Subscribe or Top-up Now', ctaUrl: `${APP_URL}/ClientSubscription`,
  });
}

function hoursSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / HOUR : Infinity; }
function daysUntil(iso) { if (!iso) return null; return Math.ceil((new Date(iso).getTime() - Date.now()) / DAY); }

export default async function platformLifecycleNudges(c: any) {
  const req = c.req.raw || c.req;
  try {
    // External cron auth — accept CRON_API_KEY via header, query, or body.
    const url = new URL(req.url);
    const expectedKey = Deno.env.get('CRON_API_KEY');
    const authHeader = req.headers.get('authorization') || '';
    const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
    const headerKey = req.headers.get('x-cron-key') || req.headers.get('x-api-key') || bearerKey;
    const queryKey = url.searchParams.get('secret') || url.searchParams.get('api_key') || url.searchParams.get('key');
    let bodyKey = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const b = await req.clone().json();
        bodyKey = b?.secret || b?.cron_key || null;
      } catch (_) {}
    }
    const providedKey = headerKey || queryKey || bodyKey;
    const isCron = !!(expectedKey && providedKey && providedKey === expectedKey);

    const client = base44;;
    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user || user.role !== 'admin') {
        return c.json({ data: { error: 'Forbidden — provide CRON_API_KEY' } }, 403);
      }
    }
    const base44 = client.asServiceRole;

    const cfgList = await base44.entities.PlatformMessagingConfig.list();
    const cfg = cfgList[0];
    if (cfg && cfg.lifecycle_enabled === false) {
      return c.json({ data: { skipped: 'lifecycle_disabled' } });
    }

    const clients = await base44.entities.Client.list('-created_date', 1000);
    const logs = await base44.entities.LifecycleNudgeLog.list('-created_date', 5000);
    const sentMap = new Map();
    for (const l of logs) sentMap.set(`${l.client_id}:${l.nudge_kind}`, true);

    const results = { processed: 0, welcome: 0, onboarding_d1: 0, onboarding_d3: 0, trial_2d: 0, trial_1d: 0, trial_0d: 0, skipped: 0 };

    for (const c of clients) {
      const signupHrs = hoursSince(c.created_date);
      const isTrial = c.account_status === 'trial';
      const dLeft = isTrial && c.trial_end_date ? daysUntil(c.trial_end_date) : null;

      let kind = null;
      if (c.onboarding_completed && isTrial && signupHrs <= 1.5) kind = 'welcome';
      else if (!c.onboarding_completed && signupHrs >= 24 && signupHrs < 72) kind = 'onboarding_d1';
      else if (!c.onboarding_completed && signupHrs >= 72) kind = 'onboarding_d3';
      else if (isTrial && dLeft === 2) kind = 'trial_2d';
      else if (isTrial && dLeft === 1) kind = 'trial_1d';
      else if (isTrial && dLeft === 0) kind = 'trial_0d';

      if (!kind) continue;
      if (sentMap.get(`${c.id}:${kind}`)) { results.skipped++; continue; }
      if (!c.email) { results.skipped++; continue; }

      let html = '', subject = '';
      const name = c.company_name || '';
      if (kind === 'welcome') { html = welcomeEmail(name); subject = `Welcome to VaaniAI, ${name}! 🎉`; }
      else if (kind === 'onboarding_d1') { html = onboardingEmail(name, 1); subject = 'Finish your VaaniAI setup — 2 minutes left'; }
      else if (kind === 'onboarding_d3') { html = onboardingEmail(name, 3); subject = "Don't lose your trial — finish setup"; }
      else if (kind === 'trial_2d') { html = trialEndingEmailHtml(name, 2); subject = '2 days left in your VaaniAI trial'; }
      else if (kind === 'trial_1d') { html = trialEndingEmailHtml(name, 1); subject = '1 day left — your VaaniAI trial ends tomorrow'; }
      else if (kind === 'trial_0d') { html = trialEndingEmailHtml(name, 0); subject = 'Your VaaniAI trial ends today'; }

      let emailStatus = 'failed';
      try {
        const er = await base44.functions.invoke('sendPlatformEmail', { to: c.email, subject, html, recipient_client_id: c.id });
        emailStatus = er?.data?.success ? 'sent' : 'failed';
      } catch (_) {}

      let whatsappStatus = 'skipped';
      const tplId = cfg?.[`lifecycle_${kind}_template_id`];
      if (tplId && c.phone) {
        try {
          const wr = await base44.functions.invoke('sendPlatformWhatsApp', {
            template_id: tplId, to: c.phone, variables: [name], recipient_client_id: c.id
          });
          whatsappStatus = wr?.data?.success ? 'sent' : 'failed';
        } catch (_) { whatsappStatus = 'failed'; }
      }

      await base44.entities.LifecycleNudgeLog.create({
        client_id: c.id, nudge_kind: kind,
        channels_sent: [emailStatus === 'sent' && 'email', whatsappStatus === 'sent' && 'whatsapp'].filter(Boolean),
        email_status: emailStatus, whatsapp_status: whatsappStatus
      }).catch(() => {});

      results[kind]++;
      results.processed++;
    }

    return c.json({ data: { success: true, ...results } });
  } catch (e) {
    console.error('[platformLifecycleNudges] error:', e);
    return c.json({ data: { error: e.message } }, 500);
  }

};