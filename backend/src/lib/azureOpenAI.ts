/**
 * ─── Shared Azure OpenAI HTTP Helper ─────────────────────────────────────────
 *
 * Centralises endpoint construction and API version for Azure AI Foundry
 * (services.ai.azure.com) and classic Azure OpenAI (openai.azure.com).
 *
 * Both endpoint styles are supported:
 *  - Classic:  https://<name>.openai.azure.com
 *  - Foundry:  https://<name>.services.ai.azure.com/openai/v1/responses  (auto-stripped)
 *
 * API version 2025-04-01-preview is the minimum required for gpt-4.1 / gpt-5
 * class models on services.ai.azure.com. Using 2024-08-01-preview on that
 * endpoint returns HTTP 400 "The requested operation is unsupported."
 */

const AZURE_API_VERSION = "2025-04-01-preview";

export interface AzureLLMConfig {
  url: string;       // Full chat completions URL
  apiKey: string;    // api-key value
  deployment: string;
}

/**
 * Builds the Azure OpenAI Chat Completions URL from the raw env var value.
 * Handles both classic openai.azure.com and Foundry services.ai.azure.com.
 */
export function getAzureConfig(): AzureLLMConfig {
  let baseUrl = (Deno.env.get("AZURE_OPENAI_ENDPOINT") || "").replace(/\/+$/, "");
  const apiKey = Deno.env.get("AZURE_OPENAI_KEY") || "";
  const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || "";

  // Strip any path suffix that was part of the Responses/Completions API path
  // so we can rebuild the correct chat/completions path ourselves.
  const stripAt = baseUrl.indexOf("/openai/");
  if (stripAt > 0) baseUrl = baseUrl.substring(0, stripAt);

  const projectIdx = baseUrl.indexOf("/api/projects");
  if (projectIdx > 0) baseUrl = baseUrl.substring(0, projectIdx);

  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;
  return { url, apiKey, deployment };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

/**
 * Calls Azure OpenAI Chat Completions and returns the assistant message text.
 * Throws on non-2xx responses with the raw error body included.
 */
export async function callAzureLLM(
  messages: ChatMessage[],
  opts: {
    maxTokens?: number;
    temperature?: number;
    responseFormat?: { type: "json_object" } | null;
  } = {}
): Promise<string> {
  const { url, apiKey } = getAzureConfig();

  const body: Record<string, unknown> = {
    messages,
    max_completion_tokens: opts.maxTokens ?? 4000,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Azure OpenAI HTTP ${r.status}: ${text.substring(0, 600)}`);
  }

  const data = await r.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}
