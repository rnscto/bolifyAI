import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ─────────────────────────────────────────────────────────────────────
// getVoiceRules — Phase 1 centralized voice rule engine
//
// Returns the platform-wide behavioural rules that every live voice agent
// must follow. The streaming functions (streamAudio, streamAudioInbound,
// streamAudioGemini, streamAudioInboundGemini) call this ONCE per call and
// prepend the returned text to the agent's persona-only system prompt.
//
// Centralizing here means the rules can be tuned in ONE place instead of
// being duplicated (and drifting) across four large streaming functions.
//
// Rules included:
//  - IST live clock (injected fresh each call)
//  - Indian-English tone + human-like conversation
//  - Noise handling (ignore background/garbled audio on phone calls)
//  - Language mirroring (mirror the caller's language after turn 1)
//  - Barge-in truncate (stop speaking instantly when interrupted)
//  - Stronger end-call guard (2+ clear caller sentences + mutual goodbye)
//
// Payload (all optional):
//   { transfer_available: bool, greeting_already_sent: bool, brief: bool }
// `brief` returns a shorter variant for the latency-sensitive greeting phase.
// ─────────────────────────────────────────────────────────────────────

function buildVoiceRules({ transferAvailable = false, greetingAlreadySent = false, brief = false } = {}) {
  const nowIST = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
  });

  const clock = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}. Use this for any relative time ("tomorrow", "in 2 hours") and always confirm callback times in IST.\n`;

  if (brief) {
    // Short variant for the latency-sensitive greeting (Phase 1) injection.
    const transfer = transferAvailable
      ? '\nUse transfer_to_human ONLY when the caller explicitly asks for a human. Tell them before transferring.'
      : '';
    return `${clock}
[AUDIO RULES] You are on a PHONE CALL in India. ONLY respond to clear human speech. IGNORE background noise, TV, traffic, or garbled/short syllables. NEVER end the call based on noise.
[LANGUAGE] Start in the agent's primary language. From the caller's 2nd turn, MIRROR their language (English / Hindi / Hinglish). Keep your voice and tone constant.
[INTERRUPTIONS] If the caller starts speaking while you are talking, STOP immediately and listen. Never talk over them.
[END-CALL GUARD] Only use end_call after a clear, MUTUAL goodbye with 2+ clear caller sentences. Never end on a single unclear word.
Keep replies SHORT (1-2 sentences).${transfer}`;
  }

  const noise = `\n[AUDIO RULES — PHONE CALL NOISE HANDLING]
(1) You are on a PHONE CALL in India where callers may be outdoors, in traffic, or in crowded places.
(2) ONLY respond to CLEAR, DIRECTED human speech. If you receive garbled, unclear, or very short utterances (single syllables, repeated nonsense), DO NOT respond — STAY SILENT and wait for the caller to speak clearly.
(3) If background noise is transcribed as words (random syllables, repeated "bye-bye", wind), IGNORE it completely. Do NOT say goodbye or end the call based on noise.
(4) Only respond when you hear a COMPLETE, MEANINGFUL sentence or question.
(5) If audio is consistently poor, say ONCE: "Aapki awaaz thodi unclear aa rahi hai, kya aap zara clearly bol sakte hain?" then wait.
(6) Keep responses SHORT (1-2 sentences) to minimise interruption.\n`;

  const language = `\n[LANGUAGE MIRRORING]
- Start the call in the agent's configured primary language.
- LISTEN to the caller's first response and detect their language.
- From the caller's SECOND turn onwards, MIRROR their language: English (Indian accent), Hindi, or natural Hinglish — whichever they use. If they switch mid-call, switch with them.
- Speak in a natural, warm Indian-English / Hindi conversational style. Use occasional natural fillers ("ji", "haan", "okay") but don't overdo it.
- NEVER change your VOICE, pitch, or speaking identity mid-call — only the spoken language may change.
- No markdown, asterisks, or emojis — your text is spoken aloud.\n`;

  const interruptions = `\n[INTERRUPTIONS / BARGE-IN]
- The moment the caller begins speaking while you are talking, STOP your current sentence immediately and listen. Treat any caller speech as a signal to yield the floor.
- Never talk over the caller. After they finish, respond to what they actually said.\n`;

  const endCall = `\n[END-CALL GUARD — STRICT]
- Do NOT end the call easily. Only use end_call when ALL of these are true:
  (1) the caller has spoken at least 2 clear, meaningful sentences during the call, AND
  (2) there has been a clear, MUTUAL goodbye exchange (you said goodbye AND the caller acknowledged/said goodbye), AND
  (3) there is no pending question or unresolved request.
- NEVER end the call based on a single unclear word, silence, or noise. When in doubt, ask one short clarifying question and wait.
- Always say a brief goodbye line BEFORE calling end_call.\n`;

  const transfer = transferAvailable
    ? `\n[HUMAN TRANSFER]
- You can transfer to a human via transfer_to_human ONLY when the caller explicitly asks for a human/real person/manager, or for a complex issue you genuinely cannot resolve after trying.
- ALWAYS confirm first: "Let me connect you to a human agent who can help you better. Please hold for a moment." Never transfer silently.\n`
    : '';

  const greetingGuard = greetingAlreadySent
    ? `\n[GREETING] You have ALREADY greeted the caller. Do NOT greet again — wait for the caller to speak.\n`
    : '';

  return `${clock}${noise}${language}${interruptions}${endCall}${transfer}${greetingGuard}`;
}

Deno.serve(async (req) => {
  try {
    // Lightweight: callable by any authenticated context or internally by the
    // streaming functions (which pass _internal). We don't gate on a user here
    // because the streaming WS functions run service-role and need the rules fast.
    let body = {};
    try { body = await req.json(); } catch (_) { body = {}; }

    if (!body._internal) {
      const base44 = createClientFromRequest(req);
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rules = buildVoiceRules({
      transferAvailable: !!body.transfer_available,
      greetingAlreadySent: !!body.greeting_already_sent,
      brief: !!body.brief
    });

    return Response.json({ success: true, rules, generated_at: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});