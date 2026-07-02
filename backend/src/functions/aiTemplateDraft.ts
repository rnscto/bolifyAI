import { Context } from "hono";

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const { goal, language = 'en', category = 'UTILITY', tone = 'friendly', max_variables = 4 } = payload;
    
    if (!goal) {
      return c.json({ data: { success: false, error: 'goal is required' } });
    }

    let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
    const oIdx = baseUrl.indexOf('/openai/'); 
    if (oIdx > 0) baseUrl = baseUrl.substring(0, oIdx);

    if (!baseUrl || !deployment || !apiKey) {
      return c.json({ data: { success: false, error: 'Azure OpenAI not configured' } });
    }

    const res = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `You are an expert at writing WhatsApp Business message templates that comply with Meta's policies.
Rules:
- ${category === 'MARKETING' ? 'Marketing templates may include promotions/offers' : category === 'AUTHENTICATION' ? 'Authentication templates are short OTP/login codes only' : 'Utility templates confirm a transaction or send notifications related to existing customer interaction'}
- Use {{1}}, {{2}}, etc. for variables (max ${max_variables}). Keep them in order.
- Body 1024 chars max. Footer 60 chars max. Header text 60 chars max.
- ${tone} tone, in ${language === 'hi' ? 'Hindi' : language === 'en' ? 'English' : language}.
- Generate sample values that match each variable.
- Suggest a snake_case template name (lowercase, underscore, no spaces).
- Optionally suggest 1-2 buttons (QUICK_REPLY or URL).
Respond ONLY in valid JSON.`
          },
          {
            role: 'user',
            content: `Goal: ${goal}\n\nReturn JSON with shape:
{
  "name": "snake_case_name",
  "body_text": "...with {{1}} {{2}}...",
  "body_examples": ["sample for {{1}}", "sample for {{2}}"],
  "footer_text": "optional footer",
  "header_type": "NONE|TEXT",
  "header_text": "optional",
  "buttons": [{"type":"QUICK_REPLY|URL","text":"...","url":"https://..."}],
  "variables_description": ["what {{1}} represents", "what {{2}} represents"]
}`
          }
        ],
        max_completion_tokens: 800,
        response_format: { type: 'json_object' }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return c.json({ data: { success: false, error: 'Azure OpenAI error', detail: errText.substring(0, 500) } });
    }
    const data = await res.json();
    const draft = JSON.parse(data.choices[0].message.content);
    
    return c.json({ data: { success: true, draft } });
  } catch (error: any) {
    console.error('[aiTemplateDraft] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
