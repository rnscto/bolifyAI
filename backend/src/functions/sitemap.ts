import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const SITE_URL = 'https://vaaniai.io';

const escapeXml = (str = '') =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export default async function sitemap(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;

    // Use service role — sitemap is public and must work without a user session
    const posts = await base44.asServiceRole.entities.BlogPost.filter(
      { status: 'published' },
      '-published_date',
      1000
    );

    const staticPages = [
      { loc: '/', priority: '1.0', changefreq: 'weekly' },
      { loc: '/blog', priority: '0.9', changefreq: 'daily' },
      { loc: '/BookDemo', priority: '0.9', changefreq: 'weekly' },

      // ─── Phase 4: City pages ───
      { loc: '/ai-calling-software-mumbai', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-voice-agent-delhi', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-calling-software-bangalore', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-voice-agent-pune', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-calling-software-hyderabad', priority: '0.9', changefreq: 'weekly' },

      // ─── Phase 4: Industry pages ───
      { loc: '/ai-voice-agent-for-real-estate', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-voice-agent-for-healthcare-clinics', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-voice-agent-for-education-institutes', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-voice-agent-for-insurance-agencies', priority: '0.9', changefreq: 'weekly' },
      { loc: '/ai-voice-agent-for-gym-fitness', priority: '0.9', changefreq: 'weekly' },

      // ─── Phase 4: Competitor comparisons ───
      { loc: '/vaaniai-vs-exotel', priority: '0.8', changefreq: 'monthly' },
      { loc: '/vaaniai-vs-knowlarity', priority: '0.8', changefreq: 'monthly' },
      { loc: '/vaaniai-vs-myoperator', priority: '0.8', changefreq: 'monthly' },
      { loc: '/vaaniai-vs-twilio', priority: '0.8', changefreq: 'monthly' },

      // ─── Phase 4: Viral tools ───
      { loc: '/ai-calling-roi-calculator', priority: '0.8', changefreq: 'monthly' },
      { loc: '/telecalling-cost-savings-calculator', priority: '0.8', changefreq: 'monthly' },
      { loc: '/ai-voice-agent-pricing-estimator', priority: '0.8', changefreq: 'monthly' },

      // ─── Phase 4: Pillar guides ───
      { loc: '/ai-calling-software-india-buyers-guide-2026', priority: '0.9', changefreq: 'monthly' },
      { loc: '/hindi-ai-voice-agent-guide', priority: '0.9', changefreq: 'monthly' },
      { loc: '/dpdp-compliant-ai-calling-india', priority: '0.9', changefreq: 'monthly' },

      // ─── Legal ───
      { loc: '/PrivacyPolicy', priority: '0.3', changefreq: 'yearly' },
      { loc: '/TermsOfService', priority: '0.3', changefreq: 'yearly' },
      { loc: '/RefundPolicy', priority: '0.3', changefreq: 'yearly' },
      { loc: '/CompliancePolicy', priority: '0.3', changefreq: 'yearly' },
    ];

    const staticXml = staticPages
      .map(
        (p) => `  <url>
    <loc>${SITE_URL}${p.loc}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`
      )
      .join('\n');

    const blogXml = posts
      .map((p) => {
        const lastmod = (p.updated_date || p.published_date || p.created_date || new Date().toISOString()).split('T')[0];
        const imageXml = p.cover_image
          ? `
    <image:image>
      <image:loc>${escapeXml(p.cover_image)}</image:loc>
      <image:title>${escapeXml(p.title)}</image:title>
    </image:image>`
          : '';
        return `  <url>
    <loc>${SITE_URL}/blog/${escapeXml(p.slug)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>${imageXml}
  </url>`;
      })
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${staticXml}
${blogXml}
</urlset>`;

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><error>${escapeXml(error.message)}</error>`, {
      status: 500,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }

};