import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Generates a structured AI CV/profile for a ServiceProvider candidate.
// Uses Azure OpenAI directly (client's own keys — NOT Base44 integration credits).
// Works from profile data alone, and enriches with screening answers when available.
//
// Input: { provider_id }
// Output: { success, data: {...cv...} }  (also persisted to provider.screening_answers.ai_cv_data)

const AZURE_API_VERSION = '2024-08-01-preview';

function azureCfg() {
  const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI not configured');
  return { url: `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`, apiKey };
}

export default async function generateCandidateCV(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { provider_id } = await c.req.json();
    if (!provider_id) return c.json({ data: { error: 'provider_id required' } }, 400);

    const provider = await base44.entities.ServiceProvider.get(provider_id);
    if (!provider) return c.json({ data: { error: 'Candidate not found' } }, 404);

    // Optional screening enrichment
    let screening = null;
    if (provider.screening_call_id || provider.screening_template_id) {
      const calls = await base44.entities.ScreeningCall.filter(
        { provider_id, status: 'completed' }, '-created_date', 1
      ).catch(() => []);
      screening = calls?.[0] || null;
    }
    const answers = screening?.extracted_answers || provider.screening_answers || {};

    const prompt = `Analyze this candidate's data and generate a structured profile/CV.

CANDIDATE:
- Name: ${provider.name}
- Phone: ${provider.phone}
- Email: ${provider.email || ''}
- Category: ${(provider.category || '').replace(/_/g, ' ')}
- Location: ${provider.location || ''}
- Experience: ${provider.experience_years || ''} years
- Education: ${provider.education || ''}
- Current Role: ${provider.current_role || ''}
- Current Company: ${provider.current_company || ''}
- Skills: ${(provider.skills || []).join(', ')}
- Expected Salary: ${provider.expected_salary || ''}
- Languages: ${(provider.languages_spoken || []).join(', ')}
- Availability: ${(provider.availability || 'immediate').replace(/_/g, ' ')}

SCREENING ANSWERS:
${Object.entries(answers).map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${typeof v === 'object' && v ? v.answer : v}`).join('\n') || '(none — build from profile data)'}

SCREENING SUMMARY: ${screening?.ai_summary || provider.screening_summary || ''}
STRENGTHS: ${(screening?.strengths || []).join(', ')}
RED FLAGS: ${(screening?.red_flags || []).join(', ')}

Return ONLY valid JSON with these fields (fill from available data, use empty string/false if unknown — do NOT invent specifics):
{
  "full_name": "",
  "headline": "Short 1-line profile summary",
  "about": "2-3 sentence professional summary paragraph",
  "experience_summary": "Brief description of work history",
  "skills_list": ["skill1", "skill2"],
  "work_preferences": { "type": "", "timing": "", "location": "" },
  "personal_details": { "age": "", "marital_status": "", "native_place": "" },
  "cooking_details": { "cuisine": "", "level": "" },
  "childcare_details": { "can_do": false, "age_range": "" },
  "documents": { "photo": false, "id_proof": false },
  "strengths": ["strength1"],
  "areas_of_concern": ["concern1"],
  "overall_rating": "Excellent/Good/Average/Below Average",
  "recommendation": "1-2 sentence hiring recommendation"
}`;

    const { url, apiKey } = azureCfg();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You build structured candidate profiles/CVs from recruiter data. Always return valid JSON.' },
          { role: 'user', content: prompt }
        ],
        max_completion_tokens: 1800,
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) throw new Error(`Azure HTTP ${res.status}`);
    const cv = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');

    // Persist for reuse
    const existingAnswers = provider.screening_answers || {};
    await base44.entities.ServiceProvider.update(provider_id, {
      screening_answers: { ...existingAnswers, ai_cv_data: cv }
    });

    return c.json({ data: { success: true, data: cv } });
  } catch (error) {
    console.error('[generateCandidateCV] Error:', error.message);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};