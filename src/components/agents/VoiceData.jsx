// Azure OpenAI Realtime API supported voices (gpt-realtime-1.5)
export const REALTIME_VOICES = [
  { name: "alloy", gender: "Male", style: "Versatile, balanced" },
  { name: "ash", gender: "Male", style: "Clear, direct" },
  { name: "ballad", gender: "Male", style: "Warm, melodic" },
  { name: "coral", gender: "Female", style: "Warm, engaging" },
  { name: "echo", gender: "Male", style: "Clear, expressive" },
  { name: "sage", gender: "Female", style: "Calm, thoughtful" },
  { name: "shimmer", gender: "Female", style: "Bright, engaging" },
  { name: "verse", gender: "Male", style: "Smooth, articulate" },
  { name: "marin", gender: "Female", style: "Friendly, natural" },
  { name: "cedar", gender: "Male", style: "Deep, resonant" },
];

// Azure Speech TTS voices (popular Indian English + Hindi voices)
export const AZURE_SPEECH_VOICES = [
  // English (India)
  { name: "en-IN-NeerjaNeural", gender: "Female", style: "Default Indian English", lang: "en-IN" },
  { name: "en-IN-PrabhatNeural", gender: "Male", style: "Default Indian English", lang: "en-IN" },
  { name: "en-IN-AaravNeural", gender: "Male", style: "Young, friendly", lang: "en-IN" },
  { name: "en-IN-AnanyaNeural", gender: "Female", style: "Warm, professional", lang: "en-IN" },
  // Hindi
  { name: "hi-IN-SwaraNeural", gender: "Female", style: "Natural Hindi", lang: "hi-IN" },
  { name: "hi-IN-MadhurNeural", gender: "Male", style: "Natural Hindi", lang: "hi-IN" },
  // English (US) - popular
  { name: "en-US-JennyNeural", gender: "Female", style: "Friendly, professional", lang: "en-US" },
  { name: "en-US-GuyNeural", gender: "Male", style: "Professional, clear", lang: "en-US" },
  { name: "en-US-AriaNeural", gender: "Female", style: "Expressive, warm", lang: "en-US" },
  { name: "en-US-DavisNeural", gender: "Male", style: "Warm, engaging", lang: "en-US" },
  // English (UK)
  { name: "en-GB-SoniaNeural", gender: "Female", style: "British, professional", lang: "en-GB" },
  { name: "en-GB-RyanNeural", gender: "Male", style: "British, clear", lang: "en-GB" },
  // Multilingual HD
  { name: "en-US-Ava:DragonHDLatest", gender: "Female", style: "HD Multilingual, expressive", lang: "multi" },
  { name: "en-US-Andrew:DragonHDLatest", gender: "Male", style: "HD Multilingual, clear", lang: "multi" },
  { name: "en-US-Emma:DragonHDLatest", gender: "Female", style: "HD Multilingual, warm", lang: "multi" },
  { name: "en-US-Brian:DragonHDLatest", gender: "Male", style: "HD Multilingual, professional", lang: "multi" },
];

// Default export for backward compatibility
const AZURE_VOICES = REALTIME_VOICES;
export default AZURE_VOICES;