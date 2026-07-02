import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// ═══════════════════════════════════════════════════════════════════════
// inboundAiAnalyze — runs the heavy AI routing analysis for PATH C (known
// platform client) and PATH D (completely unknown caller) OFF the webhook
// answer path. smartfloInboundRouter creates the CallLog instantly and
// fire-and-forgets this function, so the telephony webhook returns in ms
// instead of waiting ~1-2s for the LLM.
//
// Invoked internally (service-role) with:
//   { mode: 'platform' | 'unknown', call_log_id, client_id?, incomingNumber, calledDID }
// ═══════════════════════════════════════════════════════════════════════

async function azureLLM(prompt, systemPrompt, jsonSchema) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`;
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

export default async function inboundAiAnalyze(c: any) {
  const req = c.req.raw || c.req;
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    /* const base44 = ... */;

    const { mode, call_log_id, client_id, incomingNumber, calledDID } = await c.req.json();
    if (!call_log_id) return c.json({ data: { error: 'Missing call_log_id' } }, 400);

    const configs = await base44.entities.RetentionConfig.list('-created_date', 1);
    const retentionConfig = configs[0] || {};

    // ─── PATH C: known platform client ───
    if (mode === 'platform' && client_id) {
      const client = await base44.entities.Client.get(client_id).catch(() => null);
      if (!client) return c.json({ data: { error: 'Client not found' } }, 404);

      const [clientAgents, clientLeads, clientSubs, clientCallHistory, clientActivities] = await Promise.all([
        base44.entities.Agent.filter({ client_id }),
        base44.entities.Lead.filter({ client_id }),
        base44.entities.Subscription.filter({ client_id }),
        base44.entities.CallLog.filter({ client_id }, '-created_date', 5),
        base44.entities.Activity.filter({ client_id, status: 'scheduled' }),
      ]);

      const activeSub = clientSubs.find(s => s.status === 'active');

      const aiAnalysis = await azureLLM(
        `You are VaaniAI's intelligent call routing assistant. An incoming call has been received from a KNOWN registered client on VaaniAI's platform DID.

CALLER CONTEXT:
- Company: ${client.company_name}
- Industry: ${client.industry || 'General'}
- Account Status: ${client.account_status}
- Has Active Subscription: ${activeSub ? 'Yes (₹' + activeSub.total_amount + ')' : 'No'}
- Total Agents: ${clientAgents.length} (Active: ${clientAgents.filter(a => a.status === 'active').length})
- Total Leads: ${clientLeads.length}
- Recent Call Count: ${clientCallHistory.length}
- Pending Activities: ${clientActivities.length}
- Has CRM: ${client.has_custom_crm ? 'Yes' : 'No'}
- Trial End Date: ${client.trial_end_date || 'N/A'}

RECENT CALL SUMMARIES:
${clientCallHistory.map(c => `- ${c.direction} | ${c.status} | ${c.conversation_summary || 'No summary'}`).join('\n') || 'No recent calls'}

${retentionConfig.active_offer ? `ACTIVE OFFER: ${retentionConfig.active_offer}${retentionConfig.offer_code ? ' (Code: ' + retentionConfig.offer_code + ')' : ''}` : ''}
${retentionConfig.custom_instructions ? `CUSTOM INSTRUCTIONS: ${retentionConfig.custom_instructions}` : ''}

Determine: intent, routing, greeting, agent_context, talking_points, priority, follow_up_needed, follow_up_reason.
Respond with JSON.`,
        'You are VaaniAI call routing AI. Always respond in valid JSON.',
        {
          type: "object",
          properties: {
            intent: { type: "string" }, confidence: { type: "number" },
            routing: { type: "string" }, greeting: { type: "string" },
            agent_context: { type: "string" },
            talking_points: { type: "array", items: { type: "string" } },
            priority: { type: "string" },
            follow_up_needed: { type: "boolean" }, follow_up_reason: { type: "string" }
          }
        }
      );

      await base44.entities.CallLog.update(call_log_id, {
        conversation_summary: `[INBOUND - PLATFORM CLIENT] ${client.company_name} | Intent: ${aiAnalysis.intent} | Routed to: ${aiAnalysis.routing} | Priority: ${aiAnalysis.priority}\n\nGreeting: ${aiAnalysis.greeting}\n\nAgent Context: ${aiAnalysis.agent_context}`,
      });

      await base44.entities.Activity.create({
        client_id, type: 'call',
        title: `Inbound: ${(aiAnalysis.intent || 'call').replace('_', ' ')} — ${client.company_name}`,
        description: `Routed to: ${(aiAnalysis.routing || '').replace('_', ' ')}. ${aiAnalysis.agent_context || ''}`,
        scheduled_date: new Date().toISOString(),
        status: aiAnalysis.follow_up_needed ? 'scheduled' : 'completed',
        priority: aiAnalysis.priority === 'urgent' ? 'high' : aiAnalysis.priority || 'medium',
        auto_created: true,
      });

      if (aiAnalysis.follow_up_needed) {
        const followUpDate = new Date();
        followUpDate.setDate(followUpDate.getDate() + 1);
        await base44.entities.Activity.create({
          client_id, type: 'followup',
          title: `Follow-up: ${aiAnalysis.follow_up_reason || aiAnalysis.intent}`,
          description: `Auto-created after inbound platform call.`,
          scheduled_date: followUpDate.toISOString(), status: 'scheduled', priority: 'high', auto_created: true,
        });
      }

      return c.json({ data: { success: true, mode: 'platform' } });
    }

    // ─── PATH D: completely unknown caller ───
    if (mode === 'unknown') {
      const unknownAnalysis = await azureLLM(
        `You are VaaniAI's call routing assistant. Unknown caller on number ${incomingNumber}.
${retentionConfig.active_offer ? `Active Offer: ${retentionConfig.active_offer}` : ''}
VaaniAI is an AI voice calling platform for Indian businesses. Pricing starts at ₹6,500/month.
Generate: greeting, likely_intent, qualifying_questions, routing, is_potential_lead, suggested_response.`,
        'You are VaaniAI call routing AI. Always respond in valid JSON.',
        {
          type: "object",
          properties: {
            greeting: { type: "string" }, likely_intent: { type: "string" },
            qualifying_questions: { type: "array", items: { type: "string" } },
            routing: { type: "string" }, is_potential_lead: { type: "boolean" },
            suggested_response: { type: "string" }
          }
        }
      );

      await base44.entities.CallLog.update(call_log_id, {
        conversation_summary: `[INBOUND - UNKNOWN] Number: ${incomingNumber} | Intent: ${unknownAnalysis.likely_intent} | Potential lead: ${unknownAnalysis.is_potential_lead ? 'YES' : 'No'}`,
      });

      if (unknownAnalysis.is_potential_lead) {
        await base44.entities.Activity.create({
          client_id: 'system', type: 'call',
          title: `New inbound lead: ${incomingNumber}`,
          description: `Unknown caller. Intent: ${unknownAnalysis.likely_intent}. ${unknownAnalysis.suggested_response || ''}`,
          scheduled_date: new Date().toISOString(), status: 'scheduled', priority: 'high', auto_created: true,
        });
      }

      return c.json({ data: { success: true, mode: 'unknown' } });
    }

    return c.json({ data: { error: 'Invalid mode' } }, 400);
  } catch (error) {
    console.error('[inboundAiAnalyze] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};