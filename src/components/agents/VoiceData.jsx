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

export const GEMINI_VOICES = [
  { name: "Puck", gender: "Male", style: "Neutral, engaging" },
  { name: "Charon", gender: "Male", style: "Neutral, authoritative" },
  { name: "Kore", gender: "Female", style: "Neutral, bright" },
  { name: "Fenrir", gender: "Male", style: "Neutral, deep" },
  { name: "Aoede", gender: "Female", style: "Neutral, calm" },
  { name: "Zephyr", gender: "Neutral", style: "Smooth, balanced" },
  { name: "Enceladus", gender: "Male", style: "Deep, clear" },
  { name: "Leda", gender: "Female", style: "Versatile, natural" },
  { name: "Sadachbia", gender: "Neutral", style: "Clear, engaging" },
  { name: "Vindemiatrix", gender: "Female", style: "Bright, articulate" },
  { name: "Callirrhoe", gender: "Female", style: "Soft, melodic" },
  { name: "Umbriel", gender: "Male", style: "Deep, resonant" },
  { name: "Gacrux", gender: "Male", style: "Strong, commanding" },
  { name: "Orus", gender: "Male", style: "Clear, confident" },
  { name: "Autonoe", gender: "Female", style: "Warm, conversational" },
  { name: "Iapetus", gender: "Male", style: "Grounded, smooth" },
  { name: "Algieba", gender: "Female", style: "Energetic, clear" },
  { name: "Despina", gender: "Female", style: "Crisp, precise" },
  { name: "Erinome", gender: "Female", style: "Friendly, casual" },
  { name: "Algenib", gender: "Male", style: "Professional, balanced" },
  { name: "Rasalgethi", gender: "Male", style: "Warm, engaging" },
  { name: "Laomedeia", gender: "Female", style: "Calm, thoughtful" },
  { name: "Achernar", gender: "Male", style: "Crisp, dynamic" },
  { name: "Alnilam", gender: "Male", style: "Smooth, professional" },
  { name: "Schedar", gender: "Female", style: "Authoritative, clear" },
  { name: "Pulcherrima", gender: "Female", style: "Melodic, warm" },
  { name: "Achird", gender: "Male", style: "Direct, engaging" },
  { name: "Sadaltager", gender: "Neutral", style: "Balanced, clear" },
  { name: "Sulafat", gender: "Female", style: "Expressive, bright" }
];

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