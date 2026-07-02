import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// AI-powered job ↔ candidate matching.
// Given a job_id, fetches candidates of the same category and uses LLM to score
// each one against the job's requirements. Returns ranked matches with reasoning.
// Uses Azure OpenAI directly (client's own keys — NOT Base44 integration credits).

const AZURE_API_VERSION = '2025-04-01-preview';

function azureCfg() {
  const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI not configured');
  return { url: `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`, apiKey };
}

export default async function matchCandidatesToJob(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { job_id, max_candidates = 50 } = await c.req.json();
    if (!job_id) return c.json({ data: { error: 'job_id is required' } }, 400);

    const job = await base44.asServiceRole.entities.JobOpportunity.get(job_id);
    if (!job) return c.json({ data: { error: 'Job not found' } }, 404);

    // Fetch candidates in same category, prioritising passed/screened ones
    const candidates = await base44.asServiceRole.entities.ServiceProvider.filter(
      { client_id: job.client_id, category: job.category },
      '-screening_score',
      max_candidates
    );

    if (candidates.length === 0) {
      return c.json({ data: {
        success: true,
        job: { id: job.id, title: job.title },
        matches: [],
        message: `No candidates found in category "${job.category}".`
      } });
    }

    // Build compact job + candidate context for the LLM
    const jobBrief = {
      title: job.title,
      category: job.category,
      city: job.city || job.location || '',
      work_type: job.work_type || '',
      work_mode: job.work_mode || '',
      min_experience_years: job.min_experience_years || 0,
      education_required: job.education_required || '',
      required_skills: job.required_skills || [],
      requirements: job.requirements || [],
      salary_range_min: job.salary_range_min || 0,
      salary_range_max: job.salary_range_max || 0,
    };

    const candidateBriefs = candidates.map(c => ({
      id: c.id,
      name: c.name,
      experience_years: c.experience_years || 0,
      education: c.education || '',
      current_role: c.current_role || '',
      current_company: c.current_company || '',
      skills: c.skills || [],
      languages: c.languages_spoken || [],
      location: c.location || '',
      expected_salary: c.expected_salary || 0,
      screening_score: c.screening_score || 0,
      screening_status: c.screening_status || 'not_screened',
      screening_summary: c.screening_summary || '',
      availability: c.availability || '',
    }));

    const prompt = `You are an expert recruiter matching candidates to a job.

JOB:
${JSON.stringify(jobBrief, null, 2)}

CANDIDATES (${candidateBriefs.length} total):
${JSON.stringify(candidateBriefs, null, 2)}

For EACH candidate, score them 0-100 on fit for this job.

Scoring guide:
- 85-100: Excellent match — meets/exceeds all key requirements
- 70-84: Good match — meets most requirements, minor gaps
- 50-69: Partial match — some relevant skills but key gaps
- 30-49: Weak match — limited relevance
- 0-29: Poor match — does not fit

Consider: skills overlap, experience level, education, salary expectations vs range, location/city,
language fit, availability, and prior screening score.

Return JSON ONLY:
{
  "matches": [
    {
      "candidate_id": "<id>",
      "match_score": 0-100,
      "tier": "excellent|good|partial|weak|poor",
      "key_strengths": ["short bullet", "..."],
      "gaps": ["short bullet", "..."],
      "reason": "1-2 sentence summary"
    }
  ]
}

Return ALL ${candidateBriefs.length} candidates, sorted by match_score descending.`;

    const { url, apiKey } = azureCfg();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are an expert recruiter. Always return valid JSON.' },
          { role: 'user', content: prompt }
        ],
        max_completion_tokens: 4000,
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) throw new Error(`Azure HTTP ${res.status}`);
    const llmResp = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');

    const llmMatches = (llmResp?.matches || []);

    // Merge LLM output with candidate data for the UI
    const candidateMap = new Map(candidates.map(c => [c.id, c]));
    const enriched = llmMatches
      .map(m => {
        const c = candidateMap.get(m.candidate_id);
        if (!c) return null;
        return {
          candidate_id: c.id,
          name: c.name,
          phone: c.phone,
          category: c.category,
          location: c.location || '',
          experience_years: c.experience_years || 0,
          expected_salary: c.expected_salary || 0,
          screening_status: c.screening_status || 'not_screened',
          screening_score: c.screening_score || 0,
          skills: c.skills || [],
          match_score: m.match_score || 0,
          tier: m.tier || 'partial',
          key_strengths: m.key_strengths || [],
          gaps: m.gaps || [],
          reason: m.reason || '',
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.match_score - a.match_score);

    // Persist top matched candidate IDs onto the job (top 20)
    const topIds = enriched.slice(0, 20).map(m => m.candidate_id);
    await base44.asServiceRole.entities.JobOpportunity.update(job_id, {
      matched_providers: topIds
    });

    return c.json({ data: {
      success: true,
      job: { id: job.id, title: job.title, category: job.category },
      matches: enriched,
      total_candidates_considered: candidateBriefs.length,
    } });

  } catch (error) {
    console.error('[matchCandidatesToJob] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};