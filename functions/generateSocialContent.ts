import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

// Azure OpenAI helper
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
      max_completion_tokens: 1200,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

Deno.serve(async (req) => {
  try {
    let svc;
    let clientId;
    let clientData;
    let isCron = false;

    // Support external cron: GET with api_key
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronApiKey = url.searchParams.get('api_key');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      if (!expectedCronKey || cronApiKey !== expectedCronKey) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      isCron = true;
      svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    } else {
      // Manual trigger from frontend
      const base44 = createClientFromRequest(req);
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

      const body = await req.json();
      clientId = body.client_id;
      svc = base44.asServiceRole || base44;

      if (!clientId) {
        // Find client for this user
        const clients = await svc.entities.Client.filter({ user_id: user.id });
        if (clients.length === 0) return Response.json({ error: 'No client found' }, { status: 404 });
        clientId = clients[0].id;
        clientData = clients[0];
      }
    }

    const results = { posts_created: 0, errors: [] };

    // If cron: generate for all active clients
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

    for (const client of clientsToProcess) {
      try {
        // Load brand settings for this client
        let brand = {};
        try {
          const brandSettings = await svc.entities.BrandSettings.filter({ client_id: client.id });
          if (brandSettings.length > 0) brand = brandSettings[0];
        } catch (_) {}

        // Determine post count based on frequency
        const freq = brand.posting_frequency || 'daily';
        const maxPosts = freq === 'twice_daily' ? 4 : freq === 'thrice_weekly' ? 2 : freq === 'weekly' ? 2 : 2;

        // Check if content already generated for today
        const existingPosts = await svc.entities.SocialMediaPost.filter({
          client_id: client.id, scheduled_date: today
        });
        if (existingPosts.length >= maxPosts) {
          results.errors.push({ client_id: client.id, reason: 'Already has posts for today' });
          continue;
        }

        // Get current IST date info for contextual content
        const istNow = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
        const dayOfWeek = istNow.toLocaleDateString('en-IN', { weekday: 'long' });
        const monthName = istNow.toLocaleDateString('en-IN', { month: 'long' });

        const contentTypes = brand.content_themes?.length > 0
          ? brand.content_themes
          : ['promotional', 'educational', 'tips', 'engagement', 'behind_the_scenes'];
        const randomType = contentTypes[Math.floor(Math.random() * contentTypes.length)];

        // Build brand context for the prompt
        const brandContext = [];
        if (brand.brand_voice) brandContext.push(`Brand Voice: ${brand.brand_voice}`);
        if (brand.tone) brandContext.push(`Tone: ${brand.tone}`);
        if (brand.target_audience) brandContext.push(`Target Audience: ${brand.target_audience}`);
        if (brand.tagline) brandContext.push(`Brand Tagline: "${brand.tagline}"`);
        if (brand.language_preference) brandContext.push(`Language: ${brand.language_preference === 'hinglish' ? 'Mix of Hindi and English (Hinglish)' : brand.language_preference === 'bilingual' ? 'Bilingual English + Hindi' : brand.language_preference}`);
        if (brand.cta_style) brandContext.push(`Preferred CTA: ${brand.cta_style}`);
        if (brand.avoid_topics) brandContext.push(`AVOID these topics: ${brand.avoid_topics}`);
        if (brand.competitor_brands) brandContext.push(`Differentiate from competitors: ${brand.competitor_brands}`);
        if (brand.brand_colors) brandContext.push(`Brand Colors: ${brand.brand_colors} — use in poster design`);

        const postsToGenerate = Math.min(maxPosts - existingPosts.length, 2);

        const prompt = `Generate ${postsToGenerate} social media posts for a business with these details:
- Company: ${client.company_name}
- Industry: ${client.industry || 'General Business'}
- Today: ${dayOfWeek}, ${today} (${monthName})
${brandContext.length > 0 ? '\nBRAND GUIDELINES:\n' + brandContext.join('\n') : ''}

Create ${postsToGenerate} DIFFERENT posts:
1. A ${randomType} post
2. ${postsToGenerate > 1 ? 'A different type from: ' + contentTypes.join(', ') : ''}

Each post should have:
- A catchy title (under 10 words)
- A compelling caption (80-150 words${brand.tone ? ', ' + brand.tone + ' tone' : ', professional Indian business English'})
- 5-8 relevant hashtags
- A detailed image prompt for generating a poster (describe colors, layout, text overlays, style${brand.brand_colors ? ' — use brand colors: ' + brand.brand_colors : ''})
- The content_type

${brand.tagline ? 'Naturally weave in the tagline "' + brand.tagline + '" where appropriate.' : ''}
Make content relevant to the ${client.industry || 'business'} industry. Be creative, trendy, and engaging.`;

        const generated = await azureLLM(prompt, 
          `You are an expert social media marketer for Indian businesses. ${brand.brand_voice ? 'Brand voice: ' + brand.brand_voice + '.' : ''} Create engaging${brand.tone ? ', ' + brand.tone : ''} content. Always respond in valid JSON.`,
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
          // Generate poster image
          let posterUrl = '';
          try {
            const imagePrompt = `Professional social media poster for ${client.company_name} (${client.industry || 'business'}). ${post.image_prompt}. ${brand.brand_colors ? 'Use brand colors: ' + brand.brand_colors + '.' : ''} ${brand.logo_url ? 'Include company branding.' : ''} Modern, clean design with vibrant colors. No text watermarks. Square format 1080x1080.`;
            const imgRes = await svc.integrations.Core.GenerateImage({ prompt: imagePrompt });
            posterUrl = imgRes?.url || '';
          } catch (imgErr) {
            console.error(`[generateSocialContent] Image generation failed: ${imgErr.message}`);
          }

          await svc.entities.SocialMediaPost.create({
            client_id: client.id,
            title: post.title || 'Social Media Post',
            caption: post.caption,
            hashtags: post.hashtags || '',
            poster_url: posterUrl,
            platform: 'all',
            content_type: post.content_type || randomType,
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

    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('[generateSocialContent] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});