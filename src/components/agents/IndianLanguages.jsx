// 22 Scheduled Indian languages + Indian-English + Bilingual.
// Each entry maps the language to:
//   - locale: Azure/Whisper locale code
//   - azure_voice: a default Azure Speech Neural voice that speaks with an Indian accent
//   - realtime_voice: a GPT-4o Realtime voice tuned for an Indian-English feel
//     (Realtime API does not have per-language voices — voices are language-agnostic.
//      For BEST Indian-accent results in Realtime, we standardize on "shimmer"/"coral"/"verse"
//      and instruct the model in the prompt to speak with an Indian accent.)
//   - hint: short note about the language family / where it's spoken

export const INDIAN_LANGUAGES = [
  { value: 'en-IN', label: 'English (India)',          locale: 'en-IN', azure_voice: 'en-IN-NeerjaNeural', realtime_voice: 'shimmer', hint: 'Indian English accent' },
  { value: 'hi-IN', label: 'Hindi',                    locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',  realtime_voice: 'shimmer', hint: 'हिन्दी' },
  { value: 'bilingual', label: 'Bilingual (Hinglish — Hindi + English)', locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural', realtime_voice: 'shimmer', hint: 'Switch naturally between Hindi & English' },
  { value: 'bn-IN', label: 'Bengali (Bangla)',         locale: 'bn-IN', azure_voice: 'bn-IN-TanishaaNeural', realtime_voice: 'shimmer', hint: 'বাংলা' },
  { value: 'mr-IN', label: 'Marathi',                  locale: 'mr-IN', azure_voice: 'mr-IN-AarohiNeural',   realtime_voice: 'shimmer', hint: 'मराठी' },
  { value: 'te-IN', label: 'Telugu',                   locale: 'te-IN', azure_voice: 'te-IN-ShrutiNeural',   realtime_voice: 'shimmer', hint: 'తెలుగు' },
  { value: 'ta-IN', label: 'Tamil',                    locale: 'ta-IN', azure_voice: 'ta-IN-PallaviNeural',  realtime_voice: 'shimmer', hint: 'தமிழ்' },
  { value: 'gu-IN', label: 'Gujarati',                 locale: 'gu-IN', azure_voice: 'gu-IN-DhwaniNeural',   realtime_voice: 'shimmer', hint: 'ગુજરાતી' },
  { value: 'kn-IN', label: 'Kannada',                  locale: 'kn-IN', azure_voice: 'kn-IN-SapnaNeural',    realtime_voice: 'shimmer', hint: 'ಕನ್ನಡ' },
  { value: 'ml-IN', label: 'Malayalam',                locale: 'ml-IN', azure_voice: 'ml-IN-SobhanaNeural',  realtime_voice: 'shimmer', hint: 'മലയാളം' },
  { value: 'pa-IN', label: 'Punjabi',                  locale: 'pa-IN', azure_voice: 'pa-IN-OjasNeural',     realtime_voice: 'shimmer', hint: 'ਪੰਜਾਬੀ' },
  { value: 'or-IN', label: 'Odia (Oriya)',             locale: 'or-IN', azure_voice: 'or-IN-SubhasiniNeural', realtime_voice: 'shimmer', hint: 'ଓଡ଼ିଆ' },
  { value: 'ur-IN', label: 'Urdu',                     locale: 'ur-IN', azure_voice: 'ur-IN-GulNeural',      realtime_voice: 'shimmer', hint: 'اُردُو' },
  { value: 'as-IN', label: 'Assamese',                 locale: 'as-IN', azure_voice: 'as-IN-YashicaNeural',  realtime_voice: 'shimmer', hint: 'অসমীয়া' },
  { value: 'ne-NP', label: 'Nepali',                   locale: 'ne-NP', azure_voice: 'ne-NP-HemkalaNeural',  realtime_voice: 'shimmer', hint: 'नेपाली' },
  { value: 'sd-IN', label: 'Sindhi',                   locale: 'sd-IN', azure_voice: 'sd-IN-SunilNeural',    realtime_voice: 'shimmer', hint: 'سنڌي / सिन्धी (TTS limited)' },
  { value: 'ks-IN', label: 'Kashmiri',                 locale: 'ks-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'shimmer', hint: 'कॉशुर (uses Hindi voice fallback)' },
  { value: 'sa-IN', label: 'Sanskrit',                 locale: 'sa-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'shimmer', hint: 'संस्कृतम् (uses Hindi voice fallback)' },
  { value: 'mai-IN', label: 'Maithili',                locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'shimmer', hint: 'मैथिली (uses Hindi voice fallback)' },
  { value: 'kok-IN', label: 'Konkani',                 locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'shimmer', hint: 'कोंकणी (uses Hindi voice fallback)' },
  { value: 'doi-IN', label: 'Dogri',                   locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'shimmer', hint: 'डोगरी (uses Hindi voice fallback)' },
  { value: 'mni-IN', label: 'Manipuri (Meitei)',       locale: 'bn-IN', azure_voice: 'bn-IN-TanishaaNeural', realtime_voice: 'shimmer', hint: 'ꯃꯩꯇꯩꯂꯣꯟ (uses Bengali voice fallback)' },
  { value: 'sat-IN', label: 'Santali',                 locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'shimmer', hint: 'ᱥᱟᱱᱛᱟᱲᱤ (uses Hindi voice fallback)' },
  { value: 'bho-IN', label: 'Bhojpuri',                locale: 'hi-IN', azure_voice: 'hi-IN-SwaraNeural',    realtime_voice: 'shimmer', hint: 'भोजपुरी (uses Hindi voice fallback)' }
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