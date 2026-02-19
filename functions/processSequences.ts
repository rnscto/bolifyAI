import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const results = { sent: 0, skipped: 0, completed: 0, errors: 0 };

    // Get all active sequences
    const sequences = await base44.asServiceRole.entities.EmailSequence.filter({ status: 'active' });
    if (sequences.length === 0) {
      return Response.json({ success: true, message: 'No active sequences', ...results });
    }

    const sequenceMap = {};
    sequences.forEach(s => { sequenceMap[s.id] = s; });

    // Get all active enrollments with next_send_date in the past
    const now = new Date().toISOString();
    const activeEnrollments = await base44.asServiceRole.entities.SequenceEnrollment.filter({ status: 'active' });

    for (const enrollment of activeEnrollments) {
      // Check if it's time to send
      if (!enrollment.next_send_date || new Date(enrollment.next_send_date) > new Date()) {
        results.skipped++;
        continue;
      }

      const sequence = sequenceMap[enrollment.sequence_id];
      if (!sequence) {
        results.skipped++;
        continue;
      }

      const stepIndex = enrollment.steps_completed || 0;
      const steps = sequence.steps || [];

      if (stepIndex >= steps.length) {
        // Mark as completed
        await base44.asServiceRole.entities.SequenceEnrollment.update(enrollment.id, {
          status: 'completed'
        });
        await base44.asServiceRole.entities.EmailSequence.update(sequence.id, {
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

      // AI personalization if enabled
      if (step.use_ai_personalization) {
        try {
          let contextInfo = '';
          if (enrollment.lead_id) {
            try {
              const lead = await base44.asServiceRole.entities.Lead.get(enrollment.lead_id);
              contextInfo = `Lead: ${lead.name || ''}, Company: ${lead.company || ''}, Status: ${lead.status || ''}, Notes: ${lead.notes || ''}`;
            } catch (_) {}
          }
          if (enrollment.client_id) {
            try {
              const client = await base44.asServiceRole.entities.Client.get(enrollment.client_id);
              contextInfo += ` Client: ${client.company_name || ''}, Industry: ${client.industry || ''}, Account: ${client.account_status || ''}`;
            } catch (_) {}
          }

          if (contextInfo) {
            const personalized = await base44.asServiceRole.integrations.Core.InvokeLLM({
              prompt: `Personalize this email using the context below. Keep the structure and CTA, but add personal touches.

ORIGINAL SUBJECT: ${subject}
ORIGINAL BODY: ${bodyHtml}

CONTEXT: ${contextInfo}
RECIPIENT: ${enrollment.recipient_name || enrollment.recipient_email}

Return personalized subject and body_html.`,
              response_json_schema: {
                type: "object",
                properties: {
                  subject: { type: "string" },
                  body_html: { type: "string" }
                }
              }
            });
            subject = personalized.subject || subject;
            bodyHtml = personalized.body_html || bodyHtml;
          }
        } catch (aiErr) {
          console.warn(`[processSequences] AI personalization failed for ${enrollment.id}:`, aiErr.message);
        }
      }

      // Send the email
      try {
        await base44.asServiceRole.integrations.Core.SendEmail({
          to: enrollment.recipient_email,
          from_name: 'VaaniAI',
          subject,
          body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">${bodyHtml}</div>`
        });

        // Log in OutreachLog
        await base44.asServiceRole.entities.OutreachLog.create({
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

        await base44.asServiceRole.entities.SequenceEnrollment.update(enrollment.id, {
          steps_completed: nextStepIndex,
          current_step: nextStepIndex,
          last_sent_date: new Date().toISOString(),
          next_send_date: nextSendDate,
          send_log: sendLog,
          status: isLast ? 'completed' : 'active'
        });

        if (isLast) {
          await base44.asServiceRole.entities.EmailSequence.update(sequence.id, {
            total_completed: (sequence.total_completed || 0) + 1
          });
          results.completed++;
        }

        results.sent++;
        console.log(`[processSequences] Sent step ${stepIndex + 1} to ${enrollment.recipient_email}`);

      } catch (sendErr) {
        console.error(`[processSequences] Send failed for ${enrollment.recipient_email}:`, sendErr.message);

        await base44.asServiceRole.entities.OutreachLog.create({
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

    console.log(`[processSequences] Done. Sent: ${results.sent}, Completed: ${results.completed}, Skipped: ${results.skipped}, Errors: ${results.errors}`);
    return Response.json({ success: true, ...results });

  } catch (error) {
    console.error('[processSequences] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});