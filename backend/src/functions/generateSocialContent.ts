import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { BlobServiceClient } from 'npm:@azure/storage-blob@12.17.0';

// ─── Direct Azure Image generation (replaces Core.GenerateImage) ───
// Mirrors the pattern used in generateOgImage to keep the app credit-independent.
async function generatePosterDirect(prompt, clientId) {
  const endpoint = Deno.env.get('AZURE_IMAGE_ENDPOINT');
  const key = Deno.env.get('AZURE_IMAGE_KEY');
  const deployment = Deno.env.get('AZURE_IMAGE_DEPLOYMENT');
  const apiVersion = Deno.env.get('AZURE_IMAGE_API_VERSION');
  const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  const containerName = Deno.env.get('AZURE_STORAGE_CONTAINER_PUBLIC');
  if (!endpoint || !key || !deployment || !apiVersion || !conn || !containerName) {
    throw new Error('Azure Image/Blob secrets not configured');
  }

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/images/generations?api-version=${apiVersion}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify({ prompt, size: '1024x1024', n: 1, quality: 'high', output_format: 'png' })
  });
  if (!r.ok) throw new Error(`Azure image ${r.status}: ${(await r.text()).substring(0, 200)}`);
  const data = await r.json();
  const item = data?.data?.[0];
  if (!item) throw new Error('No image returned from Azure');

  let bytes;
  if (item.b64_json) {
    const bin = atob(item.b64_json);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else if (item.url) {
    bytes = new Uint8Array(await (await fetch(item.url)).arrayBuffer());
  } else {
    throw new Error('Image response missing b64_json and url');
  }

  const blobService = BlobServiceClient.fromConnectionString(conn);
  const container = blobService.getContainerClient(containerName);
  const blobName = `social-posters/${clientId}/${Date.now()}.png`;
  const blob = container.getBlockBlobClient(blobName);
  await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: 'image/png' } });
  return blob.url;
}

// Marketing calendar occasions (subset for matching)
const OCCASIONS = [
  { id: 'new_year', name: 'New Year', date: '01-01' },
  { id: 'lohri', name: 'Lohri', date: '01-13' },
  { id: 'makar_sankranti', name: 'Makar Sankranti / Pongal', date: '01-14' },
  { id: 'republic_day', name: 'Republic Day', date: '01-26' },
  { id: 'world_cancer_day', name: 'World Cancer Day', date: '02-04' },
  { id: 'valentines_day', name: "Valentine's Day", date: '02-14' },
  { id: 'basant_panchami', name: 'Basant Panchami', date: '02-02' },
  { id: 'womens_day', name: "International Women's Day", date: '03-08' },
  { id: 'holi', name: 'Holi', date: '03-14' },
  { id: 'world_water_day', name: 'World Water Day', date: '03-22' },
  { id: 'fools_day', name: "April Fool's Day", date: '04-01' },
  { id: 'ram_navami', name: 'Ram Navami', date: '04-06' },
  { id: 'ambedkar_jayanti', name: 'Ambedkar Jayanti', date: '04-14' },
  { id: 'baisakhi', name: 'Baisakhi', date: '04-13' },
  { id: 'earth_day', name: 'Earth Day', date: '04-22' },
  { id: 'eid_ul_fitr', name: 'Eid ul-Fitr', date: '04-01' },
  { id: 'labour_day', name: 'International Labour Day', date: '05-01' },
  { id: 'mothers_day', name: "Mother's Day", date: '05-11' },
  { id: 'buddha_purnima', name: 'Buddha Purnima', date: '05-12' },
  { id: 'world_env_day', name: 'World Environment Day', date: '06-05' },
  { id: 'fathers_day', name: "Father's Day", date: '06-15' },
  { id: 'yoga_day', name: 'International Yoga Day', date: '06-21' },
  { id: 'eid_ul_adha', name: 'Eid ul-Adha', date: '06-07' },
  { id: 'doctors_day', name: "Doctor's Day", date: '07-01' },
  { id: 'guru_purnima', name: 'Guru Purnima', date: '07-10' },
  { id: 'friendship_day', name: 'Friendship Day', date: '08-03' },
  { id: 'independence_day', name: 'Independence Day', date: '08-15' },
  { id: 'rakshabandhan', name: 'Raksha Bandhan', date: '08-09' },
  { id: 'janmashtami', name: 'Janmashtami', date: '08-16' },
  { id: 'teachers_day', name: "Teacher's Day", date: '09-05' },
  { id: 'onam', name: 'Onam', date: '09-05' },
  { id: 'ganesh_chaturthi', name: 'Ganesh Chaturthi', date: '09-07' },
  { id: 'gandhi_jayanti', name: 'Gandhi Jayanti', date: '10-02' },
  { id: 'navratri', name: 'Navratri', date: '10-02' },
  { id: 'dussehra', name: 'Dussehra', date: '10-12' },
  { id: 'karva_chauth', name: 'Karva Chauth', date: '10-17' },
  { id: 'world_mental_health', name: 'World Mental Health Day', date: '10-10' },
  { id: 'halloween', name: 'Halloween', date: '10-31' },
  { id: 'diwali', name: 'Diwali', date: '11-01' },
  { id: 'bhai_dooj', name: 'Bhai Dooj', date: '11-03' },
  { id: 'childrens_day', name: "Children's Day", date: '11-14' },
  { id: 'guru_nanak_jayanti', name: 'Guru Nanak Jayanti', date: '11-15' },
  { id: 'thanksgiving', name: 'Thanksgiving', date: '11-27' },
  { id: 'black_friday', name: 'Black Friday', date: '11-28' },
  { id: 'cyber_monday', name: 'Cyber Monday', date: '11-30' },
  { id: 'christmas', name: 'Christmas', date: '12-25' },
  { id: 'new_year_eve', name: "New Year's Eve", date: '12-31' },
];

