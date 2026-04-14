import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.25';

// ─── Send email using CLIENT's configured provider (via sendClientEmail function) ───
// Falls back to platform SMTP if client has no email config
async function sendLeadEmail({ to, fromName, subject, html, clientId }) {
  if (clientId) {
    try {
      const appId = Deno.env.get('BASE44_APP_ID');
      const svcBase44 = createClient({ appId, asServiceRole: true });
      const result = await svcBase44.functions.invoke('sendClientEmail', {
        client_id: clientId,
        to,
        subject,
        html,
        from_name: fromName
      });
      console.log(`[processSequences] Email sent via ${result.data?.provider || 'unknown'} for client ${clientId}`);
      return result.data;
    } catch (e) {
      console.warn(`[processSequences] sendClientEmail failed, falling back to platform SMTP: ${e.message}`);
    }
  }
  // Fallback: platform default SMTP
  const { SMTPClient } = await import('npm:emailjs@4.0.3');
  const client = new SMTPClient({
    user: Deno.env.get('PLATFORM_SMTP_USER'),
    password: Deno.env.get('PLATFORM_SMTP_PASS'),
    host: Deno.env.get('PLATFORM_SMTP_HOST'),
    port: parseInt(Deno.env.get('PLATFORM_SMTP_PORT') || '587'),
    tls: true,
    timeout: 15000
  });
  const fromAddress = Deno.env.get('PLATFORM_SMTP_FROM') || Deno.env.get('PLATFORM_SMTP_USER');
  await client.sendAsync({
    from: `${fromName || 'Getway AI'} <${fromAddress}>`,
    to,
    subject,
    attachment: [{ data: html, alternative: true }]
  });
  return { provider: 'platform_smtp', status: 'sent' };
}

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

// Runs every 30 min. Supports external cron: GET ?cron_secret=<SMARTFLO_WEBHOOK_SECRET>

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
      console.log('[processSequences] Triggered by external cron');
    }

    const base44_client = createClientFromRequest(req);
    const base44 = base44_client.asServiceRole;

    const results = { sent: 0, skipped: 0, completed: 0, errors: 0, adapted: 0, total_active: 0 };
    const BATCH_LIMIT = 15; // Max emails per run to avoid timeout
    const SEND_DELAY_MS = 1200; // 1.2s between sends to respect rate limits

    // Get all active sequences
    const sequences = await base44.entities.EmailSequence.filter({ status: 'active' });
    if (sequences.length === 0) {
      return Response.json({ success: true, message: 'No active sequences', ...results });
    }

    const sequenceMap = {};
    sequences.forEach(s => { sequenceMap[s.id] = s; });

    // Get all active enrollments
    const activeEnrollments = await base44.entities.SequenceEnrollment.filter({ status: 'active' });
    results.total_active = activeEnrollments.length;

    // Filter to only due enrollments and limit batch size
    const now = new Date();
    const dueEnrollments = activeEnrollments
      .filter(e => e.next_send_date && new Date(e.next_send_date) <= now)
      .slice(0, BATCH_LIMIT);

    console.log(`[processSequences] ${activeEnrollments.length} active, ${dueEnrollments.length} due (batch limit ${BATCH_LIMIT})`);

    // Pre-fetch all needed leads and clients in batch to avoid per-enrollment API calls
    const uniqueLeadIds = [...new Set(dueEnrollments.map(e => e.lead_id).filter(Boolean))];
    const uniqueClientIds = [...new Set(dueEnrollments.map(e => e.client_id).filter(Boolean))];

    const leadMap = {};
    const clientMap = {};

    const leadResults = await Promise.all(uniqueLeadIds.map(id => base44.entities.Lead.get(id).catch(() => null)));
    leadResults.forEach(l => { if (l) leadMap[l.id] = l; });

    const clientResults = await Promise.all(uniqueClientIds.map(id => base44.entities.Client.get(id).catch(() => null)));
    clientResults.forEach(c => { if (c) clientMap[c.id] = c; });

    console.log(`[processSequences] Pre-fetched ${Object.keys(leadMap).length} leads, ${Object.keys(clientMap).length} clients`);

    for (const enrollment of dueEnrollments) {

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

      // Dedup: check if this step was already sent (prevent duplicate sends)
      const sendLog = enrollment.send_log || [];
      const alreadySent = sendLog.some(s => s.step_number === stepIndex + 1 && s.status === 'sent');
      if (alreadySent) {
        // Advance to next step
        const nextStepIdx = stepIndex + 1;
        const isLast = nextStepIdx >= steps.length;
        const nextStep = !isLast ? steps[nextStepIdx] : null;
        const nextSendDate = nextStep ? new Date(Date.now() + nextStep.delay_days * 86400000).toISOString() : null;
        await base44.entities.SequenceEnrollment.update(enrollment.id, {
          steps_completed: nextStepIdx, current_step: nextStepIdx,
          next_send_date: nextSendDate, status: isLast ? 'completed' : 'active'
        });
        console.log(`[processSequences] Dedup: step ${stepIndex + 1} already sent to ${enrollment.recipient_email}, advancing`);
        results.skipped++;
        continue;
      }

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

          if (enrollment.lead_id && leadMap[enrollment.lead_id]) {
            const lead = leadMap[enrollment.lead_id];
            contextParts.push(`Lead: ${lead.name || ''}, Company: ${lead.company || ''}, Status: ${lead.status || ''}, Score: ${lead.score || 'N/A'}/100, Tier: ${lead.qualification_tier || 'N/A'}`);
            if (lead.notes) contextParts.push(`Recent Notes: ${lead.notes.substring(0, 300)}`);
            if (lead.intent_signals?.length > 0) contextParts.push(`Intent Signals: ${lead.intent_signals.join(', ')}`);
            if (lead.sentiment) contextParts.push(`Sentiment: ${lead.sentiment}`);
          }

          if (enrollment.client_id && clientMap[enrollment.client_id]) {
            const client = clientMap[enrollment.client_id];
            contextParts.push(`Company: ${client.company_name || ''}, Industry: ${client.industry || ''}`);
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

      // Determine sender from pre-fetched cache
      let fromName = 'Getway AI';
      if (enrollment.client_id && clientMap[enrollment.client_id]?.company_name) {
        fromName = clientMap[enrollment.client_id].company_name;
      }

      // Send the email using client's configured provider (falls back to platform ACS)
      try {
        await sendLeadEmail({
          to: enrollment.recipient_email,
          fromName,
          subject,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">${bodyHtml}</div>`,
          clientId: enrollment.client_id
        });

        // Log in OutreachLog
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

        // Rate limit: wait between sends to avoid throttling
        await new Promise(r => setTimeout(r, SEND_DELAY_MS));

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

    results.skipped += activeEnrollments.length - dueEnrollments.length;
    console.log(`[processSequences] Done. Sent: ${results.sent}, Adapted: ${results.adapted}, Completed: ${results.completed}, Skipped: ${results.skipped}, Errors: ${results.errors}`);
    return Response.json({ success: true, ...results });

  } catch (error) {
    console.error('[processSequences] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});