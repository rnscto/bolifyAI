import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

const connStr = `endpoint=${Deno.env.get('AZURE_COMM_ENDPOINT')};accesskey=${Deno.env.get('AZURE_COMM_KEY')}`;
const emailClient = new EmailClient(connStr);

async function sendEmail({ to, subject, html }) {
  const message = {
    senderAddress: 'DoNotReply@vaaniai.io',
    displayName: 'VaaniAI Tasks',
    content: { subject, html },
    recipients: { to: [{ address: to }] }
  };
  const poller = await emailClient.beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') throw new Error(`Email error: ${result.error?.message || result.status}`);
  return result;
}

// Daily digest: emails each client admin about pending tasks requiring human attention
Deno.serve(async (req) => {
  try {
    // Auth: cron or admin
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronKey = url.searchParams.get('api_key') || url.searchParams.get('cron_secret');
      const expected = Deno.env.get('CRON_API_KEY') || Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      if (!expected || cronKey !== expected) return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const base44_client = createClientFromRequest(req);
    const svc = base44_client.asServiceRole;

    const humanTypes = ['email', 'task', 'demo', 'visit', 'meeting', 'appointment', 'booking'];

    // Fetch all pending human-attention activities
    const [scheduledActs, overdueActs] = await Promise.all([
      svc.entities.Activity.filter({ status: 'scheduled' }, 'scheduled_date', 500),
      svc.entities.Activity.filter({ status: 'overdue' }, 'scheduled_date', 500),
    ]);

    const allPending = [...scheduledActs, ...overdueActs].filter(a => humanTypes.includes(a.type));

    if (allPending.length === 0) {
      console.log('[dailyTaskDigest] No pending human tasks — skipping');
      return Response.json({ success: true, emails_sent: 0, reason: 'no_pending_tasks' });
    }

    // Group by client_id
    const byClient = {};
    for (const act of allPending) {
      const cid = act.client_id || 'unknown';
      if (!byClient[cid]) byClient[cid] = [];
      byClient[cid].push(act);
    }

    let emailsSent = 0;

    for (const [clientId, tasks] of Object.entries(byClient)) {
      let client = null;
      try { client = await svc.entities.Client.get(clientId); } catch (_) { continue; }
      if (!client?.email) continue;

      // Load lead names for each task
      const leadCache = {};
      for (const t of tasks) {
        if (t.lead_id && !leadCache[t.lead_id]) {
          try { leadCache[t.lead_id] = await svc.entities.Lead.get(t.lead_id); } catch (_) {}
        }
      }

      const overdueTasks = tasks.filter(t => t.status === 'overdue');
      const scheduledTasks = tasks.filter(t => t.status === 'scheduled');

      const overdueCount = overdueTasks.length;
      const pendingCount = scheduledTasks.length;

      const taskRows = tasks.sort((a, b) => {
        if (a.status === 'overdue' && b.status !== 'overdue') return -1;
        if (b.status === 'overdue' && a.status !== 'overdue') return 1;
        return new Date(a.scheduled_date) - new Date(b.scheduled_date);
      }).map(t => {
        const lead = leadCache[t.lead_id];
        const isOverdue = t.status === 'overdue';
        const scheduledIST = new Date(t.scheduled_date).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        const typeLabel = t.type.charAt(0).toUpperCase() + t.type.slice(1);
        const priorityColor = t.priority === 'high' ? '#dc2626' : t.priority === 'medium' ? '#f59e0b' : '#6b7280';

        return `<tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:10px 8px;">
            ${isOverdue ? '<span style="display:inline-block;background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">OVERDUE</span>' : '<span style="display:inline-block;background:#eff6ff;color:#2563eb;padding:2px 8px;border-radius:10px;font-size:11px;">Pending</span>'}
          </td>
          <td style="padding:10px 8px;">
            <span style="display:inline-block;background:#f3f4f6;padding:2px 8px;border-radius:6px;font-size:12px;color:#374151;">${typeLabel}</span>
          </td>
          <td style="padding:10px 8px;font-weight:500;color:#1e293b;font-size:13px;">${t.title || t.type}</td>
          <td style="padding:10px 8px;color:#64748b;font-size:13px;">${lead?.name || '—'}</td>
          <td style="padding:10px 8px;color:#64748b;font-size:12px;">${lead?.phone || '—'}</td>
          <td style="padding:10px 8px;font-size:12px;color:${priorityColor};font-weight:600;">${(t.priority || 'medium').toUpperCase()}</td>
          <td style="padding:10px 8px;color:#64748b;font-size:12px;">${scheduledIST}</td>
        </tr>`;
      }).join('');

      const html = `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:24px 30px;border-radius:12px 12px 0 0;">
          <h2 style="color:white;margin:0;">📋 Daily Task Digest</h2>
          <p style="color:#bfdbfe;margin:6px 0 0;font-size:14px;">${client.company_name} — ${new Date().toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' })}</p>
        </div>

        <div style="padding:24px 30px;background:white;border:1px solid #e2e8f0;border-top:none;">
          <div style="display:flex;gap:16px;margin-bottom:20px;">
            <div style="flex:1;padding:16px;background:#fef2f2;border-radius:10px;text-align:center;">
              <div style="font-size:28px;font-weight:700;color:#dc2626;">${overdueCount}</div>
              <div style="font-size:12px;color:#991b1b;margin-top:2px;">Overdue</div>
            </div>
            <div style="flex:1;padding:16px;background:#eff6ff;border-radius:10px;text-align:center;">
              <div style="font-size:28px;font-weight:700;color:#2563eb;">${pendingCount}</div>
              <div style="font-size:12px;color:#1e40af;margin-top:2px;">Pending</div>
            </div>
            <div style="flex:1;padding:16px;background:#f0fdf4;border-radius:10px;text-align:center;">
              <div style="font-size:28px;font-weight:700;color:#16a34a;">${tasks.length}</div>
              <div style="font-size:12px;color:#166534;margin-top:2px;">Total</div>
            </div>
          </div>

          <p style="color:#64748b;font-size:14px;margin:0 0 16px;">These tasks require your attention. Update their status in the <strong>Callbacks</strong> page.</p>

          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:10px 8px;text-align:left;color:#64748b;font-weight:600;font-size:11px;">STATUS</th>
                <th style="padding:10px 8px;text-align:left;color:#64748b;font-weight:600;font-size:11px;">TYPE</th>
                <th style="padding:10px 8px;text-align:left;color:#64748b;font-weight:600;font-size:11px;">TASK</th>
                <th style="padding:10px 8px;text-align:left;color:#64748b;font-weight:600;font-size:11px;">LEAD</th>
                <th style="padding:10px 8px;text-align:left;color:#64748b;font-weight:600;font-size:11px;">PHONE</th>
                <th style="padding:10px 8px;text-align:left;color:#64748b;font-weight:600;font-size:11px;">PRIORITY</th>
                <th style="padding:10px 8px;text-align:left;color:#64748b;font-weight:600;font-size:11px;">SCHEDULED</th>
              </tr>
            </thead>
            <tbody>${taskRows}</tbody>
          </table>
        </div>

        <div style="padding:16px 30px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">VaaniAI Automation Engine — Daily Task Digest</p>
        </div>
      </div>`;

      try {
        await sendEmail({
          to: client.email,
          subject: `[VaaniAI] ${overdueCount > 0 ? `⚠️ ${overdueCount} Overdue + ` : ''}${pendingCount} Pending Tasks — Action Required`,
          html
        });
        emailsSent++;
        console.log(`[dailyTaskDigest] ✅ Digest sent to ${client.email}: ${overdueCount} overdue, ${pendingCount} pending`);
      } catch (e) {
        console.error(`[dailyTaskDigest] Email failed for ${client.email}: ${e.message}`);
      }
    }

    return Response.json({ success: true, emails_sent: emailsSent, clients_processed: Object.keys(byClient).length });
  } catch (error) {
    console.error('[dailyTaskDigest] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});