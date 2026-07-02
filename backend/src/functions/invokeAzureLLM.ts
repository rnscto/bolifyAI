import { base44ORM as base44 } from "../db/orm.ts";
import { callAzureLLM } from "../lib/azureOpenAI.ts";

/**
 * Drop-in replacement for base44.integrations.Core.InvokeLLM
 * using the user's Azure OpenAI Responses API (gpt-5.4-pro).
 *
 * Accepts: { prompt, response_json_schema, file_urls }
 * Returns: { result } — parsed object if schema provided, string otherwise.
 */
export default async function invokeAzureLLM(c: any) {
  try {
    const user = c.get("jwtPayload");
    if (!user) return c.json({ data: { error: "Unauthorized" } }, 401);

    // ── Per-user rate limit: 30 AI calls / minute (cost-DoS protection) ──
    const LLM_LIMIT_PER_MIN = 30;
    try {
      const svc = base44.asServiceRole;
      const windowStart = new Date();
      windowStart.setSeconds(0, 0);
      const bucketKey = `user:${user.id}:llm:${windowStart.toISOString()}`;
      const existing = await svc.entities.RateBucket.filter({ bucket_key: bucketKey });
      const bucket = existing[0];
      if (bucket) {
        if ((bucket.count || 0) >= LLM_LIMIT_PER_MIN) {
          return c.json({ data: { error: "Rate limit exceeded (30 AI calls/min). Please wait." } }, 429);
        }
        await svc.entities.RateBucket.update(bucket.id, { count: (bucket.count || 0) + 1 });
      } else {
        await svc.entities.RateBucket.create({
          bucket_key: bucketKey, identity: user.id, endpoint: "llm",
          window_start: windowStart.toISOString(), count: 1,
        });
      }
    } catch (rlErr: any) {
      console.error("invokeAzureLLM rate-limit check failed (allowing):", rlErr.message);
    }

    const { prompt, response_json_schema, file_urls } = await c.req.json();
    if (!prompt) return c.json({ data: { error: "prompt required" } }, 400);

    // Build user content — text + optional image URLs
    const userContent: any[] = [{ type: "text", text: prompt }];
    if (Array.isArray(file_urls)) {
      for (const u of file_urls) {
        if (typeof u === "string" && /^https?:\/\//i.test(u)) {
          userContent.push({ type: "image_url", image_url: { url: u } });
        }
      }
    }

    const systemPrompt = response_json_schema
      ? "You are a helpful assistant. Always respond with valid JSON matching the user-provided schema. Do not include markdown fences."
      : "You are a helpful assistant.";

    const text = await callAzureLLM(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent.length === 1 ? prompt : userContent },
      ],
      {
        maxTokens: 4000,
        responseFormat: response_json_schema ? { type: "json_object" } : null,
      }
    );

    if (response_json_schema) {
      try {
        return c.json({ data: { result: JSON.parse(text) } });
      } catch {
        // Try to extract JSON between first { and last }
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try { return c.json({ data: { result: JSON.parse(m[0]) } }); } catch {}
        }
        return c.json({ data: { error: "AI did not return valid JSON", raw: text.substring(0, 500) } }, 502);
      }
    }

    return c.json({ data: { result: text } });
  } catch (error: any) {
    console.error("[invokeAzureLLM]", error.message);
    return c.json({ data: { error: error.message } }, 500);
  }
}