async function azureLLM(prompt, systemPrompt, jsonSchema) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || 'You are a social media marketing expert. Always respond in valid JSON.' },
        { role: 'user', content: prompt + (jsonSchema ? '\n\nRespond in JSON matching this schema: ' + JSON.stringify(jsonSchema) : '') }
      ],
      max_completion_tokens: 2000,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

export default async function generateSocialContent(c: any) {
  const req = c.req.raw || c.req;
  try {
    let svc;
    let clientId;
    let clientData;
    let isCron = false;

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronApiKey = url.searchParams.get('api_key');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      if (!expectedCronKey || cronApiKey !== expectedCronKey) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
      isCron = true;
      svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    } else {
      /* const base44 = ... */;
      const user = c.get('jwtPayload');
      if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

      const body = await c.req.json();
      clientId = body.client_id;
      svc = base44.asServiceRole || base44;

      if (!clientId) {
        const clients = await svc.entities.Client.filter({ user_id: user.id });
        if (clients.length === 0) return c.json({ data: { error: 'No client found' } }, 404);
        clientId = clients[0].id;
        clientData = clients[0];
      }
    }

    const results = { posts_created: 0, errors: [] };

    const clientsToProcess = [];
    if (isCron) {
      const activeClients = await svc.entities.Client.filter({ account_status: 'active' });
      const trialClients = await svc.entities.Client.filter({ account_status: 'trial' });
      clientsToProcess.push(...activeClients, ...trialClients);
    } else {
      if (!clientData) clientData = await svc.entities.Client.get(clientId);
      clientsToProcess.push(clientData);
    }

    const today = new Date().toISOString().split('T')[0];
    const todayMMDD = today.substring(5); // "03-18"

    for (const client of clientsToProcess) {
      try {
        // Load brand settings
        let brand = {};
        try {
          const brandSettings = await svc.entities.BrandSettings.filter({ client_id: client.id });
          if (brandSettings.length > 0) brand = brandSettings[0];
        } catch (_) {}

        // Check for today's occasion (built-in + custom)
        const enabledOccasions = brand.enabled_occasions || [];
        const customOccasions = (brand.custom_occasions || []);
        const allOccasionsList = [...OCCASIONS, ...customOccasions];
        const todayOccasions = allOccasionsList.filter(o => o.date === todayMMDD && enabledOccasions.includes(o.id));

        const MAX_DAILY_POSTS = 2;

        const existingPosts = await svc.entities.SocialMediaPost.filter({
          client_id: client.id, scheduled_date: today
        });
        if (existingPosts.length >= MAX_DAILY_POSTS) {
          results.errors.push({ client_id: client.id, reason: 'Daily limit of 2 posts reached' });
          continue;
        }

        const istNow = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
        const dayOfWeek = istNow.toLocaleDateString('en-IN', { weekday: 'long' });
        const monthName = istNow.toLocaleDateString('en-IN', { month: 'long' });

        const contentTypes = brand.content_themes?.length > 0
          ? brand.content_themes
          : ['promotional', 'educational', 'tips', 'engagement', 'behind_the_scenes'];
        const randomType = contentTypes[Math.floor(Math.random() * contentTypes.length)];

        // Build comprehensive brand context
        const ctx = [];
        if (brand.about_brand) ctx.push(`About Brand: ${brand.about_brand}`);
        if (brand.brand_voice) ctx.push(`Brand Voice: ${brand.brand_voice}`);
        if (brand.tone) ctx.push(`Tone: ${brand.tone}`);
        if (brand.tagline) ctx.push(`Tagline: "${brand.tagline}"`);
        if (brand.target_audience) ctx.push(`Target Audience: ${brand.target_audience}`);
        if (brand.language_preference) {
          const langMap = { hinglish: 'Hinglish (Hindi+English mix)', bilingual: 'Bilingual EN+HI', hindi: 'Hindi', english: 'English' };
          ctx.push(`Language: ${langMap[brand.language_preference] || brand.language_preference}`);
        }

        // Products & Services
        if (brand.products?.length > 0) {
          ctx.push(`Products: ${brand.products.map(p => `${p.name}${p.price ? ' ('+p.price+')' : ''}${p.description ? ' - '+p.description : ''}`).join('; ')}`);
        }
        if (brand.services?.length > 0) {
          ctx.push(`Services: ${brand.services.map(s => `${s.name}${s.price ? ' ('+s.price+')' : ''}${s.description ? ' - '+s.description : ''}`).join('; ')}`);
        }
        if (brand.usps?.length > 0) ctx.push(`USPs: ${brand.usps.join(', ')}`);
        if (brand.features?.length > 0) ctx.push(`Key Features: ${brand.features.join(', ')}`);
        if (brand.pricing_info) ctx.push(`Pricing: ${brand.pricing_info}`);

        // Active offers
        if (brand.current_offers?.length > 0) {
          const activeOffers = brand.current_offers.filter(o => !o.valid_until || o.valid_until >= today);
          if (activeOffers.length > 0) {
            ctx.push(`ACTIVE OFFERS (promote these!): ${activeOffers.map(o => `${o.title}${o.code ? ' (Code: '+o.code+')' : ''}${o.description ? ' - '+o.description : ''}`).join('; ')}`);
          }
        }

        // Contact & Social
        if (brand.cta_style) ctx.push(`Preferred CTA: ${brand.cta_style}`);
        const contactParts = [];
        if (brand.contact_phone) contactParts.push(`Phone: ${brand.contact_phone}`);
        if (brand.contact_whatsapp) contactParts.push(`WhatsApp: ${brand.contact_whatsapp}`);
        if (brand.contact_email) contactParts.push(`Email: ${brand.contact_email}`);
        if (brand.website_url) contactParts.push(`Website: ${brand.website_url}`);
        if (contactParts.length > 0) ctx.push(`Contact Info (use in CTAs): ${contactParts.join(', ')}`);

        const socialParts = [];
        if (brand.social_instagram) socialParts.push(`IG: ${brand.social_instagram}`);
        if (brand.social_facebook) socialParts.push(`FB: ${brand.social_facebook}`);
        if (brand.social_linkedin) socialParts.push(`LinkedIn: ${brand.social_linkedin}`);
        if (brand.social_twitter) socialParts.push(`Twitter: ${brand.social_twitter}`);
        if (brand.social_youtube) socialParts.push(`YouTube: ${brand.social_youtube}`);
        if (socialParts.length > 0) ctx.push(`Social Handles (include in posts): ${socialParts.join(', ')}`);

        if (brand.addresses?.length > 0) {
          ctx.push(`Locations: ${brand.addresses.map(a => `${a.label || ''} ${a.address || ''} ${a.city || ''}`).join('; ')}`);
        }
        if (brand.google_maps_link) ctx.push(`Google Maps: ${brand.google_maps_link}`);

        if (brand.avoid_topics) ctx.push(`AVOID these topics: ${brand.avoid_topics}`);
        if (brand.competitor_brands) ctx.push(`Differentiate from competitors: ${brand.competitor_brands}`);
        if (brand.brand_colors) ctx.push(`Brand Colors: ${brand.brand_colors}`);

        const postsToGenerate = MAX_DAILY_POSTS - existingPosts.length;

        // Build occasion context
        let occasionInstruction = '';
        if (todayOccasions.length > 0) {
          occasionInstruction = `\n\n🎯 TODAY'S SPECIAL OCCASION(S): ${todayOccasions.map(o => o.name).join(', ')}
Make at least 1 post themed around this occasion — tie it creatively to the brand's products/services. Use festive/relevant hashtags.`;
        }

        const prompt = `Generate ${postsToGenerate} social media posts for:
- Company: ${client.company_name}
- Industry: ${client.industry || 'General Business'}
- Today: ${dayOfWeek}, ${today} (${monthName})
${ctx.length > 0 ? '\nCOMPLETE BRAND PROFILE:\n' + ctx.join('\n') : ''}
${occasionInstruction}

Create ${postsToGenerate} DIFFERENT posts:
1. ${todayOccasions.length > 0 ? 'A festive post for ' + todayOccasions[0].name + ' tied to the brand' : 'A ' + randomType + ' post'}
${postsToGenerate > 1 ? '2. A different type: ' + contentTypes.slice(0, 4).join(', ') : ''}

Each post MUST have:
- title: catchy (under 10 words)
- caption: compelling (80-150 words${brand.tone ? ', ' + brand.tone + ' tone' : ''})
  * Include relevant contact info / social handles as CTA where natural
  * Mention products/services/offers when relevant
  * Include location info if applicable
- hashtags: 5-8 relevant hashtags (include brand & occasion-specific ones)
- image_prompt: detailed poster description (colors, layout, elements${brand.brand_colors ? ', use brand colors: ' + brand.brand_colors : ''})
- content_type: the type of content

${brand.tagline ? 'Weave in tagline "' + brand.tagline + '" naturally.' : ''}
Be creative, trendy, and make the brand stand out!`;

        const generated = await azureLLM(prompt,
          `You are an expert social media marketer for Indian businesses. ${brand.about_brand ? 'Brand context: ' + brand.about_brand.substring(0, 200) + '.' : ''} ${brand.brand_voice ? 'Voice: ' + brand.brand_voice + '.' : ''} Create engaging${brand.tone ? ', ' + brand.tone : ''} content. Always respond in valid JSON.`,
          {
            type: "object",
            properties: {
              posts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    caption: { type: "string" },
                    hashtags: { type: "string" },
                    image_prompt: { type: "string" },
                    content_type: { type: "string" }
                  }
                }
              }
            }
          }
        );

        const posts = generated.posts || [];

        for (const post of posts) {
          let posterUrl = '';
          try {
            const imagePrompt = `Professional social media poster for ${client.company_name} (${client.industry || 'business'}). ${post.image_prompt}. ${brand.brand_colors ? 'Use brand colors: ' + brand.brand_colors + '.' : ''} ${brand.logo_url ? 'Include company branding.' : ''} Modern, clean design. No text watermarks. Square format 1080x1080.`;
            posterUrl = await generatePosterDirect(imagePrompt, client.id);
          } catch (imgErr) {
            console.error(`[generateSocialContent] Image generation failed: ${imgErr.message}`);
          }

          const isOccasionPost = todayOccasions.length > 0 && post.content_type === 'festival';
          await svc.entities.SocialMediaPost.create({
            client_id: client.id,
            title: post.title || 'Social Media Post',
            caption: post.caption,
            hashtags: post.hashtags || '',
            poster_url: posterUrl,
            platform: 'all',
            content_type: isOccasionPost ? 'festival' : (post.content_type || randomType),
            status: 'pending_approval',
            scheduled_date: today,
            shared_on: [],
            ai_prompt_used: prompt.substring(0, 500)
          });
          results.posts_created++;
        }

      } catch (clientErr) {
        console.error(`[generateSocialContent] Error for ${client.company_name}: ${clientErr.message}`);
        results.errors.push({ client_id: client.id, error: clientErr.message });
      }
    }

    return c.json({ data: { success: true, ...results } });
  } catch (error) {
    console.error('[generateSocialContent] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};