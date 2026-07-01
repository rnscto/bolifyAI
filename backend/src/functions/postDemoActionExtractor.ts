import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Triggered when a DemoBooking transitions to status='completed' (entity automation).
// Generates an AI summary from the transcript, classifies the outcome, creates a Lead
// (if one doesn't exist for this email yet), and notifies the sales team.
//
// Idempotent: bails out if ai_summary is already set.



const OUTCOME_VALUES = ['very_interested', 'interested', 'follow_up_needed', 'not_interested', 'needs_human'];

async function aiSummarize(base44, transcript, booking) {
  if (!transcript || transcript.trim().length < 30) {
    return {
      summary: 'Demo ended with insufficient conversation to summarize.',
      outcome: 'follow_up_needed',
      key_points: [],
      buying_signals: [],
      objections: [],
      next_steps: 'Manual outreach recommended.'
    };
  }

  const prompt = `You are analyzing a transcript of a product demo conducted by Vaani AI (an Indian AI voice-agent platform) for a prospect.

# Demo context
- Prospect: ${booking.lead_name || 'Unknown'} from ${booking.company_name || 'Unknown'}
- Industry: ${booking.industry || 'Unknown'}
- Team size: ${booking.team_size || 'Unknown'}
- They wanted to see: ${booking.focus_area || 'general capabilities'}
- Duration: ${booking.duration_seconds ? Math.round(booking.duration_seconds / 60) + ' min' : 'unknown'}

# Transcript
${transcript.substring(0, 12000)}

# Your task
Analyze this demo and return a STRICT JSON object with:
- summary: 2-3 sentence executive summary
- outcome: ONE of [very_interested, interested, follow_up_needed, not_interested, needs_human] — pick the most fitting
- key_points: array of 3-5 bullet points covering what was discussed
- buying_signals: array of explicit interest signals (e.g. "asked about pricing", "wants to start trial Monday"). Empty array if none.
- objections: array of concerns raised (e.g. "worried about Hindi accuracy", "needs CRM integration"). Empty array if none.
- next_steps: ONE concrete recommended action for the sales team (e.g. "Send proposal with pricing for 5 channels", "Schedule technical call with their CTO").`;

  const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
    prompt,
    response_json_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        outcome: { type: 'string', enum: OUTCOME_VALUES },
        key_points: { type: 'array', items: { type: 'string' } },
        buying_signals: { type: 'array', items: { type: 'string' } },
        objections: { type: 'array', items: { type: 'string' } },
        next_steps: { type: 'string' }
      },
      required: ['summary', 'outcome']
    }
  });

  return result;
}

