import { createClient } from 'npm:@base44/sdk@0.8.18';

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

// Scheduled automation — runs every 30 min, no user session.
// Uses service role directly (only platform scheduler invokes this).

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const results = { sent: 0, skipped: 0, completed: 0, errors: 0, adapted: 0 };

    // Get all active sequences
    const sequences = await base44.entities.EmailSequence.filter({ status: 'active' });
    if (sequences.length === 0) {
      return Response.json({ success: true, message: 'No active sequences', ...results });
    }

    const sequenceMap = {};
    sequences.forEach(s => { sequenceMap[s.id] = s; });

    // Get all active enrollments
    const activeEnrollments = await base44.entities.SequenceEnrollment.filter({ status: 'active' });

    for (const enrollment of activeEnrollments) {
      // Check if it's time to send
      if (!enrollment.next_send_date || new Date(enrollment.next_send_date) > new Date()) {
        results.skipped++;
        continue;
      }

      const sequence = sequenceMap[enrollment.sequence_id];
      if (!sequence) { results.skipped++; continue; }

      const stepIndex = enrollment.steps_completed || 0;
      const steps = sequence.steps || [];

      if (stepIndex >= steps.length) {
        await base44.entities.SequenceEnrollment.update(enrollment.id, { status: 'completed' });
        await base44.entities.EmailSequence.update(sequence.id, {
          total_completed: (sequence.total_completed || 0) + 1
        });
        results.completed++;
        continue;
      }

      const step = steps[stepIndex];
      let subject = step.subject || 'Follow-up';
      let bodyHtml = step.body_html || '';

      // Replace placeholders
      subject = subject.replace(/\{\{name\}\}/g, enrollment.recipient_name || 'there');
      bodyHtml = bodyHtml.replace(/\{\{name\}\}/g, enrollment.recipient_name || 'there');

      // ============================================================
      // AI DYNAMIC CONTENT ADAPTATION
      // Uses call context (topics, objections, intent signals) to
      // personalize each email based on the actual conversation
      // ============================================================
      if (step.use_ai_personalization) {
        try {
          // Build rich context from enrollment + lead data
          let contextParts = [];

          if (enrollment.lead_id) {
            try {
              const lead = await base44.entities.Lead.get(enrollment.lead_id);
              contextParts.push(`Lead: ${lead.name || ''}, Company: ${lead.company || ''}, Status: ${lead.status || ''}, Score: ${lead.score || 'N/A'}/100, Tier: ${lead.qualification_tier || 'N/A'}`);
              if (lead.notes) contextParts.push(`Recent Notes: ${lead.notes.substring(0, 300)}`);
              if (lead.intent_signals?.length > 0) contextParts.push(`Intent Signals: ${lead.intent_signals.join(', ')}`);
              if (lead.sentiment) contextParts.push(`Sentiment: ${lead.sentiment}`);
            } catch (_) {}
          }

          if (enrollment.client_id) {
            try {
              const client = await base44.entities.Client.get(enrollment.client_id);
              contextParts.push(`Company: ${client.company_name || ''}, Industry: ${client.industry || ''}`);
            } catch (_) {}
          }

          // Enrollment-specific call context
          if (enrollment.call_summary) contextParts.push(`Call Summary: ${enrollment.call_summary}`);
          if (enrollment.call_topics?.length > 0) contextParts.push(`Topics Discussed: ${enrollment.call_topics.join(', ')}`);
          if (enrollment.objections?.length > 0) contextParts.push(`Objections Raised: ${enrollment.objections.join(', ')}`);
          if (enrollment.intent_signals?.length > 0) contextParts.push(`Lead Intent: ${enrollment.intent_signals.join(', ')}`);
          if (enrollment.qualification_tier) contextParts.push(`Qualification: ${enrollment.qualification_tier} lead`);

          // Previous sends context
          const prevSends = enrollment.send_log || [];
          if (prevSends.length > 0) {
            contextParts.push(`Previous Emails Sent: ${prevSends.map(s => `Step ${s.step_number}: "${s.subject}"`).join('; ')}`);
          }

          const context = contextParts.join('\n');

          if (context.length > 20) {
            const personalized = await azureLLM(
              `Dynamically adapt this nurture email using the lead's context below.

ORIGINAL SUBJECT: ${subject}
ORIGINAL BODY: ${bodyHtml}

LEAD CONTEXT:
${context}

STEP ${stepIndex + 1} of ${steps.length} — ${enrollment.qualification_tier || 'unknown'} tier lead.

ADAPTATION RULES:
1. If the lead raised specific objections, address them naturally in the email
2. If topics like "pricing" or "demo" were discussed, reference those specifically
3. Reference the lead's company/industry if known
4. Adjust urgency: hot leads get stronger CTAs, nurture leads get softer CTAs
5. If this is a later step (3+), escalate value proposition or try a new angle
6. Keep the core message but make it feel personally written
7. Keep it under 150 words
8. Professional Indian business English
9. Return HTML body content only (no html/head tags)

Return the adapted subject and body_html.`,
              'You are an email personalization expert. Always respond in valid JSON.',
              { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" } } }
            );
            subject = personalized.subject || subject;
            bodyHtml = personalized.body_html || bodyHtml;
            results.adapted++;
          }
        } catch (aiErr) {
          console.warn(`[processSequences] AI adaptation failed for ${enrollment.id}: ${aiErr.message}`);
        }
      }

      // Final placeholder replacement (in case AI output still has them)
      subject = subject.replace(/\{\{name\}\}/g, enrollment.recipient_name || 'there');
      bodyHtml = bodyHtml.replace(/\{\{name\}\}/g, enrollment.recipient_name || 'there');

      // Determine sender
      let fromName = 'VaaniAI';
      if (enrollment.client_id) {
        try {
          const client = await base44.entities.Client.get(enrollment.client_id);
          if (client?.company_name) fromName = client.company_name;
        } catch (_) {}
      }

      // Send the email
      try {
        await base44.integrations.Core.SendEmail({
          to: enrollment.recipient_email,
          from_name: fromName,
          subject,
          body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">${bodyHtml}</div>`
        });

        // Log in OutreachLog
        await base44.integrations.Core.InvokeLLM; // no-op check
        await base44.entities.OutreachLog.create({
          client_id: enrollment.client_id || '',
          lead_id: enrollment.lead_id || '',
          channel: 'email',
          recipient_email: enrollment.recipient_email,
          subject,
          body: bodyHtml,
          outreach_type: sequence.outreach_type || 'lead_followup',
          status: 'sent',
          is_retention: sequence.outreach_type === 'retention'
        });

        // Update enrollment
        const sendLog = enrollment.send_log || [];
        sendLog.push({
          step_number: stepIndex + 1,
          sent_date: new Date().toISOString(),
          status: 'sent',
          subject
        });

        const nextStepIndex = stepIndex + 1;
        const isLast = nextStepIndex >= steps.length;
        const nextStep = !isLast ? steps[nextStepIndex] : null;
        const nextSendDate = nextStep ? new Date(Date.now() + nextStep.delay_days * 86400000).toISOString() : null;

        await base44.entities.SequenceEnrollment.update(enrollment.id, {
          steps_completed: nextStepIndex,
          current_step: nextStepIndex,
          last_sent_date: new Date().toISOString(),
          next_send_date: nextSendDate,
          send_log: sendLog,
          status: isLast ? 'completed' : 'active'
        });

        if (isLast) {
          await base44.entities.EmailSequence.update(sequence.id, {
            total_completed: (sequence.total_completed || 0) + 1
          });
          results.completed++;
        }

        results.sent++;
        console.log(`[processSequences] Sent step ${stepIndex + 1}/${steps.length} to ${enrollment.recipient_email} (tier: ${enrollment.qualification_tier || 'N/A'})`);

      } catch (sendErr) {
        console.error(`[processSequences] Send failed for ${enrollment.recipient_email}: ${sendErr.message}`);
        await base44.entities.OutreachLog.create({
          client_id: enrollment.client_id || '',
          lead_id: enrollment.lead_id || '',
          channel: 'email',
          recipient_email: enrollment.recipient_email,
          subject,
          outreach_type: sequence.outreach_type || 'lead_followup',
          status: 'failed',
          error_message: sendErr.message,
          is_retention: sequence.outreach_type === 'retention'
        });
        results.errors++;
      }
    }

    console.log(`[processSequences] Done. Sent: ${results.sent}, Adapted: ${results.adapted}, Completed: ${results.completed}, Skipped: ${results.skipped}, Errors: ${results.errors}`);
    return Response.json({ success: true, ...results });

  } catch (error) {
    console.error('[processSequences] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});