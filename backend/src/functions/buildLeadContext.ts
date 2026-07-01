import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Builds a rich personalization context for AI voice calls
// Returns { context_text, lead_data } where context_text is injected into agent system prompt

export default async function buildLeadContext(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Called from other backend functions (no user session) — use service role
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = base44;;
    const { lead_id, client_id, phone_number } = await c.req.json();

    if (!lead_id && !phone_number) {
      return c.json({ data: { error: 'lead_id or phone_number required' } }, 400);
    }
    let lead = null;

    // Fetch lead by ID or by phone number
    if (lead_id) {
      try { lead = await svc.entities.Lead.get(lead_id); } catch (e) { /* ignore */ }
    }
    if (!lead && phone_number) {
      const cleanPhone = phone_number.replace(/[^0-9]/g, '').slice(-10);
      const leads = await svc.entities.Lead.filter({ client_id });
      lead = leads.find(l => l.phone && l.phone.replace(/[^0-9]/g, '').slice(-10) === cleanPhone);
    }

    if (!lead) {
      return c.json({ data: {
        success: true,
        context_text: '',
        lead_data: null,
        message: 'Lead not found'
      } });
    }

    // Fetch last 5 call logs for this lead
    const callLogs = await svc.entities.CallLog.filter(
      { lead_id: lead.id },
      '-created_date',
      5
    );

    // Build context sections
    const sections = [];

    // 1. Lead Profile
    sections.push(`CUSTOMER PROFILE:`);
    sections.push(`- Name: ${lead.name || 'Unknown'}`);
    if (lead.phone) sections.push(`- Phone: ${lead.phone}`);
    if (lead.email) sections.push(`- Email: ${lead.email}`);
    if (lead.company) sections.push(`- Company: ${lead.company}`);
    if (lead.source) sections.push(`- Lead Source: ${lead.source}`);
    if (lead.status) sections.push(`- Current Status: ${lead.status}`);

    // 2. AI Scoring & Sentiment
    if (lead.score || lead.sentiment || lead.qualification_tier) {
      sections.push(`\nLEAD INTELLIGENCE:`);
      if (lead.score) sections.push(`- Lead Score: ${lead.score}/100`);
      if (lead.sentiment) sections.push(`- Sentiment: ${lead.sentiment.replace(/_/g, ' ')}`);
      if (lead.qualification_tier) sections.push(`- Qualification: ${lead.qualification_tier.toUpperCase()}${lead.qualification_reason ? ' — ' + lead.qualification_reason : ''}`);
      if (lead.intent_signals && lead.intent_signals.length > 0) {
        sections.push(`- Intent Signals: ${lead.intent_signals.join(', ')}`);
      }
    }

    // 3. Tags & Custom Fields
    if (lead.tags && lead.tags.length > 0) {
      sections.push(`- Tags: ${lead.tags.join(', ')}`);
    }

    // 4. Notes
    if (lead.notes) {
      sections.push(`\nAGENT NOTES:\n${lead.notes}`);
    }

    // 5. Previous Call History (last 5)
    if (callLogs.length > 0) {
      sections.push(`\nPREVIOUS CALL HISTORY (last ${callLogs.length}):`);
      callLogs.forEach((cl, i) => {
        const date = cl.call_start_time ? new Date(cl.call_start_time).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unknown date';
        const duration = cl.duration ? `${Math.round(cl.duration)}s` : 'N/A';
        sections.push(`\nCall ${i + 1} — ${date} (${duration}, ${cl.status}):`);
        if (cl.conversation_summary) {
          sections.push(`  Summary: ${cl.conversation_summary}`);
        }
        if (cl.lead_status_updated) {
          sections.push(`  Outcome: ${cl.lead_status_updated}`);
        }
      });
    } else {
      sections.push(`\nPREVIOUS CALLS: None — this is the first interaction.`);
    }

    // 6. Upcoming activities/callbacks
    try {
      const activities = await svc.entities.Activity.filter(
        { lead_id: lead.id, status: 'scheduled' },
        'scheduled_date',
        3
      );
      if (activities.length > 0) {
        sections.push(`\nSCHEDULED FOLLOW-UPS:`);
        activities.forEach(a => {
          const aDate = a.scheduled_date ? new Date(a.scheduled_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
          sections.push(`- ${a.title || a.type} on ${aDate}`);
        });
      }
    } catch (e) { /* ignore */ }

    // 7. Personalization instructions for the AI
    sections.push(`\nPERSONALIZATION INSTRUCTIONS:`);
    sections.push(`- Address the customer by name: "${lead.name || 'Sir/Madam'}"`);
    if (callLogs.length > 0) {
      sections.push(`- Reference your previous conversation naturally (e.g., "As we discussed last time...")`);
      sections.push(`- Build on previous topics and concerns mentioned above`);
    }
    if (lead.sentiment === 'negative' || lead.sentiment === 'very_negative') {
      sections.push(`- Be extra empathetic and listen carefully — previous sentiment was negative`);
    }
    if (lead.qualification_tier === 'hot') {
      sections.push(`- This is a HOT lead — focus on closing and next steps`);
    }

    const contextText = sections.join('\n');

    return c.json({ data: {
      success: true,
      context_text: contextText,
      lead_data: {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        status: lead.status,
        score: lead.score,
        sentiment: lead.sentiment,
        tier: lead.qualification_tier,
        call_count: callLogs.length
      }
    } });

  } catch (error) {
    console.error('[buildLeadContext] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};