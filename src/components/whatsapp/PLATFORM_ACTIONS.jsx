// Platform actions that can be auto-linked to WhatsApp templates.
// When the action fires, the linked template is sent automatically.
export const PLATFORM_ACTIONS = [
  { value: 'campaign_interested_followup', label: 'Campaign — Lead Interested', desc: 'After call ends with "interested" outcome', category: 'Campaigns' },
  { value: 'campaign_callback_confirmation', label: 'Campaign — Callback Confirmation', desc: 'When lead requests a callback', category: 'Campaigns' },
  { value: 'campaign_no_answer_retry', label: 'Campaign — No Answer Retry', desc: 'Sent before retry attempt', category: 'Campaigns' },
  { value: 'lead_welcome', label: 'New Lead Welcome', desc: 'Sent when a new lead is created', category: 'Leads' },
  { value: 'retention_offer', label: 'Retention — Offer', desc: 'Sent during platform retention flow', category: 'Retention' },
  { value: 'trial_expiry_reminder', label: 'Trial Expiry Reminder', desc: 'Sent 2 days before trial ends', category: 'Billing' },
  { value: 'kyc_pending_reminder', label: 'KYC Pending Reminder', desc: 'Sent if KYC not completed in 7 days', category: 'Compliance' },
  { value: 'appointment_confirmation', label: 'Appointment Confirmation', desc: 'When an appointment activity is created', category: 'CRM' },
  { value: 'appointment_reminder', label: 'Appointment Reminder', desc: '24 hours before scheduled appointment', category: 'CRM' },
  { value: 'payment_receipt', label: 'Payment Receipt', desc: 'After successful payment', category: 'Billing' },
  { value: 'otp_verification', label: 'OTP / Verification', desc: 'For 2FA / phone verification flows', category: 'Auth' },
  { value: 'manual_only', label: 'Manual Send Only', desc: 'Not linked — only sent manually', category: 'Other' },
];

export const ACTION_BY_VALUE = Object.fromEntries(PLATFORM_ACTIONS.map(a => [a.value, a]));