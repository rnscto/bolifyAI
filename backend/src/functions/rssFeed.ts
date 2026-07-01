import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const SITE_URL = 'https://vaaniai.io';
const FEED_TITLE = 'VaaniAI Blog — AI Voice Agents, Calling Automation & SMB Growth';
const FEED_DESCRIPTION =
  'Latest articles from VaaniAI on AI voice agents, conversational AI, calling automation, DPDP compliance, and growth tips for Indian SMBs.';
const FEED_LANGUAGE = 'en-IN';
const FEED_AUTHOR_EMAIL = 'sales@vaaniai.io';
const FEED_AUTHOR_NAME = 'VaaniAI Team';

const escapeXml = (str = '') =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// Strip HTML tags from content for plain-text fallback (description field)
const stripHtml = (html = '') =>
  String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toRfc822 = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(d.getTime())) return new Date().toUTCString();
  return d.toUTCString();
};

export default async function rssFeed(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;

    // Service role — feed is public and must work without a user session
    const posts = await base44.asServiceRole.entities.BlogPost.filter(
      { status: 'published' },
      '-published_date',
      50 // RSS readers typically show recent items; 50 is plenty
    );

    const lastBuildDate = toRfc822(
      posts.length > 0
        ? posts[0].updated_date || posts[0].published_date || posts[0].created_date
        : new Date()
    );

    const itemsXml = posts
      .map((p) => {
        const link = `${SITE_URL}/blog/${p.slug}`;
        const pubDate = toRfc822(p.published_date || p.created_date);
        const description = stripHtml(p.excerpt || p.meta_description || p.content || '').slice(0, 500);
        const contentEncoded = p.content || p.excerpt || '';
        const categoriesXml = Array.isArray(p.tags)
          ? p.tags.map((t) => `      <category>${escapeXml(t)}</category>`).join('\n')
          : '';
        const enclosureXml = p.cover_image
          ? `      <enclosure url="${escapeXml(p.cover_image)}" type="image/jpeg" length="0" />
      <media:content url="${escapeXml(p.cover_image)}" medium="image" />`
          : '';
        const authorXml = p.author_name
          ? `      <dc:creator><![CDATA[${p.author_name}]]></dc:creator>`
          : `      <dc:creator><![CDATA[${FEED_AUTHOR_NAME}]]></dc:creator>`;

        return `    <item>
      <title>${escapeXml(p.title || 'Untitled')}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${pubDate}</pubDate>
${authorXml}
      <description><![CDATA[${description}]]></description>
      <content:encoded><![CDATA[${contentEncoded}]]></content:encoded>
${categoriesXml}
${enclosureXml}
    </item>`;
      })
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${SITE_URL}/blog</link>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml" />
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>${FEED_LANGUAGE}</language>
    <copyright>Copyright © ${new Date().getFullYear()} VaaniAI. All rights reserved.</copyright>
    <managingEditor>${FEED_AUTHOR_EMAIL} (${FEED_AUTHOR_NAME})</managingEditor>
    <webMaster>${FEED_AUTHOR_EMAIL} (${FEED_AUTHOR_NAME})</webMaster>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <pubDate>${lastBuildDate}</pubDate>
    <ttl>60</ttl>
    <image>
      <url>https://media.base44.com/images/public/698823c19043e168a5daaa86/00fe0d8ce_vaani-removebg-preview.png</url>
      <title>${escapeXml(FEED_TITLE)}</title>
      <link>${SITE_URL}/blog</link>
    </image>
${itemsXml}
  </channel>
</rss>`;

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('rssFeed error:', error);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><error>${escapeXml(error.message)}</error>`,
      {
        status: 500,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      }
    );
  }

};