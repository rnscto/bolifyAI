import { Context } from "hono";
import { base44ORM as base44 } from "../db/orm.ts";

export async function qualifyLeadHandler(c: Context) {
  try {
    const payload = await c.req.json();
    const { event, data, old_data } = payload;

    if (!event || event.entity_name !== "Lead" || event.type !== "update") {
      return c.json({ success: true, skipped: "not_lead_update" });
    }

    const lead = data;
    const leadId = event.entity_id;
    const scoreChanged = lead.score !== (old_data?.score ?? undefined);
    const sentimentChanged = lead.sentiment !== (old_data?.sentiment ?? undefined);

    if (!scoreChanged && !sentimentChanged) {
      return c.json({ success: true, skipped: "no_score_change" });
    }

    const score = lead.score || 0;
    const sentiment = lead.sentiment || "neutral";
    const intents = lead.intent_signals || [];
    const status = lead.status || "new";

    let tier = "cold";
    let reason = "";

    if (score >= 75 && ["very_positive", "positive"].includes(sentiment)) {
      tier = "hot";
      reason = `Score ${score}/100, ${sentiment} sentiment`;
    } else if (score >= 50 && ["very_positive", "positive", "neutral"].includes(sentiment)) {
      tier = "warm";
      reason = `Moderate score ${score}/100, ${sentiment} sentiment`;
    } else if (score >= 25 && sentiment !== "very_negative") {
      tier = "nurture";
      reason = `Low-moderate score ${score}/100`;
    } else if (score < 25 && ["negative", "very_negative"].includes(sentiment)) {
      tier = "disqualified";
      reason = `Very low score ${score}/100 with ${sentiment} sentiment.`;
    } else {
      tier = "cold";
      reason = `Low score ${score}/100`;
    }

    if (status === "converted") {
      tier = "hot"; reason = "Lead already converted";
    } else if (status === "do_not_call") {
      tier = "disqualified"; reason = "Marked as do not call";
    }

    await base44.entities.Lead.update(leadId, {
      qualification_tier: tier,
      qualification_reason: reason,
    });

    return c.json({ success: true, tier, reason });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}

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

export async function rescoreLeadHandler(c: Context) {
  try {
    const { lead_id, client_id, limit = 50 } = await c.req.json();
    const user = c.get("jwtPayload") as any;

    if (lead_id) {
      const lead = await base44.entities.Lead.get(lead_id);
      if (!lead) return c.json({ error: "Lead not found" }, 404);
      if (user.role !== "admin" && lead.client_id !== user.client_id) return c.json({ error: "Forbidden" }, 403);

      const calls = await base44.entities.CallLog.filter({ lead_id: lead.id }, "-created_at", 10);
      const latest = calls.find((c: any) => (c.transcript?.length > 30) || (c.conversation_summary?.length > 20));
      if (!latest) return c.json({ skipped: "no_call_history", lead_id: lead.id });

      const aiResult = await azureLLM(
        `Re-score lead based on call. SUMMARY: ${latest.conversation_summary} \n TRANSCRIPT: ${latest.transcript}`,
        "Expert sales lead scoring AI",
        {
          type: "object",
          properties: { score: { type: "number" }, sentiment: { type: "string" }, intent_signals: { type: "array", items: { type: "string" } } },
          required: ["score", "sentiment", "intent_signals"]
        }
      );
      
      await base44.entities.Lead.update(lead.id, {
        score: aiResult.score, sentiment: aiResult.sentiment, intent_signals: aiResult.intent_signals
      });

      return c.json({ success: true, lead_id: lead.id, new_score: aiResult.score });
    }
    
    return c.json({ error: "Bulk mode skipped in simplified version." }, 501);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}

export async function buildLeadContextHandler(c: Context) {
  try {
    const { lead_id } = await c.req.json();
    const lead = await base44.entities.Lead.get(lead_id);
    if (!lead) return c.json({ error: "Lead not found" }, 404);

    const callLogs = await base44.entities.CallLog.filter({ lead_id: lead.id }, "-created_at", 5);
    const sections = [
      `CUSTOMER PROFILE:`,
      `- Name: ${lead.name || "Unknown"}`,
      `- Phone: ${lead.phone}`,
      `- Current Status: ${lead.status}`,
    ];

    if (callLogs.length > 0) {
      sections.push(`\nPREVIOUS CALL HISTORY (last ${callLogs.length}):`);
      callLogs.forEach((cl: any, i: number) => {
        sections.push(`Call ${i + 1} (${cl.status}):`);
        if (cl.conversation_summary) sections.push(`  Summary: ${cl.conversation_summary.substring(0, 300)}`);
      });
    }

    return c.json({ success: true, context_text: sections.join("\n") });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}
