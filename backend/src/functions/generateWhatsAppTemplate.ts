import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";


// Direct Azure OpenAI call — bypasses Base44 integration credits.
async function callAzureOpenAI(prompt, { maxTokens = 2000, jsonMode = true } = {}) {
            if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI secrets not configured');

  const body = {
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: maxTokens
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const r = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Azure OpenAI ${r.status}: ${errText.substring(0, 300)}`);
  }
  const data = await r.json();
  const content = (data.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('Azure OpenAI returned empty response');
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Azure OpenAI returned invalid JSON: ${content.substring(0, 200)}`);
  }
}

export default async function generateWhatsAppTemplate(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { mode, prompt } = await c.req.json();
    if (!mode || !prompt) return c.json({ data: { error: 'mode and prompt required' } }, 400);

    // mode = 'suggest' or 'generate' — both are JSON responses, just different schemas embedded in prompt.
    const result = await callAzureOpenAI(prompt, { maxTokens: mode === 'suggest' ? 1500 : 2000, jsonMode: true });
    return c.json({ data: { success: true, result } });
  } catch (error) {
    console.error('generateWhatsAppTemplate error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};