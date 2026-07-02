import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Phase 1: retry transient Base44/Cloudflare errors (429/502/503/504/timeouts)
// with exponential backoff. Purely additive — non-transient errors rethrow
// immediately so existing handling is unchanged.
async function withRetry(fn, { tries = 3, baseMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e?.message || '';
      const transient = /429|rate limit|502|503|504|timeout|ETIMEDOUT|ECONNRESET|Just a moment/i.test(msg);
      if (!transient || attempt === tries - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Helper: compute next fire date from a base date + delay
function computeDelayMs(value, unit) {
  const v = Number(value) || 0;
  if (unit === 'minutes') return v * 60 * 1000;
  if (unit === 'hours') return v * 60 * 60 * 1000;
  return v * 24 * 60 * 60 * 1000; // days
}

function interpolate(template, lead) {
  if (!template) return '';
  return template
    .replace(/\{\{name\}\}/g, lead?.name || '')
    .replace(/\{\{company\}\}/g, lead?.company || '')
    .replace(/\{\{phone\}\}/g, lead?.phone || '')
    .replace(/\{\{email\}\}/g, lead?.email || '');
}

// AI email generator using Azure OpenAI (zero Base44 credits)
async function generateAIEmail({ lead, client, context }) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey) {
    return { subject: 'Following up', body: `Hi ${lead?.name || 'there'},\n\nJust following up.\n\n${context || ''}` };
  }
  const prompt = `Write a short (120-180 words) personalized follow-up email in HTML for this lead.

LEAD:
- Name: ${lead?.name || 'Valued Customer'}
- Company: ${lead?.company || 'N/A'}
- Phone: ${lead?.phone || 'N/A'}
- Status: ${lead?.status || 'new'}
- Last notes: ${(lead?.notes || '').substring(0, 300) || 'N/A'}

CAMPAIGN / CONTEXT FROM SENDER (${client?.company_name || 'our company'}):
${context || 'A professional follow-up.'}

Return JSON: { "subject": "...", "body_html": "<p>...</p>" }. Address by name. Include one clear CTA.`;
  const res = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are an expert email copywriter. Always respond in valid JSON.' },
        { role: 'user', content: prompt }
      ],
      max_completion_tokens: 600,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`Azure LLM ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  return { subject: parsed.subject || 'Following up', body: parsed.body_html || parsed.body || '' };
}

async function sendWhatsApp(config, to, body) {
  if (!config || config.whatsapp_status !== 'connected' || !config.whatsapp_api_key) {
    return { success: false, error: 'WhatsApp not configured' };
  }

  // Meta Cloud API
  if (config.whatsapp_provider === 'meta_cloud' && config.whatsapp_phone_number_id) {
    const url = `https://graph.facebook.com/v18.0/${config.whatsapp_phone_number_id}/messages`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.whatsapp_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/\D/g, ''),
        type: 'text',
        text: { body }
      })
    });
    const data = await r.json();
    return { success: r.ok, data, error: r.ok ? null : JSON.stringify(data) };
  }

  // Generic fallback — use configured endpoint
  if (config.whatsapp_api_endpoint) {
    const r = await fetch(config.whatsapp_api_endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.whatsapp_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ to, message: body })
    });
    const data = await r.json().catch(() => ({}));
    return { success: r.ok, data, error: r.ok ? null : JSON.stringify(data) };
  }

  return { success: false, error: 'WhatsApp provider not supported for auto-send' };
}

async function sendSMS(config, to, body) {
  if (!config || config.rcs_status !== 'connected' || !config.rcs_api_endpoint) {
    return { success: false, error: 'SMS not configured' };
  }
  const r = await fetch(config.rcs_api_endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.rcs_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to,
      from: config.rcs_sender_id,
      message: body
    })
  });
  const data = await r.json().catch(() => ({}));
  return { success: r.ok, data, error: r.ok ? null : JSON.stringify(data) };
}

