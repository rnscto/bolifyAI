import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// generateOgImage — Generate a 1200x630 Open Graph image for SEO pages
// using Azure OpenAI gpt-image-2, upload to Azure Blob (public), and
// cache the URL in the SeoOgImage entity to avoid regeneration.
//
// Usage (admin-only, idempotent):
//   await base44.functions.invoke('generateOgImage', {
//     slug: 'ai-calling-software-mumbai',
//     title: 'AI Calling Software in Mumbai',
//     subtitle: 'Hindi + English voice agents for Mumbai businesses',
//     theme: 'city' // 'city' | 'industry' | 'comparison' | 'tool' | 'guide'
//   });
//
// Returns: { url, cached: boolean }
// ═══════════════════════════════════════════════════════════════════


import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from 'npm:@azure/storage-blob@12.17.0';

// Parse AccountName + AccountKey from a standard Azure connection string
function parseConnString(conn) {
  const parts = Object.fromEntries(conn.split(';').filter(Boolean).map((p) => {
    const idx = p.indexOf('=');
    return [p.slice(0, idx), p.slice(idx + 1)];
  }));
  return { accountName: parts.AccountName, accountKey: parts.AccountKey };
}

function buildPrompt({ title, subtitle, theme }) {
  const themeStyles = {
    city: 'modern Indian skyline silhouette in deep navy and gold, AI voice waveform overlay',
    industry: 'professional business scene with subtle AI voice waveform graphic in deep navy',
    comparison: 'side-by-side abstract shield/badge design in deep navy and emerald green',
    tool: 'sleek calculator/dashboard interface with deep navy and electric blue gradient',
    guide: 'editorial magazine cover style with deep navy background and gold accents',
  };
  const style = themeStyles[theme] || themeStyles.guide;

  return `Open Graph social share image, 1200x630 aspect ratio, professional B2B SaaS branding.
Background: ${style}.
Foreground: Bold headline text "${title}" in large white sans-serif typography, positioned upper-left.
Subheadline below in lighter weight: "${subtitle}".
Bottom-right corner: small "VaaniAI" wordmark in white.
Style: cinematic, high-contrast, no people, no stock photos, no clutter.
Aesthetic: enterprise tech, India-first, premium, suitable for Twitter/LinkedIn/Facebook share preview.
Color palette: deep navy (#0A1F44), gold (#D4AF37), white, with accent gradient.
IMPORTANT: text must be perfectly legible, no spelling errors, no watermarks.`;
}

export default async function generateOgImage(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const { slug, title, subtitle = '', theme = 'guide', force = false } = body;

    if (!slug || !title) {
      return c.json({ data: { error: 'slug and title are required' } }, 400);
    }

    // ── 1) Check cache ──────────────────────────────────────────────
    const existing = await base44.asServiceRole.entities.SeoOgImage.filter({ slug });
    if (!force && existing.length > 0 && existing[0].url) {
      return c.json({ data: { url: existing[0].url, cached: true } });
    }

    // ── 2) Call Azure OpenAI image generation ───────────────────────
    const endpoint = Deno.env.get('AZURE_IMAGE_ENDPOINT');
    const key = Deno.env.get('AZURE_IMAGE_KEY');
    const deployment = Deno.env.get('AZURE_IMAGE_DEPLOYMENT');
    const apiVersion = Deno.env.get('AZURE_IMAGE_API_VERSION');

    if (!endpoint || !key || !deployment || !apiVersion) {
      return c.json({ data: { error: 'Azure image generation not configured' } }, 500);
    }

    const prompt = buildPrompt({ title, subtitle, theme });
    const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/images/generations?api-version=${apiVersion}`;

    const azureRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': key,
      },
      body: JSON.stringify({
        prompt,
        size: '1536x1024', // closest to 1200x630 OG ratio that gpt-image-2 supports
        n: 1,
        quality: 'high',
        output_format: 'png',
      }),
    });

    if (!azureRes.ok) {
      const errText = await azureRes.text();
      console.error('[generateOgImage] Azure error:', azureRes.status, errText);
      return c.json({ data: { error: `Azure image API failed: ${azureRes.status}`, details: errText } }, 500);
    }

    const azureData = await azureRes.json();
    const imageItem = azureData?.data?.[0];
    if (!imageItem) {
      return c.json({ data: { error: 'No image returned from Azure' } }, 500);
    }

    // gpt-image-2 returns base64 by default
    let imageBytes;
    if (imageItem.b64_json) {
      const binary = atob(imageItem.b64_json);
      imageBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) imageBytes[i] = binary.charCodeAt(i);
    } else if (imageItem.url) {
      const imgRes = await fetch(imageItem.url);
      imageBytes = new Uint8Array(await imgRes.arrayBuffer());
    } else {
      return c.json({ data: { error: 'Image response missing b64_json and url' } }, 500);
    }

    // ── 3) Upload to Azure Blob (public container) ──────────────────
    const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    const containerName = Deno.env.get('AZURE_STORAGE_CONTAINER_PUBLIC');
    if (!conn || !containerName) {
      return c.json({ data: { error: 'Azure Blob storage not configured' } }, 500);
    }

    const blobService = BlobServiceClient.fromConnectionString(conn);
    const container = blobService.getContainerClient(containerName);
    const blobName = `og-images/${slug}-${Date.now()}.png`;
    const blockBlob = container.getBlockBlobClient(blobName);

    await blockBlob.uploadData(imageBytes, {
      blobHTTPHeaders: { blobContentType: 'image/png' },
    });

    // Build a long-lived SAS URL (10 years) so it works whether the
    // container has anonymous public access enabled or not.
    let publicUrl = blockBlob.url;
    try {
      const { accountName, accountKey } = parseConnString(conn);
      if (accountName && accountKey) {
        const cred = new StorageSharedKeyCredential(accountName, accountKey);
        const expiresOn = new Date();
        expiresOn.setFullYear(expiresOn.getFullYear() + 10);
        const sas = generateBlobSASQueryParameters({
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse('r'),
          startsOn: new Date(Date.now() - 60_000),
          expiresOn,
          protocol: 'https',
        }, cred).toString();
        publicUrl = `${blockBlob.url}?${sas}`;
      }
    } catch (e) {
      console.warn('[generateOgImage] SAS generation failed, falling back to raw blob URL:', e.message);
    }

    // ── 4) Save / update cache row ──────────────────────────────────
    if (existing.length > 0) {
      await base44.asServiceRole.entities.SeoOgImage.update(existing[0].id, {
        url: publicUrl,
        title,
        subtitle,
        theme,
        generated_at: new Date().toISOString(),
      });
    } else {
      await base44.asServiceRole.entities.SeoOgImage.create({
        slug,
        url: publicUrl,
        title,
        subtitle,
        theme,
        generated_at: new Date().toISOString(),
      });
    }

    return c.json({ data: { url: publicUrl, cached: false } });
  } catch (error) {
    console.error('[generateOgImage] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};