import { Context } from "hono";
import { base44ORM as base44 } from "../db/orm.ts";

async function azureLLM(prompt: string, systemPrompt: string, jsonSchema: any) {
  const baseUrl = Deno.env.get("AZURE_OPENAI_ENDPOINT")?.replace(/\/+$/, "");
  const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT");
  const apiKey = Deno.env.get("AZURE_OPENAI_KEY");
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "api-key": apiKey || "", "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt + (jsonSchema ? "\n\nRespond in JSON matching this schema: " + JSON.stringify(jsonSchema) : "") }
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function generateTierSequence(tier: string, outreachType: string, companyName: string, industry: string, clientId: string) {
  const tierConfig: Record<string, any> = {
    hot: { name: `Hot Lead Nurture - ${companyName}`, stepCount: 4, delays: [0, 1, 3, 5], tone: "Urgent, enthusiastic", focus: "closing" },
    warm: { name: `Warm Lead Engagement - ${companyName}`, stepCount: 5, delays: [1, 3, 5, 8, 12], tone: "Warm, consultative", focus: "trust" },
    nurture: { name: `Lead Nurture Drip - ${companyName}`, stepCount: 6, delays: [2, 5, 10, 18, 28, 40], tone: "Informative, non-pushy", focus: "value" },
    cold: { name: `Re-engagement - ${companyName}`, stepCount: 3, delays: [3, 10, 25], tone: "Fresh approach", focus: "check-in" }
  };
  const config = tierConfig[tier] || tierConfig.nurture;

  try {
    const result = await azureLLM(
      `Generate ${config.stepCount}-step sequence for ${companyName}. Tone: ${config.tone}. Focus: ${config.focus}.`,
      "Email sequence generator",
      { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { subject: { type: "string" }, body_html: { type: "string" }, delay_days: { type: "number" } } } } } }
    );
    const steps = (result.steps || []).map((s: any, i: number) => ({
      step_number: i + 1, delay_days: s.delay_days || config.delays[i] || (i + 1) * 2, subject: s.subject || `Follow-up ${i + 1}`, body_html: s.body_html || ""
    }));
    if (steps.length === 0) return null;

    return await base44.entities.EmailSequence.create({
      name: config.name, outreach_type: outreachType, status: "active", tier_target: tier, client_id: clientId, steps
    });
  } catch (err: any) {
    console.error("AI sequence gen failed", err.message);
    return null;
  }
}

export async function autoEnrollSequenceHandler(c: Context) {
  try {
    const internalSecret = c.req.header("X-Internal-Secret");
    const expectedKey = Deno.env.get("CRON_API_KEY");
    
    // Auth bypass for internal cron
    if (expectedKey && internalSecret !== expectedKey) {
       // If no internal secret, check normal user
       const user = c.get("jwtPayload") as any;
       if (!user) return c.json({ error: "Unauthorized" }, 401);
    }

    if (c.req.method === "GET") {
      const results = { enrolled: 0, skipped: 0, errors: 0 };
      const tiers = ["hot", "warm", "nurture", "cold"];
      for (const tier of tiers) {
        const leads = await base44.entities.Lead.filter({ qualification_tier: tier }, "-updated_at", 50);
        for (const lead of leads) {
          if (results.enrolled >= 20) break;
          if (!lead.email || !lead.client_id || lead.status === "do_not_call") { results.skipped++; continue; }
          const existing = await base44.entities.SequenceEnrollment.filter({ lead_id: lead.id, status: "active" });
          if (existing.length > 0) { results.skipped++; continue; }

          try {
            const client = await base44.entities.Client.get(lead.client_id);
            if (!client) { results.skipped++; continue; }

            let sequence = null;
            const seqs = await base44.entities.EmailSequence.filter({ client_id: lead.client_id, tier_target: tier, status: "active" });
            if (seqs.length > 0) sequence = seqs[0];
            if (!sequence) sequence = await generateTierSequence(tier, "lead_followup", client.company_name || "Company", client.industry || "General", lead.client_id);
            if (!sequence || !sequence.steps?.length) { results.skipped++; continue; }

            const nextSend = new Date(); nextSend.setDate(nextSend.getDate() + (sequence.steps[0]?.delay_days || 1));
            await base44.entities.SequenceEnrollment.create({
              sequence_id: sequence.id, client_id: lead.client_id, lead_id: lead.id, recipient_email: lead.email,
              status: "active", total_steps: sequence.steps.length, next_send_date: nextSend.toISOString()
            });
            results.enrolled++;
          } catch (e: any) { results.errors++; }
        }
      }
      return c.json({ success: true, ...results });
    }

    // POST mode
    const { lead_id, client_id, qualification_tier } = await c.req.json();
    if (!lead_id || !client_id || !qualification_tier) return c.json({ error: "Missing required fields" }, 400);

    const lead = await base44.entities.Lead.get(lead_id);
    if (!lead?.email || lead.status === "do_not_call") return c.json({ success: true, skipped: "invalid" });
    
    const existing = await base44.entities.SequenceEnrollment.filter({ lead_id, status: "active" });
    if (existing.length > 0) return c.json({ success: true, skipped: "already_enrolled" });

    const client = await base44.entities.Client.get(client_id);
    let sequence = null;
    const seqs = await base44.entities.EmailSequence.filter({ client_id, tier_target: qualification_tier, status: "active" });
    if (seqs.length > 0) sequence = seqs[0];
    if (!sequence) sequence = await generateTierSequence(qualification_tier, "lead_followup", client?.company_name || "Company", client?.industry || "General", client_id);
    if (!sequence || !sequence.steps?.length) return c.json({ success: true, skipped: "no_valid_sequence" });

    const nextSend = new Date(); nextSend.setDate(nextSend.getDate() + (sequence.steps[0]?.delay_days || 1));
    const enrollment = await base44.entities.SequenceEnrollment.create({
      sequence_id: sequence.id, client_id, lead_id, recipient_email: lead.email,
      status: "active", total_steps: sequence.steps.length, next_send_date: nextSend.toISOString()
    });

    return c.json({ success: true, enrolled: true, sequence_id: sequence.id, enrollment_id: enrollment.id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}
