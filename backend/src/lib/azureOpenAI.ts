/**
 * ─── Azure OpenAI Responses API Helper ───────────────────────────────────────
 *
 * Implements the Azure AI Foundry Responses API (v1/responses).
 * Reference: https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/responses
 *
 * Endpoint format (from .env):
 *   AZURE_OPENAI_ENDPOINT = "https://<resource>.services.ai.azure.com/openai/v1/responses"
 *   AZURE_OPENAI_DEPLOYMENT = "gpt-5.4-pro"
 *   AZURE_OPENAI_KEY = "<api-key>"
 *
 * Request:
 *   POST {endpoint}
 *   api-key: {key}
 *   { "model": "{deployment}", "input": "text or [{role,content}]", "instructions"?: "system" }
 *
 * Response:  { "output_text": "...", ... }
 *
 * NO api-version query param — /v1/ in the path IS the version.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

export interface AzureLLMOptions {
  maxTokens?: number;
  temperature?: number;
  /** Pass { type: "json_object" } to request JSON output */
  responseFormat?: { type: "json_object" } | null;
}

/**
 * Calls the Azure OpenAI Responses API.
 *
 * Accepts a messages array (same shape as Chat Completions) and converts it:
 *   - `system` messages → `instructions` field
 *   - remaining messages → `input` field (single string or array)
 *
 * Returns the `output_text` string from the response.
 * Throws an Error with the HTTP status and body on failure.
 */
export async function callAzureLLM(
  messages: ChatMessage[],
  opts: AzureLLMOptions = {}
): Promise<string> {
  const endpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT") || "";
  const apiKey   = Deno.env.get("AZURE_OPENAI_KEY")      || "";
  const model    = Deno.env.get("AZURE_OPENAI_DEPLOYMENT")|| "";

  if (!endpoint || !apiKey || !model) {
    throw new Error("Azure OpenAI not configured: missing AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, or AZURE_OPENAI_DEPLOYMENT");
  }

  // Split system message from user/assistant turns
  const systemMsg = messages.find((m) => m.role === "system");
  const turns     = messages.filter((m) => m.role !== "system");

  // `input`: single string for simple prompts, array for multi-turn conversations
  const input = turns.length === 1 && typeof turns[0].content === "string"
    ? turns[0].content
    : turns.map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model,
    input,
  };

  if (systemMsg) {
    body.instructions = typeof systemMsg.content === "string"
      ? systemMsg.content
      : JSON.stringify(systemMsg.content);
  }

  // Responses API uses max_output_tokens (not max_completion_tokens)
  if (opts.maxTokens)    body.max_output_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  // JSON mode: pass text.format
  if (opts.responseFormat?.type === "json_object") {
    body.text = { format: { type: "json_object" } };
  }

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Azure OpenAI HTTP ${r.status}: ${errText.substring(0, 600)}`);
  }

  const data = await r.json();

  // Primary path: top-level output_text (Responses API shorthand)
  if (typeof data.output_text === "string") return data.output_text.trim();

  // Fallback: output[].content[].text (for multi-turn or structured responses)
  const outputText = data.output?.[0]?.content?.find(
    (c: any) => c.type === "output_text"
  )?.text;
  if (typeof outputText === "string") return outputText.trim();

  // Last resort: stringify the entire output for debugging
  console.error("[callAzureLLM] Unexpected response shape:", JSON.stringify(data).substring(0, 400));
  return "";
}

/**
 * ── Drop-in Chat Completions compatibility wrapper ────────────────────────────
 *
 * Accepts the same body shape as the Chat Completions API and returns a
 * Chat Completions-compatible response object, so existing callers that parse
 *   data.choices?.[0]?.message?.content
 * do not need to change their response parsing — only the fetch() call.
 *
 * Usage (replace your fetch block with):
 *   const data = await azureChatCompletionsCompat({ messages, max_completion_tokens: 800, response_format: { type: 'json_object' } });
 *   const text = data.choices?.[0]?.message?.content ?? '';
 */
export async function azureChatCompletionsCompat(body: {
  messages: ChatMessage[];
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: string } | null;
}): Promise<{ choices: [{ message: { content: string } }] }> {
  const text = await callAzureLLM(body.messages, {
    maxTokens:      body.max_completion_tokens ?? body.max_tokens ?? 4000,
    temperature:    body.temperature,
    responseFormat: body.response_format?.type === "json_object"
      ? { type: "json_object" }
      : null,
  });
  return { choices: [{ message: { content: text } }] };
}

/**
 * Convenience: single-turn text-only call (no messages array needed).
 */
export async function askAzureLLM(
  prompt: string,
  systemPrompt?: string,
  opts: AzureLLMOptions = {}
): Promise<string> {
  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });
  return callAzureLLM(messages, opts);
}

/**
 * ── fetch() compatibility shim ────────────────────────────────────────────────
 *
 * Drop-in replacement for fetch() that intercepts any call targeting:
 *  - The sentinel URL "__CHAT_COMPLETIONS_MIGRATED__" (set by bulk migration)
 *  - Any URL containing "chat/completions" (covers residual calls)
 *
 * For those calls it routes through the Responses API via callAzureLLM().
 * All other URLs are forwarded to the real fetch() unchanged.
 *
 * Usage (minimal change per file):
 *   Replace:  const r = await fetch(url, options);
 *   With:     const r = await azureFetchCompat(url, options);
 *
 * The existing r.ok, r.json(), data.choices[0].message.content chain
 * continues to work because this returns a compatible Response-like object.
 */
export async function azureFetchCompat(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const isChatCompletions =
    url === "__CHAT_COMPLETIONS_MIGRATED__" ||
    url.includes("chat/completions");

  if (!isChatCompletions) {
    return fetch(url, options);
  }

  try {
    let body: {
      messages?: ChatMessage[];
      max_completion_tokens?: number;
      max_tokens?: number;
      temperature?: number;
      response_format?: { type: string } | null;
    } = {};

    if (typeof options.body === "string") {
      try {
        body = JSON.parse(options.body);
      } catch {
        // If body can't be parsed, fall back to real fetch
        return fetch(url, options);
      }
    }

    const result = await azureChatCompletionsCompat({
      messages:              body.messages ?? [],
      max_completion_tokens: body.max_completion_tokens ?? body.max_tokens,
      temperature:           body.temperature,
      response_format:       body.response_format,
    });

    return new Response(JSON.stringify(result), {
      status:  200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    // Return a 500-like error Response so callers can handle r.ok === false
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
