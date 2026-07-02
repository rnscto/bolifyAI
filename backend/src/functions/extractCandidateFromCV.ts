import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";


// Extracts structured candidate info from an uploaded CV/resume.
// Uses Azure OpenAI directly (client's own keys — NOT Base44 integration credits).
//
// Input: { resume_url } — a public Azure Blob URL (from azureBlobUpload).
//        OR { cv_text } — pre-extracted plain text.
//
// Strategy (mirrors extractKBContent): download the file, extract RAW TEXT natively
// (pdf via unpdf, docx via JSZip, images via Azure vision OCR), THEN send the text to
// Azure OpenAI for structured extraction. Azure vision does NOT accept PDFs as image_url.

const CATEGORIES = [
  'domestic_help','driver','cook','nanny','security','office_staff','software_engineer',
  'sales','marketing','finance','hr','customer_support','operations','design',
  'data_analyst','management','healthcare','education','legal','custom'
];

function azureCfg() {
        if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI not configured');
  return { url: "__CHAT_COMPLETIONS_MIGRATED__", apiKey };
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

// Image OCR via Azure vision (images ARE supported as image_url; PDFs are NOT)
async function ocrImage(b64, mimeType) {
  const { url, apiKey } = azureCfg();
  const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extract ALL text visible in this resume image (OCR). Return ONLY the raw text, preserving structure. Do not summarize.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
        ]
      }],
      max_completion_tokens: 4000
    })
  });
  if (!res.ok) throw new Error(`Azure vision HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content || '';
}

async function structureFromText(cvText) {
  const { url, apiKey } = azureCfg();
  const instruction = `Extract candidate information from this CV/resume text. Respond ONLY in valid JSON with this EXACT structure (use null/empty for unknowns, never invent data):
{
  "name": "full name or null",
  "phone": "phone with country code or null",
  "email": "email or null",
  "category": "ONE of: ${CATEGORIES.join(', ')} (best fit for their profession)",
  "skills": ["skill1", "skill2"],
  "experience_years": 0,
  "education": "highest qualification or null",
  "current_company": "most recent employer or null",
  "current_role": "most recent job title or null",
  "location": "city/area or null",
  "languages_spoken": ["English", "Hindi"],
  "expected_salary": 0,
  "summary": "2-3 sentence professional summary"
}

CV TEXT:
${cvText.substring(0, 14000)}`;

  const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are an expert recruiter that extracts structured data from resumes. Always return valid JSON, fill every field, never fabricate.' },
        { role: 'user', content: instruction }
      ],
      max_completion_tokens: 1500,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`Azure HTTP ${res.status}`);
  const raw = (await res.json()).choices?.[0]?.message?.content || '{}';
  return JSON.parse(raw);
}

export default async function extractCandidateFromCV(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { resume_url, cv_text } = await c.req.json();
    if (!resume_url && !cv_text) {
      return c.json({ data: { error: 'resume_url or cv_text required' } }, 400);
    }

    // 1. Get raw CV text
    let text = cv_text || '';
    if (!text && resume_url) {
      const ext = (resume_url.split('.').pop() || '').toLowerCase().split('?')[0];
      const resp = await fetch(resume_url);
      if (!resp.ok) throw new Error(`Failed to download CV (HTTP ${resp.status})`);
      const arrayBuf = await resp.arrayBuffer();

      if (ext === 'pdf') {
        text = await extractPdfText(arrayBuf);
        if (!text || text.length < 20) {
          return c.json({ data: { success: false, error: 'This PDF appears to be scanned (no selectable text). Please upload a text-based PDF or an image of the CV.' } });
        }
      } else if (['docx', 'doc'].includes(ext)) {
        text = await extractDocxText(arrayBuf);
      } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        text = await ocrImage(bufferToBase64(arrayBuf), mimeType);
      } else {
        // Fallback: plain text decode
        text = new TextDecoder('utf-8').decode(arrayBuf);
      }
    }

    if (!text || text.trim().length < 20) {
      return c.json({ data: { success: false, error: 'Could not read any text from this CV.' } });
    }

    // 2. Structure it
    let data;
    try {
      data = await structureFromText(text);
    } catch (e) {
      console.error('[extractCandidateFromCV] structure failed:', e.message);
      return c.json({ data: { success: false, error: 'Could not extract candidate details from the CV.' } });
    }

    if (!CATEGORIES.includes(data.category)) data.category = 'custom';
    return c.json({ data: { success: true, data } });
  } catch (error) {
    console.error('[extractCandidateFromCV] Error:', error.message);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};