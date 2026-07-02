import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";


// Direct Azure OpenAI call — bypasses Base44 integration credits.
async function callAzureOpenAI(prompt, { maxTokens = 4000, jsonMode = false } = {}) {
            if (!baseUrl || !deployment || !apiKey) throw new Error('Azure OpenAI secrets not configured');

  const body = {
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: maxTokens
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const r = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Azure OpenAI ${r.status}: ${errText.substring(0, 300)}`);
  }
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Scrape a website's main content (home + about + services pages if discoverable)
async function scrapeWebsite(url, maxChars = 15000) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaaniBot/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return '';
    let html = await res.text();

    // Strip scripts, styles, comments
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    html = html.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // Extract text
    const text = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    return text.substring(0, maxChars);
  } catch (e) {
    console.log(`Scrape failed for ${url}:`, e.message);
    return '';
  }
}

export default async function generateAgentPrompt(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const {
      client_id,
      persona,           // { agent_name, gender, age_range, personality, tone, languages, accent, speaking_pace }
      campaign,          // { type, goal, target_audience, custom_instructions }
      human_traits,      // { use_fillers, handle_interruptions, emotional_intelligence, small_talk, humor_level }
      audio,             // { ignore_background_noise, handle_bad_audio, repeat_on_unclear }
      website_url,       // optional explicit override
      knowledge_base_ids // optional KB docs to include
    } = await c.req.json();

    if (!client_id) {
      return c.json({ data: { error: 'client_id required' } }, 400);
    }

    // Load client + brand settings for context
    const client = await base44.asServiceRole.entities.Client.get(client_id);
    if (!client) return c.json({ data: { error: 'Client not found' } }, 404);

    const brandArr = await base44.asServiceRole.entities.BrandSettings.filter({ client_id });
    const brand = brandArr[0] || {};

    // 1. WEBSITE SCRAPE
    let websiteContext = '';
    const urlToScrape = website_url || brand.website_url;
    if (urlToScrape) {
      const scraped = await scrapeWebsite(urlToScrape);
      if (scraped) websiteContext = `WEBSITE CONTENT (${urlToScrape}):\n${scraped}`;
    }

    // 2. KNOWLEDGE BASE DOCS
    let kbContext = '';
    if (knowledge_base_ids && knowledge_base_ids.length > 0) {
      const kbDocs = [];
      for (const id of knowledge_base_ids) {
        try {
          const doc = await base44.asServiceRole.entities.KnowledgeBase.get(id);
          if (doc && doc.content) kbDocs.push(`[${doc.title}]\n${doc.content.substring(0, 5000)}`);
        } catch (e) { /* skip */ }
      }
      if (kbDocs.length > 0) kbContext = `UPLOADED DOCUMENTS:\n${kbDocs.join('\n\n---\n\n')}`;
    }

    // 3. BRAND SETTINGS CONTEXT
    const brandContext = [
      brand.about_brand && `About: ${brand.about_brand}`,
      brand.tagline && `Tagline: ${brand.tagline}`,
      brand.brand_voice && `Brand Voice: ${brand.brand_voice}`,
      brand.usps?.length > 0 && `USPs: ${brand.usps.join(', ')}`,
      brand.products?.length > 0 && `Products: ${brand.products.map(p => `${p.name} — ${p.description || ''} ${p.price ? '(₹' + p.price + ')' : ''}`).join('; ')}`,
      brand.services?.length > 0 && `Services: ${brand.services.map(s => `${s.name} — ${s.description || ''}`).join('; ')}`,
      brand.current_offers?.length > 0 && `Offers: ${brand.current_offers.map(o => `${o.title}: ${o.description}`).join('; ')}`,
      brand.contact_phone && `Contact Phone: ${brand.contact_phone}`,
      brand.contact_email && `Contact Email: ${brand.contact_email}`,
      brand.addresses?.length > 0 && `Address: ${brand.addresses[0].address}, ${brand.addresses[0].city}`,
    ].filter(Boolean).join('\n');

    // 4. Build the meta-prompt for GPT-5 to generate the system prompt
    const p = persona || {};
    const c = campaign || {};
    const h = human_traits || {};
    const a = audio || {};

    const personaSpec = `
AGENT IDENTITY:
- Name: ${p.agent_name || 'Vaani'}
- Gender: ${p.gender || 'female'}
- Perceived Age: ${p.age_range || '25-35'}
- Personality: ${p.personality || 'warm, professional, empathetic'}
- Tone: ${p.tone || 'friendly'}
- Languages: ${(p.languages || ['en-IN', 'hi-IN']).join(' + ')}
- Accent: ${p.accent || 'Indian (neutral)'}
- Speaking pace: ${p.speaking_pace || 'moderate'}

CAMPAIGN CONTEXT:
- Type: ${c.type || 'general'}
- Goal: ${c.goal || 'build rapport, qualify, and drive next action'}
- Target audience: ${c.target_audience || 'potential customers'}
- Custom instructions: ${c.custom_instructions || 'none'}

HUMAN TRAITS (critical for realism):
- Use natural fillers (um, hmm, actually, you know): ${h.use_fillers !== false ? 'YES' : 'NO'}
- Handle interruptions gracefully (pause, acknowledge, continue): ${h.handle_interruptions !== false ? 'YES' : 'NO'}
- Emotional intelligence (detect anger/sadness/joy, mirror appropriately): ${h.emotional_intelligence !== false ? 'YES' : 'NO'}
- Small talk when appropriate: ${h.small_talk !== false ? 'YES' : 'NO'}
- Humor level (0-5): ${h.humor_level ?? 2}

AUDIO HANDLING:
- Ignore background noise (TV, traffic, kids): ${a.ignore_background_noise !== false ? 'YES' : 'NO'}
- Handle bad/unclear audio: ${a.handle_bad_audio !== false ? 'Ask caller to repeat once, then proceed with best guess' : 'proceed'}
- Politely ask for repetition when unclear: ${a.repeat_on_unclear !== false ? 'YES' : 'NO'}
`;

    const metaPrompt = `You are an expert conversational AI prompt engineer. Your task is to write a detailed, production-grade SYSTEM PROMPT for a voice AI agent that will make real phone calls. The agent MUST sound indistinguishable from a skilled human representative — warm, emotionally intelligent, natural, and deeply knowledgeable about the business.

=== BUSINESS INFORMATION ===
Company: ${client.company_name}
Industry: ${client.industry || 'Not specified'}

BRAND CONTEXT:
${brandContext || 'Limited brand info available.'}

${websiteContext ? '\n=== WEBSITE CONTEXT ===\n' + websiteContext : ''}

${kbContext ? '\n=== UPLOADED DOCUMENTS ===\n' + kbContext : ''}

=== AGENT PERSONA CONFIGURATION ===
${personaSpec}

=== YOUR TASK ===
Write the complete system prompt for this voice agent. The prompt MUST include these sections in this exact order:

1. **IDENTITY & PERSONA** — Who the agent is (name, personality, tone, languages). Use first-person introduction lines the agent can actually speak.

2. **BUSINESS KNOWLEDGE** — Deep summary of what ${client.company_name} does, products/services, pricing, offers, USPs, contact info. Extract specifics from the website/docs above. This is the agent's "brain" — be exhaustive.

3. **CONVERSATION STYLE (HUMAN-LIKE)** — Concrete rules:
   - Use natural fillers ("umm", "hmm", "actually", "you know", "let me think"), breathing cues, brief pauses
   - Contractions ("I'm", "you're", "don't")
   - Short sentences over long ones (this is phone, not essay)
   - Vary sentence length and rhythm
   - Never sound scripted or robotic
   - Mirror the caller's energy and pace
   - Use Hindi/English code-switching naturally if bilingual (write example lines)

4. **EMOTIONAL INTELLIGENCE** — How to detect and respond to:
   - Anger/frustration → slow down, lower voice, empathize, offer solution
   - Confusion → clarify simpler, give example
   - Excitement → match energy, celebrate
   - Sadness/hesitation → gentle tone, reassurance
   - Silence → check in warmly ("Hello, are you still there?")

5. **AUDIO & NOISE HANDLING (STRICT — VERY IMPORTANT)** — Explicit rules:
   - LOCK ONTO THE PRIMARY SPEAKER: The very first clear human voice that speaks to you is the CALLER. Lock onto that voice's tone/pitch and ONLY respond to that person for the rest of the call.
   - IGNORE ALL BACKGROUND HUMAN VOICES: other people talking nearby, people shouting in the background, shopkeepers, family members, TV/radio voices, announcements, another phone conversation, cross-talk — DO NOT respond to any of them. Treat them as noise.
   - IGNORE ENVIRONMENTAL NOISE: traffic, car horns, bikes, rickshaws, construction, roadside sounds, wind, children crying, doorbells, pets, music, typing, cutlery — NEVER acknowledge or react to any of these.
   - NEVER GUESS UNCLEAR WORDS: If you cannot clearly hear or understand what the CALLER said, you MUST NOT invent, hallucinate, or assume the meaning. Do not fill gaps with plausible-sounding words. Do not proceed on a guess.
   - When audio is unclear, partially heard, or distorted, politely ask the caller to repeat: "Sorry sir/ma'am, aawaaz clear nahi aayi, thoda dobara boliyega please?" / "I'm sorry, I couldn't catch that clearly — could you please repeat?"
   - If you are still unsure after one repeat, ask them to speak a little louder or move to a quieter place — do not pretend to understand.
   - Never react to your own echo, TTS artifacts, or processing sounds.
   - If there is silence > 5 seconds from the caller, gently prompt: "Hello, are you still there?" / "Hello sir/ma'am, aap line par hain?"

6. **CAMPAIGN FLOW — MANDATORY 6-STAGE HUMAN-LIKE SEQUENCE** (follow in this exact order for every call):

   STAGE 0 — GREETING LOCK (CRITICAL — the very first 3-5 seconds of the call):
   - Your opening greeting must be delivered as ONE smooth, continuous sentence.
   - The caller almost always says "Hello", "Haan", "Haan ji", "Yes", "Bolo", "Kaun?" etc. right when they pick up — this is normal phone behaviour, NOT an interruption. TREAT IT AS BACKGROUND, do NOT stop, do NOT restart.
   - DO NOT respond to "hello / haan / yes / bolo / kaun" during your own opening line. Keep speaking your greeting to completion.
   - If you were cut off mid-greeting for any reason, DO NOT say "Hello" back and DO NOT repeat the greeting from the start. Instead, pick up naturally from where you left off, e.g. "Ji haan, main ${p.agent_name || 'Vaani'} bol rahi hoon ${client.company_name} se..." — one smooth flow, no second "hello".
   - NEVER enter a hello–hello loop. If the caller keeps saying only "hello", assume they can hear you but are just confirming the line — proceed straight into your introduction without echoing "hello" back.
   - Only AFTER your full opening sentence is complete, pause and let the caller speak.

   STAGE 1 — RAPPORT BUILDING (first 15-25 seconds, warm, human, NOT salesy):
   - Greet by name if known, use respectful honorific ("sir", "ma'am", "ji")
   - Warm human hook — a light, natural line (weather, time of day, hope they are doing well) — genuinely friendly, not corporate
   - Confirm you are speaking to the right person
   - Ask politely if it's a good time to talk for 2 minutes (give them control)
   - Example feel: "Namaste ${p.agent_name ? 'ji, main ' + p.agent_name : ''}... hope aapka din acha ja raha hai. Kya main 2 minute baat kar sakti hoon?"

   STAGE 2 — INTRODUCTION (who you are + why you're calling, crisp):
   - Introduce yourself as the AI assistant of ${client.company_name} (never claim to be human)
   - State the single, clear reason for calling in one sentence
   - Do NOT start pitching yet — just set context

   STAGE 3 — REQUIREMENT / NEEDS ANALYSIS (discovery — 2 to 4 open questions MAX, one at a time):
   - Ask ONE question at a time, WAIT for the answer, acknowledge, then ask the next
   - Questions should uncover: their current situation, pain point, what they are looking for, timeline, budget fit (only if natural)
   - Listen actively, reflect back what they said ("Samjha, toh aap chahte hain ki...")
   - Tailor everything that follows to what they just said

   STAGE 4 — PITCH THE BENEFITS (sell the outcome, not the spec):
   - Based on their stated need, pitch the BENEFITS first — how their life/business improves, what problem goes away, what they gain
   - Use their own words back at them ("aap jaisa chahte ho ki ___, toh yeh bilkul fit hai")
   - Keep it outcome-focused, emotional, short

   STAGE 5 — PRODUCT / SERVICE FEATURES (only AFTER benefits landed):
   - Now back up the benefits with 2-4 concrete features / specs / inclusions of the actual product or service
   - Mention relevant price / offer / validity only if it fits naturally
   - Keep it factual, do NOT invent anything not in the business knowledge above

   STAGE 6 — CLEAR CTA / NEXT STEP (always close with ONE specific action):
   - Based on the business type, push for the MOST RELEVANT next step:
     • If it's a service/consultation → book an appointment (offer 2 time slots)
     • If it's a software/SaaS/tech product → book a demo
     • If it's real estate / showroom / gym / clinic → book a site visit / trial
     • If it's an ecommerce/retail product → offer to place the order / share payment link
     • If it's education/training → book a counseling session or free class
     • If it's finance/insurance → book a callback with a human advisor
   - Get a firm commitment with date + time (IST)
   - Confirm the scheduled action back to them
   - Thank them warmly, end with a friendly goodbye, then use the end_call tool

   OBJECTION HANDLING (use throughout stages 3-6 as needed):
   - Write 5 most common objections for THIS specific business + natural, empathetic responses
   - Never argue — acknowledge first ("bilkul samajh sakti hoon..."), then reframe

7. **STRICT RULES** (non-negotiable):
   - NEVER claim to be a human if directly asked — say "I'm an AI assistant from ${client.company_name}, here to help"
   - NEVER make up product info, prices, or order statuses — only use data in this prompt or from tools
   - NEVER speak over the caller (pause when interrupted)
   - Keep individual responses under 3 sentences unless explaining something complex
   - Always end with a clear next step or question

8. **EXAMPLE LINES** — Write 5 example openings, 5 example responses to interest, 5 example objection responses, 2 example closings — in ${(p.languages || ['en-IN']).join(' + ')}.

=== CRITICAL SIZE CONSTRAINT (NON-NEGOTIABLE) ===
**The final system prompt MUST be under 4,800 characters. This is a HARD CAP.** Larger prompts cause 10-20 second voice latency that kills calls.

WHAT BELONGS IN THE PROMPT (KEEP):
- Identity, persona, tone, languages
- Conversation flow (6 stages, brief)
- Objection handling patterns (2-3 examples, not exhaustive)
- Strict rules (non-negotiables)
- 2-3 example opening/closing lines per language
- Brief business summary: WHAT the company does in 2 sentences + names of 2-3 top products/services (names only, no descriptions)

WHAT MUST NEVER APPEAR IN THE PROMPT (these go to Knowledge Base, not prompt):
- Full product catalogs, descriptions, SKUs
- Complete pricing tables, variants, discounts
- Long feature lists, technical specs
- Verbose FAQs with full answers
- Any raw website content or document text
- Full policy docs, terms, warranty details
- Long list of offers, combos, packages

INSTEAD: Include ONE section titled "KNOWLEDGE BASE ACCESS" with this exact text:
"You have access to the company's full knowledge base (products, pricing, features, policies, FAQs). ALWAYS call the search_knowledge_base tool with 2-6 keywords when the customer asks anything specific. Never invent facts. Answer naturally from tool results."

=== OUTPUT FORMAT ===
Return ONLY the system prompt itself (no preamble, no meta-commentary, no markdown fences). Start directly with "You are ${p.agent_name || 'Vaani'}, ...".

**TARGET LENGTH: 3,500-4,500 characters. HARD CEILING: 4,800 characters. Cut ruthlessly — every sentence must earn its place.**`;

    // 5. Generate the system prompt via Azure OpenAI directly (bypasses Base44 integration credits).
    let generated = await callAzureOpenAI(metaPrompt, { maxTokens: 3000 });
    generated = (generated || '').trim();
    if (!generated) {
      return c.json({ data: { error: 'AI did not return a prompt — please retry' } }, 502);
    }

    // 5a. Enforce hard 4,800-char cap. ONE compression attempt only — additional retries
    // each take 30-40s and make users think the tool is hung.
    const HARD_CAP = 4800;
    if (generated.length > HARD_CAP) {
      console.log(`[generateAgentPrompt] Prompt too long (${generated.length} chars), compressing...`);
      const compressPrompt = `Compress the following voice agent system prompt to under ${HARD_CAP} characters. Keep: identity, tone, 6-stage flow, 2 examples per language, strict rules, knowledge_base_access instruction. Remove: verbose descriptions, redundant examples, long product/pricing details. Return ONLY the compressed prompt.

ORIGINAL:
${generated}`;
      const compressed = (await callAzureOpenAI(compressPrompt, { maxTokens: 2500 })).trim();
      if (compressed && compressed.length < generated.length) generated = compressed;
    }
    // Final hard truncate if still over (safety net)
    if (generated.length > HARD_CAP) {
      generated = generated.substring(0, HARD_CAP) + '\n\n[Use search_knowledge_base tool for any additional details.]';
      console.warn(`[generateAgentPrompt] Forced truncate to ${HARD_CAP} chars`);
    }

    // 5b. Auto-save website + document content as a Knowledge Base entry for this client.
    // The voice agent's RAG tool (search_knowledge_base) will retrieve relevant chunks on demand.
    let autoKbId = null;
    let autoKbChars = 0;
    try {
      const kbParts = [];
      if (websiteContext) kbParts.push(`=== Website Content (${urlToScrape}) ===\n${websiteContext.replace(/^WEBSITE CONTENT[^:]*:\n/, '')}`);
      if (brandContext) kbParts.push(`=== Brand & Business Details ===\n${brandContext}`);
      if (kbContext) kbParts.push(`=== Uploaded Documents ===\n${kbContext.replace(/^UPLOADED DOCUMENTS:\n/, '')}`);

      if (kbParts.length > 0) {
        const combinedContent = kbParts.join('\n\n---\n\n');
        autoKbChars = combinedContent.length;
        const autoKbTitle = `AI-Generated KB — ${p.agent_name || 'Agent'} (${new Date().toISOString().substring(0, 10)})`;

        // Check if an auto-generated KB entry already exists for this agent config — replace it to avoid duplicates
        const existing = await base44.asServiceRole.entities.KnowledgeBase.filter({
          client_id,
          category: 'AI Agent Auto-Generated'
        }).catch(() => []);

        if (existing.length > 0) {
          // Update the most recent auto-generated entry
          await base44.asServiceRole.entities.KnowledgeBase.update(existing[0].id, {
            title: autoKbTitle,
            content: combinedContent,
            status: 'ready'
          });
          autoKbId = existing[0].id;
          console.log(`[generateAgentPrompt] Updated auto-KB ${autoKbId}: ${autoKbChars} chars`);
        } else {
          const newKb = await base44.asServiceRole.entities.KnowledgeBase.create({
            client_id,
            title: autoKbTitle,
            content: combinedContent,
            file_type: 'txt',
            status: 'ready',
            category: 'AI Agent Auto-Generated'
          });
          autoKbId = newKb.id;
          console.log(`[generateAgentPrompt] Created auto-KB ${autoKbId}: ${autoKbChars} chars`);
        }
      }
    } catch (kbErr) {
      console.error(`[generateAgentPrompt] Auto-KB save failed: ${kbErr.message}`);
    }

    // 6. Generate matching greeting line
    const greetingPrompt = `Based on this agent config, write ONE short, natural voice greeting (1-2 sentences, max 25 words) that the agent will speak the instant the call connects. Make it warm and human — not "Hello, thank you for calling" corporate style.

Agent: ${p.agent_name || 'Vaani'} from ${client.company_name}
Language: ${(p.languages || ['en-IN']).join(' + ')}
Tone: ${p.tone || 'friendly'}
Campaign: ${c.type || 'general'}

Return ONLY the greeting text, no quotes, no explanation.`;

    const greeting = await callAzureOpenAI(greetingPrompt, { maxTokens: 200 });

    // 7. Build list of KB IDs to attach to the agent: any user-selected + the auto-generated one
    const attachedKbIds = [...(knowledge_base_ids || [])];
    if (autoKbId && !attachedKbIds.includes(autoKbId)) attachedKbIds.push(autoKbId);

    return c.json({ data: {
      success: true,
      system_prompt: generated,
      greeting_message: (greeting || '').trim().replace(/^["']|["']$/g, ''),
      knowledge_base_ids: attachedKbIds,
      auto_kb_id: autoKbId,
      context_used: {
        website_scraped: !!websiteContext,
        website_chars: websiteContext.length,
        kb_docs: knowledge_base_ids?.length || 0,
        brand_fields: Object.keys(brand).length,
        auto_kb_chars: autoKbChars,
        prompt_chars: generated.length,
        prompt_within_cap: generated.length <= HARD_CAP
      }
    } });
  } catch (error) {
    console.error('generateAgentPrompt error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};