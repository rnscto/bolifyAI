// ═══════════════════════════════════════════════════════════════════
// Voice options for Azure Voice Live API
// Three types: openai (built-in GPT voices), azure-standard (Azure TTS), azure-speech (legacy hybrid TTS)
// ═══════════════════════════════════════════════════════════════════

// OpenAI built-in voices (type: "openai") — used with gpt-realtime model
export const OPENAI_VOICES = [
  { name: "alloy", gender: "Male", style: "Versatile, balanced", lang: "Multi" },
  { name: "ash", gender: "Male", style: "Clear, direct", lang: "Multi" },
  { name: "ballad", gender: "Male", style: "Warm, melodic", lang: "Multi" },
  { name: "coral", gender: "Female", style: "Warm, engaging", lang: "Multi" },
  { name: "echo", gender: "Male", style: "Clear, expressive", lang: "Multi" },
  { name: "sage", gender: "Female", style: "Calm, thoughtful", lang: "Multi" },
  { name: "shimmer", gender: "Female", style: "Bright, engaging", lang: "Multi" },
  { name: "verse", gender: "Male", style: "Smooth, articulate", lang: "Multi" },
];

// Azure Standard voices (type: "azure-standard") — Azure TTS Neural voices
// These work with any model including gpt-realtime
export const AZURE_STANDARD_VOICES = [
  // Hindi
  { name: "hi-IN-SwaraNeural", gender: "Female", style: "Natural Hindi", lang: "Hindi" },
  { name: "hi-IN-MadhurNeural", gender: "Male", style: "Natural Hindi", lang: "Hindi" },
  // English (India)
  { name: "en-IN-NeerjaNeural", gender: "Female", style: "Indian English", lang: "English (IN)" },
  { name: "en-IN-PrabhatNeural", gender: "Male", style: "Indian English", lang: "English (IN)" },
  { name: "en-IN-AaravNeural", gender: "Male", style: "Young, friendly", lang: "English (IN)" },
  { name: "en-IN-AnanyaNeural", gender: "Female", style: "Warm, professional", lang: "English (IN)" },
  // English (US)
  { name: "en-US-JennyNeural", gender: "Female", style: "Friendly, professional", lang: "English (US)" },
  { name: "en-US-GuyNeural", gender: "Male", style: "Professional, clear", lang: "English (US)" },
  { name: "en-US-AriaNeural", gender: "Female", style: "Expressive, warm", lang: "English (US)" },
  { name: "en-US-DavisNeural", gender: "Male", style: "Warm, engaging", lang: "English (US)" },
  // English (UK)
  { name: "en-GB-SoniaNeural", gender: "Female", style: "British, professional", lang: "English (UK)" },
  { name: "en-GB-RyanNeural", gender: "Male", style: "British, clear", lang: "English (UK)" },
  // HD Multilingual (Dragon)
  { name: "en-US-Ava:DragonHDLatestNeural", gender: "Female", style: "HD Multilingual, expressive", lang: "Multi HD" },
  { name: "en-US-Andrew:DragonHDLatestNeural", gender: "Male", style: "HD Multilingual, clear", lang: "Multi HD" },
  { name: "en-US-Emma:DragonHDLatestNeural", gender: "Female", style: "HD Multilingual, warm", lang: "Multi HD" },
  { name: "en-US-Brian:DragonHDLatestNeural", gender: "Male", style: "HD Multilingual, professional", lang: "Multi HD" },
];

// Legacy Azure Speech TTS voices (for azure_speech hybrid engine — Realtime STT + Azure Speech TTS)
export const AZURE_SPEECH_VOICES = AZURE_STANDARD_VOICES;

// Legacy alias — maps to OpenAI voices for backward compatibility
export const REALTIME_VOICES = OPENAI_VOICES;

// Voice engine options for the UI
export const VOICE_ENGINE_OPTIONS = [
  { value: 'voice_live_openai', label: 'Voice Live — OpenAI Voices', description: 'GPT-4o built-in voices (alloy, coral, etc.) — lowest latency' },
  { value: 'voice_live_azure', label: 'Voice Live — Azure Voices', description: 'Azure Neural TTS (Hindi, English, HD multilingual) — best language support' },
  { value: 'realtime', label: 'Realtime API — OpenAI Voices (Legacy)', description: 'Original Realtime API pipeline with sample rate conversion' },
  { value: 'azure_speech', label: 'Hybrid — Azure Speech TTS (Legacy)', description: 'Realtime STT + GPT + Azure Speech TTS' },
];

// Helper: get voices list for a given engine
export function getVoicesForEngine(engine) {
  switch (engine) {
    case 'voice_live_openai': return OPENAI_VOICES;
    case 'voice_live_azure': return AZURE_STANDARD_VOICES;
    case 'realtime': return OPENAI_VOICES;
    case 'azure_speech': return AZURE_SPEECH_VOICES;
    default: return OPENAI_VOICES;
  }
}

// Helper: get default voice for a given engine
export function getDefaultVoice(engine) {
  switch (engine) {
    case 'voice_live_openai': return 'alloy';
    case 'voice_live_azure': return 'hi-IN-SwaraNeural';
    case 'realtime': return 'alloy';
    case 'azure_speech': return 'hi-IN-SwaraNeural';
    default: return 'alloy';
  }
}

// Default export
const AZURE_VOICES = OPENAI_VOICES;
export default AZURE_VOICES;