import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// blogPrerender — Server-rendered HTML for blog posts so search engines & AI
// crawlers (GPTBot, PerplexityBot, ClaudeBot, Google-Extended) can index full
// content without executing JavaScript. Critical for SEO + AI GEO citations.
//
// Usage: GET /functions/blogPrerender?slug=<post-slug>
//        GET /functions/blogPrerender                (returns blog index)
//
// Recommended setup: configure your domain edge (Cloudflare Worker / Nginx) to
// route requests where User-Agent matches known bots from /blog/:slug to this
// function. Returns a full HTML document with article body inline.



const SITE_URL = 'https://vaaniai.io';
const SITE_NAME = 'VaaniAI';
const DEFAULT_IMAGE = 'https://media.base44.com/images/public/698823c19043e168a5daaa86/00fe0d8ce_vaani-removebg-preview.png';

const escapeHtml = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Allow only safe inline HTML tags from blog content (Quill output is already sanitized-ish).
// Strip <script>/<style>/<iframe>.
const sanitizeContent = (html = '') =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/ on[a-z]+="[^"]*"/gi, '');

function extractFaqs(html) {
  const faqs = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h[1-6][^>]*>|$)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const q = m[1].replace(/<[^>]*>/g, '').trim();
    if (!q.endsWith('?')) continue;
    const a = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (a.length > 20) faqs.push({ q, a: a.slice(0, 1000) });
  }
  return faqs;
}

