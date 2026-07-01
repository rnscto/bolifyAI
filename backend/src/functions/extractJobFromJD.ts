import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Extracts a structured Job + screening questions from a Job Description (JD).
// Uses Azure OpenAI directly (client's own keys — NOT Base44 integration credits).
//
// Input: { jd_text } — pasted JD text. OR { jd_url } — public Azure Blob URL (pdf/docx/image).
// Output: { success, data: { job: {...}, questions: [...] } }

const AZURE_API_VERSION = '2024-08-01-preview';

const CATEGORIES = [
  'domestic_help','driver','cook','nanny','security','office_staff','software_engineer',
  'sales','marketing','finance','hr','customer_support','operations','design',
  'data_analyst','management','healthcare','education','legal','custom'
];

function azureCfg() {
  const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI not configured');
  return { url: `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`, apiKey };
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

async function extractPdfText(arrayBuf) {
  const { extractText, getDocumentProxy } = await import('npm:unpdf@0.12.1');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuf));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n') : text || '').trim();
}

async function extractDocxText(arrayBuf) {
  const { default: JSZip } = await import('npm:jszip@3.10.1');
  const zip = await JSZip.loadAsync(arrayBuf);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) throw new Error('Invalid DOCX');
  return docXml
    .replace(/<w:p[^>]*>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function ocrImage(b64, mimeType) {
  const { url, apiKey } = azureCfg();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extract ALL text visible in this job description image (OCR). Return ONLY the raw text. Do not summarize.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
        ]
      }],
      max_completion_tokens: 4000
    })
  });
  if (!res.ok) throw new Error(`Azure vision HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content || '';
}

async function structureFromText(jdText) {
  const { url, apiKey } = azureCfg();
  const instruction = `You are an expert recruiter. From this Job Description, produce (1) a structured job posting and (2) a set of screening questions to ask candidates over a phone call. Respond ONLY in valid JSON with this EXACT structure (use null/empty for unknowns, never invent specifics):
{
  "job": {
    "title": "job title",
    "category": "ONE of: ${CATEGORIES.join(', ')}",
    "department": "department or null",
    "location": "area/location or null",
    "city": "city or null",
    "work_mode": "onsite | remote | hybrid",
    "work_type": "full_time | part_time | live_in | hourly | contract | freelance | internship",
    "min_experience_years": 0,
    "education_required": "e.g. B.Tech or null",
    "required_skills": ["skill1", "skill2"],
    "requirements": ["requirement1", "requirement2"],
    "salary_range_min": 0,
    "salary_range_max": 0
  },
  "questions": [
    {
      "question_text": "question in Hindi (Devanagari) for the phone screening",
      "question_text_en": "English translation",
      "field_key": "snake_case_key",
      "answer_type": "text | number | yes_no | open_ended",
      "scoring_weight": 1
    }
  ]
}
Generate 5-8 relevant, role-specific screening questions that verify the candidate meets the JD (experience, skills, availability, expected salary, location). salary values are monthly INR amounts.

JOB DESCRIPTION:
${jdText.substring(0, 14000)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You convert job descriptions into structured job postings and phone-screening questions. Always return valid JSON.' },
        { role: 'user', content: instruction }
      ],
      max_completion_tokens: 2500,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`Azure HTTP ${res.status}`);
  const raw = (await res.json()).choices?.[0]?.message?.content || '{}';
  return JSON.parse(raw);
}

export default async function extractJobFromJD(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { jd_text, jd_url } = await c.req.json();
    if (!jd_text && !jd_url) {
      return c.json({ data: { error: 'jd_text or jd_url required' } }, 400);
    }

    // 1. Get raw JD text
    let text = jd_text || '';
    if (!text && jd_url) {
      const ext = (jd_url.split('.').pop() || '').toLowerCase().split('?')[0];
      const resp = await fetch(jd_url);
      if (!resp.ok) throw new Error(`Failed to download JD (HTTP ${resp.status})`);
      const arrayBuf = await resp.arrayBuffer();
      if (ext === 'pdf') {
        text = await extractPdfText(arrayBuf);
        if (!text || text.length < 20) {
          return c.json({ data: { success: false, error: 'This PDF appears to be scanned (no selectable text). Please paste the JD text or upload a text-based file.' } });
        }
      } else if (['docx', 'doc'].includes(ext)) {
        text = await extractDocxText(arrayBuf);
      } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        text = await ocrImage(bufferToBase64(arrayBuf), mimeType);
      } else {
        text = new TextDecoder('utf-8').decode(arrayBuf);
      }
    }

    if (!text || text.trim().length < 20) {
      return c.json({ data: { success: false, error: 'Could not read the job description.' } });
    }

    // 2. Structure it
    let data;
    try {
      data = await structureFromText(text);
    } catch (e) {
      console.error('[extractJobFromJD] structure failed:', e.message);
      return c.json({ data: { success: false, error: 'Could not extract job details from the JD.' } });
    }

    const job = data.job || {};
    if (!CATEGORIES.includes(job.category)) job.category = 'custom';
    const questions = Array.isArray(data.questions) ? data.questions : [];

    return c.json({ data: { success: true, data: { job, questions } } });
  } catch (error) {
    console.error('[extractJobFromJD] Error:', error.message);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};