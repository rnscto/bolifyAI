import { createClient } from 'npm:@base44/sdk@0.8.20';

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

// Auto-enrolls a lead into the right email sequence based on their tier + outcome.
// If no matching sequence exists, AI generates one on-the-fly.
// Called from campaignPostCall and streamAudio via direct fetch (not functions.invoke).

Deno.serve(async (req) => {
  try {
    // ── Auth: accept either X-Internal-Secret header or CRON_API_KEY query param ──
    const internalSecret = req.headers.get('X-Internal-Secret');
    const url = new URL(req.url);
    const apiKeyParam = url.searchParams.get('api_key');
    const expectedKey = Deno.env.get('CRON_API_KEY');
    if (expectedKey && internalSecret !== expectedKey && apiKeyParam !== expectedKey) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    // ── CRON MODE (GET): Batch-scan leads that need enrollment ──
    if (req.method === 'GET') {
      console.log('[autoEnrollSequence] Triggered by cron — batch scan mode');
      const results = { enrolled: 0, skipped: 0, errors: 0 };
      const BATCH_LIMIT = 20;

      // Find leads with a qualification tier, email, and that were recently scored
      const tiers = ['hot', 'warm', 'nurture', 'cold'];
      for (const tier of tiers) {
        const leads = await base44.entities.Lead.filter({ qualification_tier: tier }, '-updated_date', 50);
        for (const lead of leads) {
          if (results.enrolled >= BATCH_LIMIT) break;
          if (!lead.email || !lead.client_id) { results.skipped++; continue; }
          if (lead.status === 'do_not_call') { results.skipped++; continue; }

          // Check if already enrolled in an active sequence
          const existing = await base44.entities.SequenceEnrollment.filter({ lead_id: lead.id, status: 'active' });
          if (existing.length > 0) { results.skipped++; continue; }

          // Check if already enrolled and completed recently (within 30 days)
          const completed = await base44.entities.SequenceEnrollment.filter({ lead_id: lead.id, status: 'completed' });
          const recentlyCompleted = completed.some(e => {
            const enrolled = new Date(e.enrolled_date || e.created_date);
            return (Date.now() - enrolled.getTime()) < 30 * 86400000;
          });
          if (recentlyCompleted) { results.skipped++; continue; }

          // Enroll this lead
          try {
            let client = null;
            try { client = await base44.entities.Client.get(lead.client_id); } catch (_) {}
            if (!client) {
              console.log(`[autoEnrollSequence] Skipped lead ${lead.id}: client ${lead.client_id} not found`);
              results.skipped++;
              continue;
            }
            const companyName = client?.company_name || 'Our Company';
            const industry = client?.industry || 'General';
            const tierOutreachMap = { hot: 'lead_followup', warm: 'lead_followup', nurture: 're_engagement', cold: 're_engagement' };
            const outreachType = tierOutreachMap[tier] || 'lead_followup';

            // Find sequence
            let sequence = null;
            const clientSeqs = await base44.entities.EmailSequence.filter({ client_id: lead.client_id, tier_target: tier, status: 'active' });
            if (clientSeqs.length > 0) sequence = clientSeqs[0];
            if (!sequence) {
              const globalSeqs = await base44.entities.EmailSequence.filter({ tier_target: tier, status: 'active' });
              const global = globalSeqs.filter(s => !s.client_id);
              if (global.length > 0) sequence = global[0];
            }
            if (!sequence) {
              sequence = await generateTierSequence(base44, tier, outreachType, companyName, industry, lead.client_id);
            }
            if (!sequence || !sequence.steps || sequence.steps.length === 0) { results.skipped++; continue; }

            const firstStep = sequence.steps[0];
            const nextSend = new Date();
            nextSend.setDate(nextSend.getDate() + (firstStep?.delay_days || 1));

            await base44.entities.SequenceEnrollment.create({
              sequence_id: sequence.id, client_id: lead.client_id, lead_id: lead.id,
              recipient_email: lead.email, recipient_name: lead.name || '',
              status: 'active', current_step: 0, steps_completed: 0,
              total_steps: sequence.steps.length, next_send_date: nextSend.toISOString(),
              enrolled_date: new Date().toISOString(), qualification_tier: tier,
              call_outcome: '', call_summary: (lead.notes || '').substring(0, 500),
              call_topics: lead.tags || [], objections: [],
              intent_signals: lead.intent_signals || [], send_log: []
            });

            await base44.entities.EmailSequence.update(sequence.id, { total_enrolled: (sequence.total_enrolled || 0) + 1 });
            const existingActions = lead.auto_actions_taken || [];
            await base44.entities.Lead.update(lead.id, { auto_actions_taken: [...existingActions, `sequence_enrolled:${sequence.name}`] });

            results.enrolled++;
            console.log(`[autoEnrollSequence] ✅ Batch enrolled ${lead.name || lead.email} → "${sequence.name}"`);
          } catch (e) {
            console.error(`[autoEnrollSequence] Batch error for lead ${lead.id}: ${e.message}`);
            results.errors++;
          }
        }
        if (results.enrolled >= BATCH_LIMIT) break;
      }

      console.log(`[autoEnrollSequence] Batch done. Enrolled: ${results.enrolled}, Skipped: ${results.skipped}, Errors: ${results.errors}`);
      return Response.json({ success: true, mode: 'batch', ...results });
    }

    // ── DIRECT MODE (POST): Single lead enrollment from campaignPostCall ──
    const {
      lead_id, client_id, qualification_tier, call_outcome,
      call_summary, call_topics, objections, intent_signals, ai_score
    } = await req.json();

    if (!lead_id || !client_id || !qualification_tier) {
      return Response.json({ error: 'Missing lead_id, client_id, or qualification_tier' }, { status: 400 });
    }

    // Skip disqualified / do_not_call
    if (qualification_tier === 'disqualified' || call_outcome === 'do_not_call') {
      return Response.json({ success: true, skipped: 'disqualified' });
    }

    // Get lead
    const lead = await base44.entities.Lead.get(lead_id);
    if (!lead?.email) {
      return Response.json({ success: true, skipped: 'no_email' });
    }

    // Check if lead is already enrolled in an active sequence for this client
    const existingEnrollments = await base44.entities.SequenceEnrollment.filter({
      lead_id: lead_id, status: 'active'
    });
    if (existingEnrollments.length > 0) {
      console.log(`[autoEnrollSequence] Lead ${lead.name} already in active sequence, skipping`);
      return Response.json({ success: true, skipped: 'already_enrolled', sequence_id: existingEnrollments[0].sequence_id });
    }

    // Get client info for personalization
    const client = await base44.entities.Client.get(client_id);
    const companyName = client?.company_name || 'Our Company';
    const industry = client?.industry || 'General';

    // Map tier to outreach type
    const tierOutreachMap = {
      hot: 'lead_followup',
      warm: 'lead_followup',
      nurture: 're_engagement',
      cold: 're_engagement'
    };
    const outreachType = tierOutreachMap[qualification_tier] || 'lead_followup';

    // Try to find existing active sequence matching tier + client
    let sequence = null;
    const clientSequences = await base44.entities.EmailSequence.filter({
      client_id: client_id, tier_target: qualification_tier, status: 'active'
    });
    if (clientSequences.length > 0) {
      sequence = clientSequences[0];
      console.log(`[autoEnrollSequence] Found existing sequence: "${sequence.name}" for tier ${qualification_tier}`);
    }

    // If no client-specific sequence, try global ones
    if (!sequence) {
      const globalSequences = await base44.entities.EmailSequence.filter({
        tier_target: qualification_tier, status: 'active'
      });
      // Filter to those without a client_id (truly global)
      const global = globalSequences.filter(s => !s.client_id);
      if (global.length > 0) {
        sequence = global[0];
        console.log(`[autoEnrollSequence] Found global sequence: "${sequence.name}" for tier ${qualification_tier}`);
      }
    }

    // If still no sequence, AI-generate one
    if (!sequence) {
      console.log(`[autoEnrollSequence] No sequence for tier ${qualification_tier}, generating with AI...`);
      sequence = await generateTierSequence(base44, qualification_tier, outreachType, companyName, industry, client_id);
    }

    if (!sequence || !sequence.steps || sequence.steps.length === 0) {
      return Response.json({ success: true, skipped: 'no_valid_sequence' });
    }

    // Enroll the lead
    const firstStep = sequence.steps[0];
    const nextSend = new Date();
    nextSend.setDate(nextSend.getDate() + (firstStep?.delay_days || 1));

    const enrollment = await base44.entities.SequenceEnrollment.create({
      sequence_id: sequence.id,
      client_id: client_id,
      lead_id: lead_id,
      recipient_email: lead.email,
      recipient_name: lead.name || '',
      status: 'active',
      current_step: 0,
      steps_completed: 0,
      total_steps: sequence.steps.length,
      next_send_date: nextSend.toISOString(),
      enrolled_date: new Date().toISOString(),
      qualification_tier: qualification_tier,
      call_outcome: call_outcome || '',
      call_summary: (call_summary || '').substring(0, 500),
      call_topics: call_topics || [],
      objections: objections || [],
      intent_signals: intent_signals || [],
      send_log: []
    });

    // Update sequence enrollment count
    await base44.entities.EmailSequence.update(sequence.id, {
      total_enrolled: (sequence.total_enrolled || 0) + 1
    });

    // Update lead auto_actions_taken
    const existingActions = lead.auto_actions_taken || [];
    await base44.entities.Lead.update(lead_id, {
      auto_actions_taken: [...existingActions, `sequence_enrolled:${sequence.name}`]
    });

    console.log(`[autoEnrollSequence] ✅ Enrolled ${lead.name || lead.email} in "${sequence.name}" (${sequence.steps.length} steps)`);

    return Response.json({
      success: true,
      enrolled: true,
      sequence_name: sequence.name,
      sequence_id: sequence.id,
      enrollment_id: enrollment.id,
      total_steps: sequence.steps.length,
      first_send: nextSend.toISOString()
    });

  } catch (error) {
    console.error('[autoEnrollSequence] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});


// =====================================================
// AI-GENERATE a tier-specific email sequence
// =====================================================
async function generateTierSequence(base44, tier, outreachType, companyName, industry, clientId) {
  const tierConfig = {
    hot: {
      name: `Hot Lead Nurture - ${companyName}`,
      description: 'Aggressive follow-up for highly interested leads',
      stepCount: 4,
      delays: [0, 1, 3, 5],
      tone: 'Urgent, enthusiastic, value-focused. These leads are very interested — push for conversion.',
      focus: 'demo booking, pricing discussion, proposal, closing'
    },
    warm: {
      name: `Warm Lead Engagement - ${companyName}`,
      description: 'Steady nurturing for moderately interested leads',
      stepCount: 5,
      delays: [1, 3, 5, 8, 12],
      tone: 'Warm, educational, consultative. Build trust and demonstrate value.',
      focus: 'case studies, benefits, social proof, soft CTA'
    },
    nurture: {
      name: `Lead Nurture Drip - ${companyName}`,
      description: 'Long-term nurturing for low-engagement leads',
      stepCount: 6,
      delays: [2, 5, 10, 18, 28, 40],
      tone: 'Informative, non-pushy, educational. Stay top of mind without being annoying.',
      focus: 'industry insights, helpful content, gentle re-engagement, success stories'
    },
    cold: {
      name: `Re-engagement - ${companyName}`,
      description: 'Re-engagement for cold leads',
      stepCount: 3,
      delays: [3, 10, 25],
      tone: 'Fresh approach, different angle. Acknowledge previous interaction. Low pressure.',
      focus: 'new angle, updated offerings, industry news, final check-in'
    }
  };

  const config = tierConfig[tier] || tierConfig.nurture;

  try {
    const result = await azureLLM(
      `Generate a ${config.stepCount}-step email nurture sequence for ${companyName} (Industry: ${industry}).

TARGET: "${tier}" qualification tier leads
TONE: ${config.tone}
FOCUS: ${config.focus}
SEQUENCE NAME: ${config.name}

For each step, generate:
- subject: compelling email subject line
- body_html: email body in HTML (just content, no html/head tags). Use {{name}} for recipient name, {{company}} for company name. Keep each email under 150 words.
- delay_days: ${config.delays.join(', ')} (for steps 1-${config.stepCount} respectively)

IMPORTANT:
- Each email should build on the previous
- Step 1: introduce/remind about the conversation
- Middle steps: provide value, address common objections, share proof points
- Last step: create urgency or gentle farewell
- Professional Indian business English
- Include clear CTA in each email
- All emails should feel like they come from a real person, not automated`,
      'You are an email sequence generator. Always respond in valid JSON.',
      { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" }, delay_days: { type: "number" } } } } } }
    );

    const steps = (result.steps || []).map((s, i) => ({
      step_number: i + 1,
      delay_days: s.delay_days || config.delays[i] || (i + 1) * 2,
      subject: s.subject || `Follow-up ${i + 1}`,
      body_html: s.body_html || '',
      use_ai_personalization: true
    }));

    if (steps.length === 0) return null;

    const newSequence = await base44.entities.EmailSequence.create({
      name: config.name,
      outreach_type: outreachType,
      description: config.description,
      status: 'active',
      tier_target: tier,
      auto_generated: true,
      client_id: clientId,
      steps: steps,
      total_enrolled: 0,
      total_completed: 0,
      total_opted_out: 0
    });

    console.log(`[autoEnrollSequence] 🤖 AI-generated sequence "${config.name}" with ${steps.length} steps`);
    return newSequence;

  } catch (err) {
    console.error(`[autoEnrollSequence] AI sequence generation failed: ${err.message}`);
    return null;
  }
}