import { Context } from "hono";
import { client } from "../db/index.ts";

async function azureLLM(prompt: string, systemPrompt: string, jsonSchema: any) {
  const baseUrl = Deno.env.get("AZURE_OPENAI_ENDPOINT")?.replace(/\/+$/, "");
  const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT");
  const apiKey = Deno.env.get("AZURE_OPENAI_KEY");
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`;

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

    const res = await (client as any).queryObject(`
      INSERT INTO emailsequence (id, created_at, name, outreach_type, status, tier_target, client_id, steps)
      VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [config.name, outreachType, "active", tier, clientId, JSON.stringify(steps)]);
    return res.rows[0];
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
        const leadsRes = await (client as any).queryObject(`SELECT * FROM lead WHERE qualification_tier = $1 ORDER BY updated_date DESC LIMIT 50`, [tier]);
        const leads = leadsRes.rows;
        for (const lead of leads) {
          if (results.enrolled >= 20) break;
          if (!lead.email || !lead.client_id || lead.status === "do_not_call") { results.skipped++; continue; }
          
          const existingRes = await (client as any).queryObject(`SELECT id FROM sequenceenrollment WHERE lead_id = $1 AND status = 'active'`, [lead.id]);
          if (existingRes.rows.length > 0) { results.skipped++; continue; }

          try {
            const clientRes = await (client as any).queryObject(`SELECT * FROM client WHERE id = $1`, [lead.client_id]);
            const clientRow = clientRes.rows[0];
            if (!clientRow) { results.skipped++; continue; }

            let sequence = null;
            const seqsRes = await (client as any).queryObject(`SELECT * FROM emailsequence WHERE client_id = $1 AND tier_target = $2 AND status = 'active'`, [lead.client_id, tier]);
            if (seqsRes.rows.length > 0) sequence = seqsRes.rows[0];
            
            if (!sequence) sequence = await generateTierSequence(tier, "lead_followup", clientRow.company_name || "Company", clientRow.industry || "General", lead.client_id);
            if (!sequence || !sequence.steps) { results.skipped++; continue; }

            const steps = typeof sequence.steps === 'string' ? JSON.parse(sequence.steps) : sequence.steps;
            if (!steps || !steps.length) { results.skipped++; continue; }

            const nextSend = new Date(); nextSend.setDate(nextSend.getDate() + (steps[0]?.delay_days || 1));
            
            await (client as any).queryObject(`
              INSERT INTO sequenceenrollment (id, created_at, sequence_id, client_id, lead_id, recipient_email, status, total_steps, next_send_date)
              VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7)
            `, [sequence.id, lead.client_id, lead.id, lead.email, "active", steps.length, nextSend.toISOString()]);
            
            results.enrolled++;
          } catch (e: any) { results.errors++; }
        }
      }
      return c.json({ success: true, ...results });
    }

    // POST mode
    const { lead_id, client_id, qualification_tier } = await c.req.json();
    if (!lead_id || !client_id || !qualification_tier) return c.json({ error: "Missing required fields" }, 400);

    const leadRes = await (client as any).queryObject(`SELECT * FROM lead WHERE id = $1`, [lead_id]);
    const lead = leadRes.rows[0];
    if (!lead?.email || lead.status === "do_not_call") return c.json({ success: true, skipped: "invalid" });
    
    const existingRes = await (client as any).queryObject(`SELECT id FROM sequenceenrollment WHERE lead_id = $1 AND status = 'active'`, [lead_id]);
    if (existingRes.rows.length > 0) return c.json({ success: true, skipped: "already_enrolled" });

    const clientRes = await (client as any).queryObject(`SELECT * FROM client WHERE id = $1`, [client_id]);
    const clientRow = clientRes.rows[0];
    
    let sequence = null;
    const seqsRes = await (client as any).queryObject(`SELECT * FROM emailsequence WHERE client_id = $1 AND tier_target = $2 AND status = 'active'`, [client_id, qualification_tier]);
    if (seqsRes.rows.length > 0) sequence = seqsRes.rows[0];
    
    if (!sequence) sequence = await generateTierSequence(qualification_tier, "lead_followup", clientRow?.company_name || "Company", clientRow?.industry || "General", client_id);
    if (!sequence || !sequence.steps) return c.json({ success: true, skipped: "no_valid_sequence" });

    const steps = typeof sequence.steps === 'string' ? JSON.parse(sequence.steps) : sequence.steps;
    if (!steps || !steps.length) return c.json({ success: true, skipped: "no_valid_sequence" });

    const nextSend = new Date(); nextSend.setDate(nextSend.getDate() + (steps[0]?.delay_days || 1));
    const enrollmentRes = await (client as any).queryObject(`
      INSERT INTO sequenceenrollment (id, created_at, sequence_id, client_id, lead_id, recipient_email, status, total_steps, next_send_date)
      VALUES (gen_random_uuid(), NOW(), $1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [sequence.id, client_id, lead_id, lead.email, "active", steps.length, nextSend.toISOString()]);

    return c.json({ success: true, enrolled: true, sequence_id: sequence.id, enrollment_id: enrollmentRes.rows[0].id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}
