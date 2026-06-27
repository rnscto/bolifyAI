// 22 Scheduled Indian languages + Indian-English + Bilingual.
// Each entry maps the language to:
//   - locale: Azure/Whisper locale code
//   - azure_voice: a default Azure Speech Neural voice that speaks with an Indian accent
//   - realtime_voice: a Gemini Multimodal Live API voice (Aoede, Charon, Fenrir, Kore, Puck)
//     (Gemini Live API does not have per-language voices — voices are language-agnostic.
//      For BEST Indian-accent results, we standardize on "Kore" (Female) or "Puck" (Male)
//      and instruct the model in the prompt to speak with an Indian accent.)
//   - hint: short note about the language family / where it's spoken

export const INDIAN_LANGUAGES = [
  { value: 'en-IN', label: 'English (India)',          locale: 'en-IN', azure_voice: 'en-IN-NeerjaNeural', realtime_voice: 'Kore', hint: 'Indian English accent' },
  { value: 'hi-IN', label: 'Hindi',                    locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',  realtime_voice: 'Kore', hint: 'हिन्दी' },
  { value: 'bilingual', label: 'Bilingual (Hinglish — Hindi + English)', locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural', realtime_voice: 'Kore', hint: 'Switch naturally between Hindi & English' },
  { value: 'bn-IN', label: 'Bengali (Bangla)',         locale: 'bn-IN', azure_voice: 'bn-IN-TanishaaNeural', realtime_voice: 'Kore', hint: 'বাংলা' },
  { value: 'mr-IN', label: 'Marathi',                  locale: 'mr-IN', azure_voice: 'mr-IN-AarohiNeural',   realtime_voice: 'Kore', hint: 'मराठी' },
  { value: 'te-IN', label: 'Telugu',                   locale: 'te-IN', azure_voice: 'te-IN-ShrutiNeural',   realtime_voice: 'Kore', hint: 'తెలుగు' },
  { value: 'ta-IN', label: 'Tamil',                    locale: 'ta-IN', azure_voice: 'ta-IN-PallaviNeural',  realtime_voice: 'Kore', hint: 'தமிழ்' },
  { value: 'gu-IN', label: 'Gujarati',                 locale: 'gu-IN', azure_voice: 'gu-IN-DhwaniNeural',   realtime_voice: 'Kore', hint: 'ગુજરાતી' },
  { value: 'kn-IN', label: 'Kannada',                  locale: 'kn-IN', azure_voice: 'kn-IN-SapnaNeural',    realtime_voice: 'Kore', hint: 'ಕನ್ನಡ' },
  { value: 'ml-IN', label: 'Malayalam',                locale: 'ml-IN', azure_voice: 'ml-IN-SobhanaNeural',  realtime_voice: 'Kore', hint: 'മലയാളം' },
  { value: 'pa-IN', label: 'Punjabi',                  locale: 'pa-IN', azure_voice: 'pa-IN-OjasNeural',     realtime_voice: 'Puck', hint: 'ਪੰਜਾਬੀ' },
  { value: 'or-IN', label: 'Odia (Oriya)',             locale: 'or-IN', azure_voice: 'or-IN-SubhasiniNeural', realtime_voice: 'Kore', hint: 'ଓଡ଼ିଆ' },
  { value: 'ur-IN', label: 'Urdu',                     locale: 'ur-IN', azure_voice: 'ur-IN-GulNeural',      realtime_voice: 'Kore', hint: 'اُردُو' },
  { value: 'as-IN', label: 'Assamese',                 locale: 'as-IN', azure_voice: 'as-IN-YashicaNeural',  realtime_voice: 'Kore', hint: 'অসমীয়া' },
  { value: 'ne-NP', label: 'Nepali',                   locale: 'ne-NP', azure_voice: 'ne-NP-HemkalaNeural',  realtime_voice: 'Kore', hint: 'नेपाली' },
  { value: 'sd-IN', label: 'Sindhi',                   locale: 'sd-IN', azure_voice: 'sd-IN-SunilNeural',    realtime_voice: 'Puck', hint: 'سنڌي / सिन्धी (TTS limited)' },
  { value: 'ks-IN', label: 'Kashmiri',                 locale: 'ks-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'Kore', hint: 'कॉशुर (uses Hindi voice fallback)' },
  { value: 'sa-IN', label: 'Sanskrit',                 locale: 'sa-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'Kore', hint: 'संस्कृतम् (uses Hindi voice fallback)' },
  { value: 'mai-IN', label: 'Maithili',                locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'Kore', hint: 'मैथिली (uses Hindi voice fallback)' },
  { value: 'kok-IN', label: 'Konkani',                 locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'Kore', hint: 'कोंकणी (uses Hindi voice fallback)' },
  { value: 'doi-IN', label: 'Dogri',                   locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'Kore', hint: 'डोगरी (uses Hindi voice fallback)' },
  { value: 'mni-IN', label: 'Manipuri (Meitei)',       locale: 'bn-IN', azure_voice: 'bn-IN-TanishaaNeural', realtime_voice: 'Kore', hint: 'ꯃꯩꯇꯩꯂꯣꯟ (uses Bengali voice fallback)' },
  { value: 'sat-IN', label: 'Santali',                 locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'Kore', hint: 'ᱥᱟᱱᱛᱟᱲᱤ (uses Hindi voice fallback)' },
  { value: 'bho-IN', label: 'Bhojpuri',                locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'Kore', hint: 'भोजपुरी (uses Hindi voice fallback)' },
  // Global Languages
  { value: 'en-US', label: 'English (US)',             locale: 'en-US', azure_voice: 'en-US-JennyNeural',    realtime_voice: 'Kore', hint: 'American English' },
  { value: 'en-GB', label: 'English (UK)',             locale: 'en-GB', azure_voice: 'en-GB-SoniaNeural',    realtime_voice: 'Kore', hint: 'British English' },
  { value: 'en-AU', label: 'English (Australia)',      locale: 'en-AU', azure_voice: 'en-AU-NatashaNeural',  realtime_voice: 'Kore', hint: 'Australian English' },
  { value: 'es-ES', label: 'Spanish',                  locale: 'es-ES', azure_voice: 'es-ES-ElviraNeural',   realtime_voice: 'Kore', hint: 'Español' },
  { value: 'fr-FR', label: 'French',                   locale: 'fr-FR', azure_voice: 'fr-FR-DeniseNeural',   realtime_voice: 'Kore', hint: 'Français' },
  { value: 'de-DE', label: 'German',                   locale: 'de-DE', azure_voice: 'de-DE-KatjaNeural',    realtime_voice: 'Kore', hint: 'Deutsch' },
  { value: 'it-IT', label: 'Italian',                  locale: 'it-IT', azure_voice: 'it-IT-ElsaNeural',     realtime_voice: 'Kore', hint: 'Italiano' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)',      locale: 'pt-BR', azure_voice: 'pt-BR-FranciscaNeural',realtime_voice: 'Kore', hint: 'Português' },
  { value: 'ar-SA', label: 'Arabic',                   locale: 'ar-SA', azure_voice: 'ar-SA-ZariyahNeural',  realtime_voice: 'Kore', hint: 'العربية' },
  { value: 'zh-CN', label: 'Chinese (Mandarin)',       locale: 'zh-CN', azure_voice: 'zh-CN-XiaoxiaoNeural', realtime_voice: 'Kore', hint: '中文' },
  { value: 'ja-JP', label: 'Japanese',                 locale: 'ja-JP', azure_voice: 'ja-JP-NanamiNeural',   realtime_voice: 'Kore', hint: '日本語' },
  { value: 'ko-KR', label: 'Korean',                   locale: 'ko-KR', azure_voice: 'ko-KR-SunHiNeural',    realtime_voice: 'Kore', hint: '한국어' }
];

export const AGENT_ROLES = [
  { value: 'sales_outbound',      label: 'Sales (Outbound Cold Calling)' },
  { value: 'lead_qualification',  label: 'Lead Qualification' },
  { value: 'appointment_booking', label: 'Appointment / Demo Booking' },
  { value: 'customer_support',    label: 'Customer Support' },
  { value: 'order_status',        label: 'Order Status / Delivery Enquiries' },
  { value: 'survey_feedback',     label: 'Survey & Feedback' },
  { value: 'reception',           label: 'Reception / IVR Replacement' },
  { value: 'inbound_inquiry',     label: 'Inbound Inquiry Handling' },
  { value: 'reminders',           label: 'Reminders / Follow-up Calls' },
  { value: 'personal_assistant',  label: 'Personal AI Assistant' }
];

export const TONE_OPTIONS = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly',     label: 'Friendly' },
  { value: 'formal',       label: 'Formal' },
  { value: 'energetic',    label: 'Energetic' },
  { value: 'empathetic',   label: 'Empathetic' }
];