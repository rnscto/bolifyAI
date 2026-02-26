// Azure AI available voices list
const AZURE_VOICES = [
  // Dragon HD Latest - Indian English
  { name: "Meera Dragon HD Latest", gender: "Female", lang: "English (India)", style: "" },
  { name: "Aarti Dragon HD Latest", gender: "Female", lang: "English (India)", style: "" },
  { name: "Arjun Dragon HD Latest", gender: "Male", lang: "English (India)", style: "" },

  // Dragon HD Latest - US English
  { name: "Ava Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Pleasant, Friendly, Caring" },
  { name: "Andrew Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Confident, Casual, Warm" },
  { name: "Adam Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Warm, Engaging, Deep" },
  { name: "Alloy Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Versatile" },
  { name: "Aria Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Confident, Authentic, Warm" },
  { name: "Bree Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Cheerful, Light-Hearted, Casual" },
  { name: "Brian Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Sincere, Calm, Approachable" },
  { name: "Davis Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Calm, Smooth, Soothing" },
  { name: "Emma Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Cheerful, Light-Hearted, Casual" },
  { name: "Emma2 Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Light-Hearted, Casual, Cheerful" },
  { name: "Jane Dragon HD Latest", gender: "Female", lang: "English (US)", style: "" },
  { name: "Jenny Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Sincere, Pleasant, Approachable" },
  { name: "Nova Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Deep, Resonant" },
  { name: "Phoebe Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Youthful, Upbeat, Confident" },
  { name: "Serena Dragon HD Latest", gender: "Female", lang: "English (US)", style: "Formal, Confident, Mature" },
  { name: "Steffan Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Mature, Authentic, Warm" },
  { name: "Andrew2 Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Confident, Casual, Warm" },
  { name: "Andrew3 Dragon HD Latest", gender: "Male", lang: "English (US)", style: "Confident, Casual, Warm" },

  // Dragon HD Omni Latest
  { name: "Andrew Dragon HD Omni Latest", gender: "Male", lang: "English (US)", style: "" },
  { name: "Caleb Dragon HD Omni Latest", gender: "Male", lang: "English (US)", style: "" },
  { name: "Dana Dragon HD Omni Latest", gender: "Female", lang: "English (US)", style: "" },
  { name: "Lewis Dragon HD Omni Latest", gender: "Male", lang: "English (US)", style: "" },
  { name: "Phoebe Dragon HD Omni Latest", gender: "Female", lang: "English (US)", style: "" },
  { name: "Ava Dragon HD Omni Latest", gender: "Female", lang: "English (US)", style: "" },

  // Dragon HD Flash Latest
  { name: "Tiana Dragon HD Flash Latest", gender: "Female", lang: "English (US)", style: "" },

  // Turbo Multilingual
  { name: "Onyx Turbo Multilingual", gender: "Male", lang: "English (US)", style: "Youthful, Upbeat, Confident" },
  { name: "Nova Turbo Multilingual", gender: "Female", lang: "English (US)", style: "Deep, Resonant" },
  { name: "Shimmer Turbo Multilingual", gender: "Female", lang: "English (US)", style: "Bright, Engaging" },
  { name: "Brian Turbo Multilingual", gender: "Male", lang: "English (US)", style: "Sincere, Calm, Approachable" },
  { name: "Alloy Turbo Multilingual", gender: "Male", lang: "English (US)", style: "Versatile" },
  { name: "Echo Turbo Multilingual", gender: "Male", lang: "English (US)", style: "Clear, Expressive" },
  { name: "Fable Turbo Multilingual", gender: "Female", lang: "English (US)", style: "Mystery" },

  // Multilingual
  { name: "Samuel Multilingual", gender: "Male", lang: "English (US)", style: "Sincere, Warm, Expressive" },
  { name: "Serena Multilingual", gender: "Female", lang: "English (US)", style: "Formal, Confident, Mature" },
  { name: "Steffan Multilingual", gender: "Male", lang: "English (US)", style: "Casual, Thoughtful" },
  { name: "Arabella Multilingual", gender: "Female", lang: "Spanish (Spain)", style: "Cheerful" },
  { name: "Cora Multilingual", gender: "Female", lang: "English (US)", style: "Empathetic, Formal, Sincere" },
  { name: "Christopher Multilingual", gender: "Male", lang: "English (US)", style: "Deep, Warm" },
  { name: "Brandon Multilingual", gender: "Male", lang: "English (US)", style: "Warm, Engaging, Authentic" },
  { name: "Davis Multilingual", gender: "Male", lang: "English (US)", style: "Soothing, Calm, Smooth" },
  { name: "Derek Multilingual", gender: "Male", lang: "English (US)", style: "Confident, Knowledgeable, Formal" },
  { name: "Dustin Multilingual", gender: "Male", lang: "English (US)", style: "Youthful, Clear, Thoughtful" },
  { name: "Evelyn Multilingual", gender: "Female", lang: "English (US)", style: "Youthful, Crisp, Upbeat" },
  { name: "Jenny Multilingual", gender: "Female", lang: "English (US)", style: "Sincere, Pleasant, Approachable" },
  { name: "Lewis Multilingual", gender: "Male", lang: "English (US)", style: "Knowledgeable, Formal, Confident" },
  { name: "Lola Multilingual", gender: "Female", lang: "English (US)", style: "Sincere, Calm, Warm" },
  { name: "Nancy Multilingual", gender: "Female", lang: "English (US)", style: "Casual, Youthful, Approachable" },
  { name: "Ryan Multilingual", gender: "Male", lang: "English (US)", style: "Professional, Authentic, Sincere" },
  { name: "Emma Multilingual", gender: "Female", lang: "English (US)", style: "Cheerful, Light-Hearted, Casual" },
  { name: "Phoebe Multilingual", gender: "Female", lang: "English (US)", style: "Youthful, Upbeat, Confident" },
  { name: "Ada Multilingual", gender: "Female", lang: "English (UK)", style: "Cheerful, Warm, Gentle, Friendly" },
  { name: "Ollie Multilingual", gender: "Male", lang: "English (UK)", style: "Warm, Cheerful, Casual, Friendly" },
  { name: "Ava Multilingual", gender: "Female", lang: "English (US)", style: "Pleasant, Friendly, Caring" },
  { name: "Andrew Multilingual", gender: "Male", lang: "English (US)", style: "Confident, Casual, Warm" },
];

export default AZURE_VOICES;