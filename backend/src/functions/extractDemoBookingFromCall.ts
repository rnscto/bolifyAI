import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Post-call fallback: if the Vaani Sales AI agreed to book a demo during the
// conversation but failed to call the book_demo tool, extract the agreed
// date/time/email from the transcript and create the booking automatically.
//
// Trigger: invoked by postCallActionExtractor for calls from the Vaani Sales agent.
// Idempotent — skips if a booking already exists for this call_log or lead.



export default async function extractDemoBookingFromCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const { call_log_id } = await c.req.json();
    if (!call_log_id) return c.json({ data: { error: 'call_log_id required' } }, 400);

    const callLog = await svc.entities.CallLog.get(call_log_id);
    if (!callLog?.transcript || callLog.transcript.length < 150) {
      return c.json({ data: { skipped: 'no_transcript' } });
    }

    // Idempotency: skip if booking already exists for this lead (recent)
    if (callLog.lead_id) {
      const existing = await svc.entities.DemoBooking.filter({ lead_id: callLog.lead_id });
      if (existing.some(b => ['scheduled', 'completed'].includes(b.status))) {
        return c.json({ data: { skipped: 'booking_already_exists' } });
      }
    }

    // Only run for the Vaani Sales agent
    const agent = callLog.agent_id ? await svc.entities.Agent.get(callLog.agent_id).catch(() => null) : null;
    if (!agent || !(agent.name || '').toLowerCase().includes('vaani sales')) {
      return c.json({ data: { skipped: 'not_vaani_sales_agent' } });
    }

    const lead = callLog.lead_id ? await svc.entities.Lead.get(callLog.lead_id).catch(() => null) : null;

    // Ask LLM to find an agreed demo booking in the transcript
    const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
    if (!baseUrl || !deployment || !apiKey) return c.json({ data: { skipped: 'llm_not_configured' } });

    const now = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const todayStr = istNow.toISOString().split('T')[0];

    const r = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `Extract a Vaani product demo booking from this sales call transcript. Today (IST) is ${todayStr}. Return JSON:
{
  "demo_agreed": true|false,
  "scheduled_at": "ISO 8601 UTC (subtract 5h30m from IST)" or null,
  "lead_email": "..." or null,
  "lead_name": "..." or null,
  "company": "..." or null,
  "focus_area": "...",
  "language": "en|hi|bilingual",
  "confidence": 0.0-1.0,
  "reason": "why or why not"
}

Rules:
- demo_agreed=true ONLY if the CUSTOMER explicitly agreed to a SPECIFIC date+time (not vague "next week").
- Only return scheduled_at if both date AND time are clear. Don't guess.
- If customer said "call me later" or "send me details" without confirming a slot, demo_agreed=false.
- confidence < 0.7 → treat as false.`
          },
          { role: 'user', content: `Transcript:\n\n${callLog.transcript}` }
        ],
        max_completion_tokens: 400,
        response_format: { type: 'json_object' }
      })
    });

    if (!r.ok) return c.json({ data: { skipped: 'llm_failed', status: r.status } });
    const data = await r.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');

    if (!parsed.demo_agreed || !parsed.scheduled_at || parsed.confidence < 0.7) {
      return c.json({ data: { skipped: 'no_agreed_booking', reason: parsed.reason } });
    }

    const email = parsed.lead_email || lead?.email;
    if (!email) return c.json({ data: { skipped: 'no_email' } });

    // Don't book in the past
    if (new Date(parsed.scheduled_at).getTime() < Date.now() + 5 * 60 * 1000) {
      return c.json({ data: { skipped: 'time_in_past' } });
    }

    const res = await svc.functions.invoke('bookDemoFromCall', {
      lead_id: callLog.lead_id || '',
      lead_name: parsed.lead_name || lead?.name || '',
      lead_email: email,
      lead_phone: lead?.phone || callLog.callee_number || '',
      company_name: parsed.company || lead?.company || '',
      focus_area: parsed.focus_area || '',
      language: parsed.language || 'bilingual',
      scheduled_at: parsed.scheduled_at,
      duration_minutes: 30
    });

    console.log(`[extractDemoBookingFromCall] ✅ Auto-booked demo for ${email} at ${parsed.scheduled_at}`);
    return c.json({ data: { success: true, booking: res?.data } });
  } catch (error) {
    console.error('extractDemoBookingFromCall error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};