export default async function processLeadGroupSequences(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Auth handled by Base44 gateway via ?api_key= — no internal check needed
    /* const base44 = ... */;
    const now = new Date();

    // Fetch due enrollments
    const dueEnrollments = await base44.asServiceRole.entities.LeadGroupSequenceEnrollment.filter({
      status: 'active'
    }, '-created_date', 200);

    const dueListRaw = dueEnrollments.filter(e =>
      e.next_run_date && new Date(e.next_run_date) <= now
    );

    // ─── Phase 4: PER-TENANT FAIRNESS ───
    // Interleave enrollments round-robin by client so one high-volume tenant
    // can't monopolize the run and starve others. We bucket by client_id then
    // pull one from each bucket per round.
    const byClient = new Map();
    for (const e of dueListRaw) {
      const k = e.client_id || '_';
      if (!byClient.has(k)) byClient.set(k, []);
      byClient.get(k).push(e);
    }
    const dueList = [];
    let remaining = dueListRaw.length;
    while (remaining > 0) {
      for (const [, bucket] of byClient) {
        if (bucket.length > 0) { dueList.push(bucket.shift()); remaining--; }
      }
    }

    console.log(`Found ${dueList.length} due enrollments (of ${dueEnrollments.length} active), interleaved across ${byClient.size} tenants`);

    // ─── Phase 3: BATCH-PREFETCH (kill N+1) ───
    // Previously each enrollment fetched its sequence + lead individually inside
    // the loop. Pre-fetch all unique sequences/leads/clients once up front.
    const uniqueSeqIds = [...new Set(dueList.map(e => e.sequence_id).filter(Boolean))];
    const uniqueLeadIds = [...new Set(dueList.map(e => e.lead_id).filter(Boolean))];
    const uniqueClientIds = [...new Set(dueList.map(e => e.client_id).filter(Boolean))];
    const seqMap = {}, leadMap = {}, clientMap = {};
    const [seqRes, leadRes, clientRes] = await Promise.all([
      Promise.all(uniqueSeqIds.map(id => withRetry(() => base44.asServiceRole.entities.LeadGroupSequence.get(id)).catch(() => null))),
      Promise.all(uniqueLeadIds.map(id => withRetry(() => base44.asServiceRole.entities.Lead.get(id)).catch(() => null))),
      Promise.all(uniqueClientIds.map(id => withRetry(() => base44.asServiceRole.entities.Client.get(id)).catch(() => null))),
    ]);
    seqRes.forEach(s => { if (s) seqMap[s.id] = s; });
    leadRes.forEach(l => { if (l) leadMap[l.id] = l; });
    clientRes.forEach(c => { if (c) clientMap[c.id] = c; });

    let processed = 0;
    let errors = 0;

    // Track which clients already had a call placed in this run — only one
    // active outbound AI call per client at a time (sequential dialing).
    const clientHasLiveCall = new Map();
    async function clientCallInFlight(clientId) {
      if (clientHasLiveCall.has(clientId)) return clientHasLiveCall.get(clientId);
      const live = await withRetry(() => base44.asServiceRole.entities.CallLog.filter({
        client_id: clientId,
        status: 'initiated'
      }, '-created_date', 1)).catch(() => []);
      const ringing = await withRetry(() => base44.asServiceRole.entities.CallLog.filter({
        client_id: clientId,
        status: 'ringing'
      }, '-created_date', 1)).catch(() => []);
      const answered = await withRetry(() => base44.asServiceRole.entities.CallLog.filter({
        client_id: clientId,
        status: 'answered'
      }, '-created_date', 1)).catch(() => []);
      const inFlight = (live.length + ringing.length + answered.length) > 0;
      clientHasLiveCall.set(clientId, inFlight);
      return inFlight;
    }

    for (const enr of dueList) {
      try {
        // Phase 3: use prefetched maps (no per-enrollment reads)
        const sequence = seqMap[enr.sequence_id] || null;
        const lead = leadMap[enr.lead_id] || null;

        if (!sequence || !lead) {
          await withRetry(() => base44.asServiceRole.entities.LeadGroupSequenceEnrollment.update(enr.id, {
            status: 'failed',
            exit_reason: !sequence ? 'Sequence deleted' : 'Lead deleted'
          }));
          continue;
        }

        if (sequence.status !== 'active') {
          continue; // sequence paused — skip for now
        }

        const steps = sequence.steps || [];
        const idx = enr.current_step_index || 0;

        if (idx >= steps.length) {
          // Completed
          await withRetry(() => base44.asServiceRole.entities.LeadGroupSequenceEnrollment.update(enr.id, {
            status: 'completed',
            next_run_date: null
          }));
          await withRetry(() => base44.asServiceRole.entities.LeadGroupSequence.update(sequence.id, {
            total_completed: (sequence.total_completed || 0) + 1
          }));
          continue;
        }

        const step = steps[idx];

        // Skip check based on lead status
        if ((step.skip_if_status || []).includes(lead.status)) {
          // Move to next step without executing
          const nextStep = steps[idx + 1];
          const nextRun = nextStep
            ? new Date(now.getTime() + computeDelayMs(nextStep.delay_value, nextStep.delay_unit)).toISOString()
            : null;
          await withRetry(() => base44.asServiceRole.entities.LeadGroupSequenceEnrollment.update(enr.id, {
            current_step_index: idx + 1,
            next_run_date: nextRun,
            last_step_date: now.toISOString(),
            execution_log: [...(enr.execution_log || []), {
              step_number: step.step_number,
              type: step.type,
              executed_at: now.toISOString(),
              status: 'skipped',
              result: `Lead status: ${lead.status}`
            }]
          }));
          continue;
        }

        // Execute step
        let result = { status: 'failed', message: 'Unknown step type' };

        if (step.type === 'call') {
          const agentId = step.agent_id || sequence.agent_id;
          // Guard: if the configured agent no longer exists, FAIL the enrollment
          // permanently instead of retrying forever (was spamming initiateCall 404s
          // once per second). Verify existence before attempting the call.
          const agentExists = agentId
            ? await withRetry(() => base44.asServiceRole.entities.Agent.get(agentId)).then(() => true).catch(() => false)
            : false;
          if (!agentId) {
            result = { status: 'failed', message: 'No agent configured' };
          } else if (!agentExists) {
            await withRetry(() => base44.asServiceRole.entities.LeadGroupSequenceEnrollment.update(enr.id, {
              status: 'failed',
              next_run_date: null,
              exit_reason: `Agent ${agentId} no longer exists`,
              execution_log: [...(enr.execution_log || []), {
                step_number: step.step_number, type: 'call', executed_at: now.toISOString(),
                status: 'failed', result: `Agent ${agentId} deleted — enrollment stopped`
              }]
            }));
            console.log(`[processLeadGroupSequences] ⛔ Enrollment ${enr.id} failed — agent ${agentId} deleted`);
            errors++;
            continue;
          } else if (await clientCallInFlight(enr.client_id)) {
            // Another call is live for this client — defer this step by 2 minutes,
            // do NOT advance the step index. Will retry on next tick.
            const retryAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
            await withRetry(() => base44.asServiceRole.entities.LeadGroupSequenceEnrollment.update(enr.id, {
              next_run_date: retryAt
            }));
            console.log(`[processLeadGroupSequences] Deferred call for enr ${enr.id} — client ${enr.client_id} has a live call`);
            continue;
          } else {
            // Cache script for the agent to use on this call via agent_config_cache override
            const callRes = await base44.asServiceRole.functions.invoke('initiateCall', {
              lead_id: lead.id,
              agent_id: agentId,
              phone_number: lead.phone,
              context_override: step.call_script || '',
              service_call: true
            });
            if (callRes?.data?.success) {
              result = { status: 'success', message: 'Call initiated', call_log_id: callRes.data.call_log_id };
              // Mark this client as busy so subsequent enrollments in the same run wait
              clientHasLiveCall.set(enr.client_id, true);
            } else {
              result = { status: 'failed', message: callRes?.data?.error || 'Call failed' };
            }
          }
        } else if (step.type === 'whatsapp' || step.type === 'sms') {
          // Template path — uses approved MessageTemplate (required by Meta for first contact)
          if (step.template_id && step.type === 'whatsapp') {
            const tRes = await base44.asServiceRole.functions.invoke('sendWhatsAppTemplate', {
              client_id: enr.client_id,
              template_id: step.template_id,
              to: lead.phone,
              variables: step.template_variables || [],
              lead_id: lead.id,
              outreach_type: 'lead_followup'
            });
            result = tRes?.data?.success
              ? { status: 'success', message: `WhatsApp template "${tRes.data.template_name}" sent` }
              : { status: 'failed', message: tRes?.data?.error || 'Template send failed' };
          } else {
            // Free-text fallback
            const configs = await base44.asServiceRole.entities.ClientMessagingConfig.filter({ client_id: enr.client_id });
            const config = configs[0];
            const body = interpolate(step.message_body, lead);
            const send = step.type === 'whatsapp'
              ? await sendWhatsApp(config, lead.phone, body)
              : await sendSMS(config, lead.phone, body);
            result = send.success
              ? { status: 'success', message: `${step.type} sent` }
              : { status: 'failed', message: send.error };
          }
        } else if (step.type === 'email') {
          if (!lead.email) {
            result = { status: 'skipped', message: 'No email on lead' };
          } else {
            let subject, body;
            if (step.ai_generate_email) {
              // AI-generate a unique email per lead
              try {
                const client = clientMap[enr.client_id] || await withRetry(() => base44.asServiceRole.entities.Client.get(enr.client_id)).catch(() => null);
                const ai = await withRetry(() => generateAIEmail({ lead, client, context: step.ai_email_context || '' }));
                subject = ai.subject;
                body = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">${ai.body}</div>`;
              } catch (e) {
                // Fallback to free text if AI fails
                subject = interpolate(step.subject || 'Follow-up', lead);
                body = interpolate(step.message_body || '', lead);
                console.error(`[processLeadGroupSequences] AI email generation failed: ${e.message}`);
              }
            } else {
              subject = interpolate(step.subject || 'Follow-up', lead);
              body = interpolate(step.message_body || '', lead);
            }
            await withRetry(() => base44.asServiceRole.integrations.Core.SendEmail({
              to: lead.email, subject, body
            }));
            // Log outreach
            await withRetry(() => base44.asServiceRole.entities.OutreachLog.create({
              client_id: enr.client_id, lead_id: lead.id,
              channel: 'email', recipient_email: lead.email,
              subject, body, outreach_type: 'lead_followup', status: 'sent'
            })).catch(() => {});
            result = { status: 'success', message: step.ai_generate_email ? 'AI email sent' : 'Email sent' };
          }
        }

        // Schedule next step
        const nextIdx = idx + 1;
        const nextStep = steps[nextIdx];
        let nextRun = null;
        let newStatus = enr.status;

        if (nextStep) {
          // Next step always scheduled from now (last step execution time)
          nextRun = new Date(now.getTime() + computeDelayMs(nextStep.delay_value, nextStep.delay_unit)).toISOString();
        } else {
          newStatus = 'completed';
          await withRetry(() => base44.asServiceRole.entities.LeadGroupSequence.update(sequence.id, {
            total_completed: (sequence.total_completed || 0) + 1
          }));
        }

        const logEntry = {
          step_number: step.step_number,
          type: step.type,
          executed_at: now.toISOString(),
          status: result.status,
          result: String(result.message || '')
        };
        if (result.call_log_id) logEntry.call_log_id = result.call_log_id;

        await withRetry(() => base44.asServiceRole.entities.LeadGroupSequenceEnrollment.update(enr.id, {
          current_step_index: nextIdx,
          next_run_date: nextRun,
          last_step_date: now.toISOString(),
          status: newStatus,
          execution_log: [...(enr.execution_log || []), logEntry]
        }));

        processed++;
      } catch (err) {
        console.error('Error processing enrollment', enr.id, err);
        errors++;
      }
    }

    return c.json({ data: { success: true, processed, errors, total_due: dueList.length } });
  } catch (error) {
    console.error('processLeadGroupSequences error', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};