function buildSalesNotificationHtml({ booking, analysis }) {
  const outcomeColor = {
    very_interested: '#16a34a',
    interested: '#3b82f6',
    follow_up_needed: '#f59e0b',
    not_interested: '#6b7280',
    needs_human: '#dc2626'
  }[analysis.outcome] || '#3b82f6';

  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#1e3a5f,#3b82f6);color:#fff;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">🎯 Demo Completed — Follow-up Required</h2>
        <p style="margin:6px 0 0;opacity:.9">${booking.booking_code}</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 8px 8px">
        <table style="width:100%;font-size:14px">
          <tr><td><b>Lead:</b></td><td>${booking.lead_name || '—'}</td></tr>
          <tr><td><b>Email:</b></td><td>${booking.lead_email}</td></tr>
          <tr><td><b>Phone:</b></td><td>${booking.lead_phone || '—'}</td></tr>
          <tr><td><b>Company:</b></td><td>${booking.company_name || '—'}</td></tr>
          <tr><td><b>Duration:</b></td><td>${booking.duration_seconds ? Math.round(booking.duration_seconds / 60) + ' min' : '—'}</td></tr>
          <tr><td><b>Outcome:</b></td><td><span style="background:${outcomeColor};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${analysis.outcome.replace(/_/g, ' ').toUpperCase()}</span></td></tr>
        </table>

        <div style="margin:18px 0;padding:14px;background:#f8fafc;border-left:4px solid ${outcomeColor};border-radius:4px">
          <p style="margin:0;font-weight:600;color:#1e3a5f">Summary</p>
          <p style="margin:6px 0 0;color:#374151">${analysis.summary}</p>
        </div>

        ${analysis.buying_signals?.length ? `
          <div style="margin:14px 0">
            <p style="margin:0 0 6px;font-weight:600;color:#16a34a">✓ Buying signals</p>
            <ul style="margin:0;padding-left:20px;color:#374151">
              ${analysis.buying_signals.map(s => `<li>${s}</li>`).join('')}
            </ul>
          </div>` : ''}

        ${analysis.objections?.length ? `
          <div style="margin:14px 0">
            <p style="margin:0 0 6px;font-weight:600;color:#dc2626">⚠ Objections</p>
            <ul style="margin:0;padding-left:20px;color:#374151">
              ${analysis.objections.map(o => `<li>${o}</li>`).join('')}
            </ul>
          </div>` : ''}

        <div style="margin:14px 0;padding:14px;background:#eff6ff;border-radius:4px">
          <p style="margin:0;font-weight:600;color:#1e3a5f">→ Recommended next step</p>
          <p style="margin:6px 0 0;color:#374151">${analysis.next_steps || 'Reach out to discuss next steps.'}</p>
        </div>

        ${analysis.key_points?.length ? `
          <details style="margin-top:14px">
            <summary style="cursor:pointer;font-weight:600;color:#6b7280">Key discussion points</summary>
            <ul style="margin:8px 0 0;padding-left:20px;color:#6b7280;font-size:13px">
              ${analysis.key_points.map(p => `<li>${p}</li>`).join('')}
            </ul>
          </details>` : ''}
      </div>
    </div>`;
}

export default async function postDemoActionExtractor(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const body = await c.req.json().catch(() => ({}));

    // Entity automation payload — pull booking
    const event = body.event || {};
    const bookingId = event.entity_id || body.booking_id;
    if (!bookingId) return c.json({ data: { error: 'no booking_id' } }, 400);

    const booking = await svc.entities.DemoBooking.get(bookingId).catch(() => null);
    if (!booking) return c.json({ data: { error: 'booking not found' } }, 404);

    // Only run on completed
    if (booking.status !== 'completed') {
      return c.json({ data: { skipped: 'not completed', status: booking.status } });
    }
    // Idempotency
    if (booking.ai_summary) {
      return c.json({ data: { skipped: 'already summarized' } });
    }

    // 1. Generate AI summary
    const analysis = await aiSummarize(base44, booking.transcript || '', booking);

    // 2. Update booking
    await svc.entities.DemoBooking.update(bookingId, {
      ai_summary: analysis.summary,
      outcome: analysis.outcome,
      notes: [
        analysis.next_steps ? `Next: ${analysis.next_steps}` : '',
        analysis.buying_signals?.length ? `Signals: ${analysis.buying_signals.join('; ')}` : '',
        analysis.objections?.length ? `Objections: ${analysis.objections.join('; ')}` : ''
      ].filter(Boolean).join('\n')
    });

    // 3. Auto-create Lead if none exists for this email
    let leadId = booking.lead_id;
    if (!leadId && booking.lead_email) {
      const existing = await svc.entities.Lead.filter({ email: booking.lead_email }).catch(() => []);
      if (existing.length === 0) {
        const newLead = await svc.entities.Lead.create({
          name: booking.lead_name || booking.lead_email.split('@')[0],
          email: booking.lead_email,
          phone: booking.lead_phone || '',
          company: booking.company_name || '',
          source: 'demo_booking',
          status: analysis.outcome === 'very_interested' ? 'qualified' : 'new',
          notes: `Auto-created from completed demo ${booking.booking_code}.\nOutcome: ${analysis.outcome}\nSummary: ${analysis.summary}`
        }).catch(e => { console.error('Lead create failed:', e?.message); return null; });
        if (newLead) {
          leadId = newLead.id;
          await svc.entities.DemoBooking.update(bookingId, { lead_id: leadId });
        }
      } else {
        leadId = existing[0].id;
        await svc.entities.DemoBooking.update(bookingId, { lead_id: leadId });
      }
    }

    // 4. Notify sales reps
    if (booking.cc_sales_emails?.length) {
      const html = buildSalesNotificationHtml({ booking, analysis });
      await svc.functions.invoke('sendAcsSmtpEmail', {
        to: booking.cc_sales_emails,
        subject: `[Demo ${analysis.outcome.replace(/_/g, ' ').toUpperCase()}] ${booking.lead_name || booking.lead_email} — ${booking.company_name || ''}`,
        html,
        from_name: 'Vaani AI'
      }).catch(e => console.error('Sales notify failed:', e?.message));
    }

    return c.json({ data: { success: true, outcome: analysis.outcome, lead_id: leadId } });
  } catch (error) {
    console.error('postDemoActionExtractor error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};