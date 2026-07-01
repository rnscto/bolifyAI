import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// extractKBContent — Phase 2 migration
//
// Replaces Core.ExtractDataFromUploadedFile + Core.InvokeLLM (which require
// integration credits) with direct Azure OpenAI calls + native parsing.
//
// Supported file types:
//   - txt, csv, json, html, md  → direct text decode
//   - docx, doc                  → JSZip XML extraction (already worked)
//   - pdf                        → Azure OpenAI multimodal (vision) extraction
//   - png, jpg, jpeg, webp       → Azure OpenAI multimodal (vision) extraction
// ═══════════════════════════════════════════════════════════════════



const AZURE_API_VERSION = '2024-08-01-preview';

// ─── Azure OpenAI text-only call ───
async function azureLLMText(prompt) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI not configured');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 8000
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Azure OpenAI multimodal call (image / pdf as base64) ───
async function azureLLMVision(base64Data, mimeType, instruction) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI not configured');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
        ]
      }],
      max_completion_tokens: 8000
    })
  });
  if (!res.ok) throw new Error(`Azure vision error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Encode buffer to base64 (chunked to avoid stack overflow on large files) ───
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

// ─── PDF text extraction (native, no vision API) ───
// Azure OpenAI vision does NOT accept application/pdf — it only takes images.
// unpdf parses the PDF text layer directly (works for digital/text PDFs).
async function extractPdfText(arrayBuf) {
  const { extractText, getDocumentProxy } = await import('npm:unpdf@0.12.1');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuf));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n') : text || '').trim();
}

// ─── XLSX → text extraction via SheetJS ───
async function extractXlsxText(arrayBuf) {
  const XLSX = await import('npm:xlsx@0.18.5');
  const wb = XLSX.read(new Uint8Array(arrayBuf), { type: 'array' });
  let out = '';
  for (const name of wb.SheetNames) {
    out += `[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[name]) + '\n\n';
  }
  return out.trim();
}

// ─── DOCX text extraction via JSZip ───
async function extractDocxText(arrayBuf) {
  const { default: JSZip } = await import('npm:jszip@3.10.1');
  const zip = await JSZip.loadAsync(arrayBuf);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) throw new Error('Invalid DOCX: no document.xml found');
  return docXml
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── HTML → plain text (strip tags) ───
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function extractKBContent(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const payload = await c.req.json();
    const { event, data } = payload;

    let kbId = null;
    let fileUrl = null;

    if (event && event.entity_name === 'KnowledgeBase' && event.type === 'create') {
      kbId = event.entity_id;
      fileUrl = data?.file_url;
    } else if (payload.kb_id) {
      kbId = payload.kb_id;
      const kb = await svc.entities.KnowledgeBase.get(kbId);
      if (!kb) return c.json({ data: { error: 'KB not found' } }, 400);
      fileUrl = kb.file_url;
    } else {
      return c.json({ data: { success: true, skipped: 'no_matching_trigger' } });
    }

    if (!fileUrl) {
      console.log(`[extractKB] No file_url on KB ${kbId}, skipping`);
      return c.json({ data: { success: true, skipped: 'no_file_url' } });
    }

    console.log(`[extractKB] Extracting content from KB ${kbId}: ${fileUrl}`);

    const ext = (fileUrl.split('.').pop() || '').toLowerCase().split('?')[0];
    let content = '';

    // Download the file once
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();

    if (['docx', 'doc'].includes(ext)) {
      console.log(`[extractKB] DOCX extraction (${ext})`);
      content = await extractDocxText(arrayBuf);
    } else if (['txt', 'md', 'csv', 'json', 'log'].includes(ext)) {
      console.log(`[extractKB] Plain text decode (${ext})`);
      content = new TextDecoder('utf-8').decode(arrayBuf);
    } else if (['html', 'htm'].includes(ext)) {
      console.log(`[extractKB] HTML strip-tags (${ext})`);
      content = htmlToText(new TextDecoder('utf-8').decode(arrayBuf));
    } else if (ext === 'pdf') {
      console.log(`[extractKB] PDF native text extraction`);
      content = await extractPdfText(arrayBuf);
      if (!content || content.trim().length < 20) {
        console.log(`[extractKB] PDF text layer empty — scanned/image PDF, cannot extract text natively.`);
        await svc.entities.KnowledgeBase.update(kbId, {
          status: 'failed',
          content: '⚠️ This PDF appears to be scanned (image-only) with no selectable text. Please re-upload a text-based PDF, or paste the content as a text/Word document.'
        });
        return c.json({ data: { success: false, error: 'scanned_pdf_no_text_layer' } });
      }
    } else if (['xlsx', 'xls'].includes(ext)) {
      console.log(`[extractKB] XLSX extraction (${ext})`);
      content = await extractXlsxText(arrayBuf);
    } else if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      console.log(`[extractKB] Image via Azure vision (${ext})`);
      const b64 = bufferToBase64(arrayBuf);
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      content = await azureLLMVision(
        b64,
        mimeType,
        'Extract ALL text visible in this image (OCR). Return ONLY the raw text, preserving structure. Do not summarize.'
      );
    } else {
      // Unknown extension — try plain text decode as a fallback
      console.log(`[extractKB] Unknown ext "${ext}" — attempting plain text decode`);
      try {
        content = new TextDecoder('utf-8').decode(arrayBuf);
      } catch (_) {
        content = '';
      }
    }

    if (content && content.trim().length > 0) {
      await svc.entities.KnowledgeBase.update(kbId, {
        content: content.substring(0, 50000),
        status: 'ready'
      });
      console.log(`[extractKB] KB ${kbId} content extracted: ${content.length} chars`);
      return c.json({ data: { success: true, chars: content.length } });
    } else {
      console.error(`[extractKB] No content extracted for KB ${kbId}`);
      await svc.entities.KnowledgeBase.update(kbId, { status: 'failed' });
      return c.json({ data: { success: false, error: 'No content extracted' } });
    }

  } catch (error) {
    console.error('[extractKB] Error:', error.message || error);
    try {
      /* const base44 = ... */;
      const payload = await c.req.json().catch(() => ({}));
      const kbId = payload.kb_id || payload.event?.entity_id;
      if (kbId) {
        await base44.asServiceRole.entities.KnowledgeBase.update(kbId, { status: 'failed' });
      }
    } catch (_) {}
    return c.json({ data: { error: error.message } }, 500);
  }

};