function renderArticleHtml(post) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const image = post.cover_image || DEFAULT_IMAGE;
  const description = post.meta_description || post.excerpt || '';
  const publishedISO = post.published_date || post.created_date || new Date().toISOString();
  const modifiedISO = post.updated_date || publishedISO;
  const author = post.author_name || 'VaaniAI Team';
  const content = sanitizeContent(post.content || '');
  const wordCount = content.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean).length;

  const faqs = extractFaqs(content);
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description,
    image: [image],
    datePublished: publishedISO,
    dateModified: modifiedISO,
    author: { '@type': 'Person', name: author },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: { '@type': 'ImageObject', url: DEFAULT_IMAGE },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    articleSection: post.category,
    keywords: (post.tags || []).join(', '),
    wordCount,
    url,
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE_URL}/blog` },
      { '@type': 'ListItem', position: 3, name: post.title, item: url },
    ],
  };

  const faqSchema = faqs.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      }
    : null;

  const tagsHtml = (post.tags || [])
    .map((t) => `<a href="${SITE_URL}/blog?tag=${encodeURIComponent(t)}" rel="tag">#${escapeHtml(t)}</a>`)
    .join(' ');

  return `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(post.title)} | ${SITE_NAME} Blog</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="author" content="${escapeHtml(author)}">
<meta name="keywords" content="${escapeHtml((post.tags || []).join(', '))}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(post.title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="article:published_time" content="${publishedISO}">
<meta property="article:modified_time" content="${modifiedISO}">
<meta property="article:author" content="${escapeHtml(author)}">
<meta property="article:section" content="${escapeHtml(post.category || 'Blog')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(post.title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<script type="application/ld+json">${JSON.stringify(articleSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
${faqSchema ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>` : ''}
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:780px;margin:0 auto;padding:24px;line-height:1.7;color:#1f2937}
header nav a{color:#2563eb;text-decoration:none;font-size:14px}
h1{font-size:2.25rem;line-height:1.2;margin:1rem 0}
h2{font-size:1.6rem;margin:2rem 0 .8rem;border-bottom:1px solid #e5e7eb;padding-bottom:.4rem}
h3{font-size:1.2rem;margin:1.5rem 0 .6rem}
img{max-width:100%;height:auto;border-radius:12px}
.meta{color:#6b7280;font-size:14px;margin:.5rem 0 1.5rem}
.cover{margin:1.5rem 0}
.tags{margin-top:2rem;padding-top:1rem;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280}
.tags a{color:#2563eb;margin-right:.5rem;text-decoration:none}
a{color:#2563eb}
.cta{margin:2.5rem 0;padding:1.5rem;background:#0f172a;color:#fff;border-radius:14px;text-align:center}
.cta a{display:inline-block;background:#f59e0b;color:#0f172a;font-weight:700;padding:12px 24px;border-radius:10px;text-decoration:none;margin-top:.6rem}
</style>
</head>
<body>
<header>
  <nav><a href="${SITE_URL}">${SITE_NAME}</a> · <a href="${SITE_URL}/blog">Blog</a> · <a href="${SITE_URL}/blog?category=${encodeURIComponent(post.category || '')}">${escapeHtml(post.category || 'Article')}</a></nav>
  <h1>${escapeHtml(post.title)}</h1>
  <div class="meta">By ${escapeHtml(author)} · Published ${new Date(publishedISO).toDateString()} · ${post.read_time_minutes || Math.ceil(wordCount / 200)} min read</div>
  ${description ? `<p class="blog-excerpt"><strong>${escapeHtml(description)}</strong></p>` : ''}
  ${post.cover_image ? `<div class="cover"><img src="${escapeHtml(post.cover_image)}" alt="${escapeHtml(post.title)}"></div>` : ''}
</header>
<article id="blog-article-content">
${content}
</article>
<div class="cta">
  <div style="font-size:1.2rem;font-weight:700;margin-bottom:.5rem">Try <a href="${SITE_URL}" style="color:#fbbf24">VaaniAI</a> — India's #1 AI Voice Agent Platform</div>
  <div style="opacity:.85;font-size:.9rem">AI calling in Hindi & English · Lead qualification · CRM · ₹4999/month</div>
  <a href="${SITE_URL}#pricing">View Pricing →</a>
</div>
${tagsHtml ? `<div class="tags">Tags: ${tagsHtml}</div>` : ''}
<footer style="margin-top:3rem;padding-top:1rem;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280;text-align:center">
  © ${new Date().getFullYear()} ${SITE_NAME} · <a href="${SITE_URL}">Home</a> · <a href="${SITE_URL}/blog">Blog</a> · <a href="${SITE_URL}/PrivacyPolicy">Privacy</a>
</footer>
</body>
</html>`;
}

function renderIndexHtml(posts) {
  const items = posts
    .map(
      (p) => `<article style="margin:1.5rem 0;padding:1.2rem;border:1px solid #e5e7eb;border-radius:12px">
  <h2 style="margin:0 0 .5rem;font-size:1.3rem"><a href="${SITE_URL}/blog/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></h2>
  <div style="color:#6b7280;font-size:13px;margin-bottom:.5rem">${escapeHtml(p.category || '')} · ${new Date(p.published_date || p.created_date).toDateString()}</div>
  <p style="margin:0;color:#374151">${escapeHtml(p.excerpt || p.meta_description || '')}</p>
</article>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<title>${SITE_NAME} Blog — AI Voice Agents, Sales Automation & CRM Insights</title>
<meta name="description" content="Insights, guides and case studies on AI voice agents, sales calling automation, lead qualification and CRM for Indian businesses.">
<link rel="canonical" href="${SITE_URL}/blog">
<meta name="robots" content="index, follow">
<style>body{font-family:-apple-system,sans-serif;max-width:780px;margin:0 auto;padding:24px;line-height:1.6;color:#1f2937}a{color:#2563eb;text-decoration:none}h1{font-size:2rem}</style>
</head>
<body>
<nav><a href="${SITE_URL}">← ${SITE_NAME}</a></nav>
<h1>${SITE_NAME} Blog</h1>
<p style="color:#6b7280">Insights on AI voice agents, sales automation, and growth for Indian businesses.</p>
${items}
</body>
</html>`;
}

export default async function blogPrerender(c: any) {
  const req = c.req.raw || c.req;
  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get('slug');
    /* const base44 = ... */;

    if (!slug) {
      const posts = await base44.asServiceRole.entities.BlogPost.filter(
        { status: 'published' },
        '-published_date',
        50
      );
      return new Response(renderIndexHtml(posts || []), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const posts = await base44.asServiceRole.entities.BlogPost.filter({ slug, status: 'published' });
    const post = posts?.[0];
    if (!post) {
      return new Response(`<!doctype html><html><head><title>Not found</title></head><body><h1>404 — article not found</h1><p><a href="${SITE_URL}/blog">Back to blog</a></p></body></html>`, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response(renderArticleHtml(post), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(`<!doctype html><html><body><h1>Error</h1><pre>${escapeHtml(error.message)}</pre></body></html>`, {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

};