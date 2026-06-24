
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE IF NOT EXISTS "partnerpayout" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "partner_id" TEXT,
  "partner_name" TEXT,
  "amount" NUMERIC,
  "period_start" TEXT,
  "period_end" TEXT,
  "status" TEXT,
  "payment_method" TEXT,
  "payment_reference" TEXT,
  "paid_date" TEXT,
  "invoice_number" TEXT,
  "invoice_url" TEXT,
  "referral_count" NUMERIC,
  "notes" TEXT,
  "tds_amount" NUMERIC,
  "net_amount" NUMERIC
);


DROP TRIGGER IF EXISTS update_partnerpayout_updated_at ON "partnerpayout";
CREATE TRIGGER update_partnerpayout_updated_at
BEFORE UPDATE ON "partnerpayout"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "platformmessagingconfig" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "is_singleton" BOOLEAN,
  "whatsapp_provider" TEXT,
  "whatsapp_api_key" TEXT,
  "whatsapp_phone_number_id" TEXT,
  "whatsapp_business_id" TEXT,
  "whatsapp_status" TEXT,
  "whatsapp_last_tested" TEXT,
  "rcs_provider" TEXT,
  "rcs_api_key" TEXT,
  "rcs_bot_id" TEXT,
  "rcs_status" TEXT,
  "from_email" TEXT,
  "from_name" TEXT,
  "lifecycle_enabled" BOOLEAN,
  "lifecycle_templates" JSONB
);


DROP TRIGGER IF EXISTS update_platformmessagingconfig_updated_at ON "platformmessagingconfig";
CREATE TRIGGER update_platformmessagingconfig_updated_at
BEFORE UPDATE ON "platformmessagingconfig"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "partneragreement" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "partner_id" TEXT,
  "template_id" TEXT,
  "template_version" TEXT,
  "agreement_number" TEXT,
  "status" TEXT,
  "partner_name" TEXT,
  "partner_company" TEXT,
  "partner_email" TEXT,
  "partner_address" TEXT,
  "company_signatory_name" TEXT,
  "company_signatory_designation" TEXT,
  "signature_image_url" TEXT,
  "signature_name" TEXT,
  "signed_date" TEXT,
  "signed_ip_address" TEXT,
  "pdf_url" TEXT,
  "effective_date" TEXT,
  "expiry_date" TEXT,
  "rendered_html" TEXT
);


DROP TRIGGER IF EXISTS update_partneragreement_updated_at ON "partneragreement";
CREATE TRIGGER update_partneragreement_updated_at
BEFORE UPDATE ON "partneragreement"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "dataerasurerequest" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "requester_email" TEXT,
  "requester_name" TEXT,
  "requester_phone" TEXT,
  "data_type" TEXT,
  "description" TEXT,
  "status" TEXT,
  "rejection_reason" TEXT,
  "completed_date" TEXT,
  "records_deleted" NUMERIC,
  "processed_by" TEXT
);


DROP TRIGGER IF EXISTS update_dataerasurerequest_updated_at ON "dataerasurerequest";
CREATE TRIGGER update_dataerasurerequest_updated_at
BEFORE UPDATE ON "dataerasurerequest"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "campaignlead" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "campaign_id" TEXT,
  "lead_id" TEXT,
  "client_id" TEXT,
  "status" TEXT,
  "call_status" TEXT,
  "call_log_id" TEXT,
  "outcome" TEXT,
  "conversation_summary" TEXT,
  "transcript" TEXT,
  "followup_scheduled" BOOLEAN,
  "followup_email_sent" BOOLEAN,
  "followup_call_date" TEXT,
  "call_duration" NUMERIC,
  "attempt_count" NUMERIC,
  "lead_name" TEXT,
  "lead_phone" TEXT
);


DROP TRIGGER IF EXISTS update_campaignlead_updated_at ON "campaignlead";
CREATE TRIGGER update_campaignlead_updated_at
BEFORE UPDATE ON "campaignlead"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "crmconfig" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "industry_template_id" TEXT,
  "industry_name" TEXT,
  "deal_stages" JSONB,
  "lead_sources" JSONB,
  "activity_types" JSONB,
  "custom_fields" JSONB,
  "automation_rules" JSONB
);


DROP TRIGGER IF EXISTS update_crmconfig_updated_at ON "crmconfig";
CREATE TRIGGER update_crmconfig_updated_at
BEFORE UPDATE ON "crmconfig"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "referral" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "partner_id" TEXT,
  "client_id" TEXT,
  "client_name" TEXT,
  "client_email" TEXT,
  "client_phone" TEXT,
  "referral_code_used" TEXT,
  "status" TEXT,
  "client_plan_amount" NUMERIC,
  "commission_rate" NUMERIC,
  "total_commission_earned" NUMERIC,
  "last_commission_date" TEXT,
  "signup_date" TEXT,
  "conversion_date" TEXT
);


DROP TRIGGER IF EXISTS update_referral_updated_at ON "referral";
CREATE TRIGGER update_referral_updated_at
BEFORE UPDATE ON "referral"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "did" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "number" TEXT,
  "country_code" TEXT,
  "status" TEXT,
  "is_demo" BOOLEAN,
  "client_id" TEXT,
  "agent_id" TEXT,
  "monthly_cost" NUMERIC,
  "reserved_note" TEXT
);


DROP TRIGGER IF EXISTS update_did_updated_at ON "did";
CREATE TRIGGER update_did_updated_at
BEFORE UPDATE ON "did"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "clientagreementtemplate" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "title" TEXT,
  "version" TEXT,
  "body_html" TEXT,
  "company_signatory_name" TEXT,
  "company_signatory_designation" TEXT,
  "is_active" BOOLEAN,
  "status" TEXT
);


DROP TRIGGER IF EXISTS update_clientagreementtemplate_updated_at ON "clientagreementtemplate";
CREATE TRIGGER update_clientagreementtemplate_updated_at
BEFORE UPDATE ON "clientagreementtemplate"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "kycdocument" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "partner_id" TEXT,
  "entity_type" TEXT,
  "company_type" TEXT,
  "signatory_aadhaar_url" TEXT,
  "signatory_aadhaar_number" TEXT,
  "pan_url" TEXT,
  "pan_number" TEXT,
  "company_kyc_url" TEXT,
  "company_kyc_doc_type" TEXT,
  "additional_doc_url" TEXT,
  "additional_doc_type" TEXT,
  "status" TEXT,
  "rejection_reason" TEXT,
  "reviewed_by" TEXT,
  "reviewed_date" TEXT,
  "kyc_deadline" TEXT,
  "entity_name" TEXT,
  "signatory_name" TEXT
);


DROP TRIGGER IF EXISTS update_kycdocument_updated_at ON "kycdocument";
CREATE TRIGGER update_kycdocument_updated_at
BEFORE UPDATE ON "kycdocument"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "trustedcontact" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "name" TEXT,
  "phone" TEXT,
  "relationship" TEXT,
  "always_connect" BOOLEAN,
  "notes" TEXT
);


DROP TRIGGER IF EXISTS update_trustedcontact_updated_at ON "trustedcontact";
CREATE TRIGGER update_trustedcontact_updated_at
BEFORE UPDATE ON "trustedcontact"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "partner" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "company_name" TEXT,
  "registered_address" TEXT,
  "gst_number" TEXT,
  "pan_number" TEXT,
  "bank_name" TEXT,
  "bank_account_number" TEXT,
  "bank_ifsc" TEXT,
  "upi_id" TEXT,
  "referral_code" TEXT,
  "referral_link" TEXT,
  "status" TEXT,
  "commission_rate" NUMERIC,
  "total_referrals" NUMERIC,
  "active_referrals" NUMERIC,
  "total_earned" NUMERIC,
  "total_paid" NUMERIC,
  "pending_payout" NUMERIC,
  "user_id" TEXT,
  "notes" TEXT,
  "city" TEXT,
  "state" TEXT,
  "brand_logo_url" TEXT,
  "brand_color" TEXT,
  "brand_tagline" TEXT
);


DROP TRIGGER IF EXISTS update_partner_updated_at ON "partner";
CREATE TRIGGER update_partner_updated_at
BEFORE UPDATE ON "partner"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "smartfloauth" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "token" TEXT,
  "expires_at" TEXT,
  "blocked_until" TEXT,
  "last_429_retry_after" TEXT
);


DROP TRIGGER IF EXISTS update_smartfloauth_updated_at ON "smartfloauth";
CREATE TRIGGER update_smartfloauth_updated_at
BEFORE UPDATE ON "smartfloauth"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "agreementtemplate" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "title" TEXT,
  "version" TEXT,
  "body_html" TEXT,
  "company_signatory_name" TEXT,
  "company_signatory_designation" TEXT,
  "is_active" BOOLEAN,
  "status" TEXT
);


DROP TRIGGER IF EXISTS update_agreementtemplate_updated_at ON "agreementtemplate";
CREATE TRIGGER update_agreementtemplate_updated_at
BEFORE UPDATE ON "agreementtemplate"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "knowledgebase" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "title" TEXT,
  "file_url" TEXT,
  "file_type" TEXT,
  "content" TEXT,
  "status" TEXT,
  "category" TEXT
);


DROP TRIGGER IF EXISTS update_knowledgebase_updated_at ON "knowledgebase";
CREATE TRIGGER update_knowledgebase_updated_at
BEFORE UPDATE ON "knowledgebase"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "platformannouncement" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "message" TEXT,
  "severity" TEXT,
  "is_active" BOOLEAN,
  "audience" TEXT,
  "link_url" TEXT,
  "starts_at" TEXT,
  "ends_at" TEXT
);


DROP TRIGGER IF EXISTS update_platformannouncement_updated_at ON "platformannouncement";
CREATE TRIGGER update_platformannouncement_updated_at
BEFORE UPDATE ON "platformannouncement"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "calldecision" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "call_log_id" TEXT,
  "client_id" TEXT,
  "decision" TEXT,
  "custom_message" TEXT,
  "callback_time" TEXT,
  "status" TEXT,
  "caller_number" TEXT,
  "caller_name" TEXT,
  "call_reason" TEXT
);


DROP TRIGGER IF EXISTS update_calldecision_updated_at ON "calldecision";
CREATE TRIGGER update_calldecision_updated_at
BEFORE UPDATE ON "calldecision"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "complaintlog" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "did_number" TEXT,
  "client_id" TEXT,
  "agent_id" TEXT,
  "complainant_number" TEXT,
  "complaint_type" TEXT,
  "complaint_source" TEXT,
  "description" TEXT,
  "status" TEXT,
  "resolution_notes" TEXT,
  "auto_action_taken" TEXT,
  "call_log_id" TEXT
);


DROP TRIGGER IF EXISTS update_complaintlog_updated_at ON "complaintlog";
CREATE TRIGGER update_complaintlog_updated_at
BEFORE UPDATE ON "complaintlog"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "clientagreement" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "template_id" TEXT,
  "template_version" TEXT,
  "agreement_number" TEXT,
  "status" TEXT,
  "client_name" TEXT,
  "signatory_name" TEXT,
  "signatory_email" TEXT,
  "signatory_designation" TEXT,
  "client_address" TEXT,
  "company_signatory_name" TEXT,
  "company_signatory_designation" TEXT,
  "signature_image_url" TEXT,
  "signature_name" TEXT,
  "signed_date" TEXT,
  "signed_ip_address" TEXT,
  "effective_date" TEXT,
  "expiry_date" TEXT,
  "rendered_html" TEXT
);


DROP TRIGGER IF EXISTS update_clientagreement_updated_at ON "clientagreement";
CREATE TRIGGER update_clientagreement_updated_at
BEFORE UPDATE ON "clientagreement"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "agent" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT,
  "client_id" TEXT,
  "industry" TEXT,
  "persona" JSONB,
  "greeting_message" TEXT,
  "system_prompt" TEXT,
  "knowledge_base_ids" JSONB,
  "kb_file_uri" TEXT,
  "kb_file_hash" TEXT,
  "kb_char_count" NUMERIC,
  "status" TEXT,
  "assigned_did" TEXT,
  "assigned_dids" JSONB,
  "smartflo_api_token" TEXT,
  "human_transfer_number" TEXT,
  "smartflo_agent_id" TEXT,
  "enable_auto_transfer" BOOLEAN
);


DROP TRIGGER IF EXISTS update_agent_updated_at ON "agent";
CREATE TRIGGER update_agent_updated_at
BEFORE UPDATE ON "agent"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "trustedclient" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT,
  "logo_url" TEXT,
  "order" NUMERIC,
  "is_active" BOOLEAN
);


DROP TRIGGER IF EXISTS update_trustedclient_updated_at ON "trustedclient";
CREATE TRIGGER update_trustedclient_updated_at
BEFORE UPDATE ON "trustedclient"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "user" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "role" TEXT,
  "client_id" TEXT,
  "display_name" TEXT,
  "email" TEXT UNIQUE,
  "password_hash" TEXT
);


DROP TRIGGER IF EXISTS update_user_updated_at ON "user";
CREATE TRIGGER update_user_updated_at
BEFORE UPDATE ON "user"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "campaign" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "name" TEXT,
  "type" TEXT,
  "agent_id" TEXT,
  "status" TEXT,
  "total_leads" NUMERIC,
  "calls_completed" NUMERIC,
  "calls_failed" NUMERIC,
  "max_concurrent_calls" NUMERIC,
  "call_script" JSONB,
  "scheduled_date" TEXT,
  "started_at" TEXT,
  "completed_at" TEXT,
  "followup_rules" JSONB,
  "whatsapp_auto_send" JSONB,
  "outcomes_summary" JSONB,
  "notes" TEXT
);


DROP TRIGGER IF EXISTS update_campaign_updated_at ON "campaign";
CREATE TRIGGER update_campaign_updated_at
BEFORE UPDATE ON "campaign"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "subscription" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "billing_cycle" TEXT,
  "channels" NUMERIC,
  "rate_per_channel" NUMERIC,
  "total_amount" NUMERIC,
  "billing_start_date" TEXT,
  "billing_end_date" TEXT,
  "next_billing_date" TEXT,
  "status" TEXT,
  "payment_status" TEXT,
  "payment_id" TEXT,
  "invoice_url" TEXT
);


DROP TRIGGER IF EXISTS update_subscription_updated_at ON "subscription";
CREATE TRIGGER update_subscription_updated_at
BEFORE UPDATE ON "subscription"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "client" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "company_name" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "registered_address" TEXT,
  "account_type" TEXT,
  "status" TEXT,
  "account_status" TEXT,
  "billing_type" TEXT,
  "per_minute_rate" NUMERIC,
  "wallet_balance" NUMERIC,
  "free_minutes_remaining" NUMERIC,
  "total_minutes_used" NUMERIC,
  "total_amount_spent" NUMERIC,
  "trial_start_date" TEXT,
  "trial_end_date" TEXT,
  "onboarding_completed" BOOLEAN,
  "subscription_plan" TEXT,
  "total_channels" NUMERIC,
  "monthly_rate_per_channel" NUMERIC,
  "next_billing_date" TEXT,
  "user_id" TEXT,
  "industry" TEXT,
  "has_custom_crm" BOOLEAN,
  "crm_subscription_status" TEXT,
  "crm_trial_start_date" TEXT,
  "crm_trial_end_date" TEXT,
  "crm_monthly_rate" NUMERIC,
  "crm_next_billing_date" TEXT,
  "industry_template_id" TEXT,
  "dlt_entity_id" TEXT,
  "dlt_registered" BOOLEAN,
  "dpdp_consent_given" BOOLEAN,
  "dpdp_consent_date" TEXT,
  "data_retention_days" NUMERIC,
  "kyc_status" TEXT,
  "kyc_deadline" TEXT,
  "company_type" TEXT,
  "owner_notification_channel" TEXT,
  "owner_whatsapp_number" TEXT,
  "dnd_enabled" BOOLEAN,
  "ai_response_mode" TEXT,
  "telegram_chat_id" TEXT,
  "telegram_connected" BOOLEAN,
  "telegram_username" TEXT,
  "api_auth_key" TEXT,
  "crm_api_access_status" TEXT,
  "crm_api_access_fee" NUMERIC,
  "crm_api_access_requested_at" TEXT,
  "crm_api_access_activated_at" TEXT,
  "crm_api_access_activated_by" TEXT,
  "crm_api_access_notes" TEXT,
  "social_media_access_status" TEXT,
  "social_media_access_fee" NUMERIC,
  "social_media_access_requested_at" TEXT,
  "social_media_access_activated_at" TEXT,
  "social_media_access_activated_by" TEXT,
  "social_media_access_notes" TEXT
);


DROP TRIGGER IF EXISTS update_client_updated_at ON "client";
CREATE TRIGGER update_client_updated_at
BEFORE UPDATE ON "client"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "brandsettings" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "brand_voice" TEXT,
  "tone" TEXT,
  "target_audience" TEXT,
  "logo_url" TEXT,
  "brand_colors" TEXT,
  "tagline" TEXT,
  "content_themes" JSONB,
  "avoid_topics" TEXT,
  "language_preference" TEXT,
  "posting_frequency" TEXT,
  "cta_style" TEXT,
  "competitor_brands" TEXT,
  "about_brand" TEXT,
  "products" JSONB,
  "services" JSONB,
  "usps" JSONB,
  "features" JSONB,
  "pricing_info" TEXT,
  "current_offers" JSONB,
  "addresses" JSONB,
  "contact_phone" TEXT,
  "contact_email" TEXT,
  "contact_whatsapp" TEXT,
  "website_url" TEXT,
  "social_instagram" TEXT,
  "social_facebook" TEXT,
  "social_linkedin" TEXT,
  "social_twitter" TEXT,
  "social_youtube" TEXT,
  "google_maps_link" TEXT,
  "enabled_occasions" JSONB,
  "custom_occasions" JSONB,
  "dashboard_logo_url" TEXT,
  "dashboard_app_name" TEXT,
  "dashboard_primary_color" TEXT,
  "dashboard_favicon_url" TEXT
);


DROP TRIGGER IF EXISTS update_brandsettings_updated_at ON "brandsettings";
CREATE TRIGGER update_brandsettings_updated_at
BEFORE UPDATE ON "brandsettings"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "clientlifecycleevent" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "client_name" TEXT,
  "event_type" TEXT,
  "from_value" TEXT,
  "to_value" TEXT,
  "amount" NUMERIC,
  "effective_date" TEXT,
  "expiry_date" TEXT,
  "billing_type" TEXT,
  "subscription_plan" TEXT,
  "channels" NUMERIC,
  "performed_by" TEXT,
  "source" TEXT,
  "notes" TEXT
);


DROP TRIGGER IF EXISTS update_clientlifecycleevent_updated_at ON "clientlifecycleevent";
CREATE TRIGGER update_clientlifecycleevent_updated_at
BEFORE UPDATE ON "clientlifecycleevent"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "industrytemplate" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT,
  "icon" TEXT,
  "description" TEXT,
  "default_lead_sources" JSONB,
  "default_deal_stages" JSONB,
  "default_activity_types" JSONB,
  "custom_fields" JSONB,
  "ai_system_prompt_template" TEXT,
  "status" TEXT
);


DROP TRIGGER IF EXISTS update_industrytemplate_updated_at ON "industrytemplate";
CREATE TRIGGER update_industrytemplate_updated_at
BEFORE UPDATE ON "industrytemplate"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "usagelog" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "call_log_id" TEXT,
  "type" TEXT,
  "direction" TEXT,
  "call_duration_seconds" NUMERIC,
  "billable_minutes" NUMERIC,
  "rate_per_minute" NUMERIC,
  "amount" NUMERIC,
  "balance_before" NUMERIC,
  "balance_after" NUMERIC,
  "free_minutes_before" NUMERIC,
  "free_minutes_after" NUMERIC,
  "description" TEXT,
  "payment_id" TEXT
);


DROP TRIGGER IF EXISTS update_usagelog_updated_at ON "usagelog";
CREATE TRIGGER update_usagelog_updated_at
BEFORE UPDATE ON "usagelog"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "leadgroup" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "name" TEXT,
  "description" TEXT,
  "color" TEXT
);


DROP TRIGGER IF EXISTS update_leadgroup_updated_at ON "leadgroup";
CREATE TRIGGER update_leadgroup_updated_at
BEFORE UPDATE ON "leadgroup"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "consentlog" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "consent_type" TEXT,
  "consent_given" BOOLEAN,
  "consent_text" TEXT,
  "consent_version" TEXT,
  "given_by_email" TEXT,
  "given_by_name" TEXT,
  "ip_address" TEXT,
  "revoked_date" TEXT
);


DROP TRIGGER IF EXISTS update_consentlog_updated_at ON "consentlog";
CREATE TRIGGER update_consentlog_updated_at
BEFORE UPDATE ON "consentlog"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "lead" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "name" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "status" TEXT,
  "company" TEXT,
  "notes" TEXT,
  "last_call_date" TEXT,
  "next_followup_date" TEXT,
  "crm_id" TEXT,
  "custom_fields" JSONB,
  "source" TEXT,
  "assigned_to" TEXT,
  "score" NUMERIC,
  "sentiment" TEXT,
  "intent_signals" JSONB,
  "score_breakdown" JSONB,
  "qualification_tier" TEXT,
  "qualification_reason" TEXT,
  "auto_actions_taken" JSONB,
  "tags" JSONB,
  "last_engagement_date" TEXT,
  "engagement_count" NUMERIC,
  "group_id" TEXT,
  "crm_pushed_at" TEXT,
  "crm_push_attempts" NUMERIC,
  "crm_push_last_error" TEXT,
  "crm_push_next_retry_at" TEXT
);


DROP TRIGGER IF EXISTS update_lead_updated_at ON "lead";
CREATE TRIGGER update_lead_updated_at
BEFORE UPDATE ON "lead"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "auditlog" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "action_type" TEXT,
  "entity_type" TEXT,
  "entity_id" TEXT,
  "actor_email" TEXT,
  "actor_role" TEXT,
  "details" TEXT,
  "metadata" JSONB,
  "ip_address" TEXT
);


DROP TRIGGER IF EXISTS update_auditlog_updated_at ON "auditlog";
CREATE TRIGGER update_auditlog_updated_at
BEFORE UPDATE ON "auditlog"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "payment" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "subscription_id" TEXT,
  "cashfree_order_id" TEXT,
  "cashfree_payment_id" TEXT,
  "amount" NUMERIC,
  "currency" TEXT,
  "status" TEXT,
  "payment_method" TEXT,
  "description" TEXT,
  "payment_session_id" TEXT,
  "paid_at" TEXT
);


DROP TRIGGER IF EXISTS update_payment_updated_at ON "payment";
CREATE TRIGGER update_payment_updated_at
BEFORE UPDATE ON "payment"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "retentionconfig" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "is_active" BOOLEAN,
  "retention_did" TEXT,
  "retention_agent_id" TEXT,
  "call_days_after_expiry" JSONB,
  "call_time_start" TEXT,
  "call_time_end" TEXT,
  "custom_instructions" TEXT,
  "active_offer" TEXT,
  "offer_code" TEXT,
  "offer_expiry" TEXT,
  "greeting_template" TEXT,
  "objection_handlers" JSONB,
  "excluded_client_ids" JSONB,
  "max_calls_per_client" NUMERIC,
  "enable_incoming_identification" BOOLEAN
);


DROP TRIGGER IF EXISTS update_retentionconfig_updated_at ON "retentionconfig";
CREATE TRIGGER update_retentionconfig_updated_at
BEFORE UPDATE ON "retentionconfig"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "crmintegration" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "crm_type" TEXT,
  "webhook_url" TEXT,
  "api_key" TEXT,
  "api_endpoint" TEXT,
  "sync_direction" TEXT,
  "field_mapping" JSONB,
  "status" TEXT,
  "last_sync" TEXT
);


DROP TRIGGER IF EXISTS update_crmintegration_updated_at ON "crmintegration";
CREATE TRIGGER update_crmintegration_updated_at
BEFORE UPDATE ON "crmintegration"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "marketplaceintegration" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "platform" TEXT,
  "store_url" TEXT,
  "api_access_token" TEXT,
  "api_version" TEXT,
  "status" TEXT,
  "last_tested" TEXT,
  "error_message" TEXT,
  "capabilities" JSONB
);


DROP TRIGGER IF EXISTS update_marketplaceintegration_updated_at ON "marketplaceintegration";
CREATE TRIGGER update_marketplaceintegration_updated_at
BEFORE UPDATE ON "marketplaceintegration"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "voicemailmessage" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "call_log_id" TEXT,
  "caller_number" TEXT,
  "caller_name" TEXT,
  "message" TEXT,
  "urgency" TEXT,
  "category" TEXT,
  "is_read" BOOLEAN
);


DROP TRIGGER IF EXISTS update_voicemailmessage_updated_at ON "voicemailmessage";
CREATE TRIGGER update_voicemailmessage_updated_at
BEFORE UPDATE ON "voicemailmessage"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "emailsequence" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT,
  "outreach_type" TEXT,
  "description" TEXT,
  "status" TEXT,
  "tier_target" TEXT,
  "auto_generated" BOOLEAN,
  "client_id" TEXT,
  "steps" JSONB,
  "total_enrolled" NUMERIC,
  "total_completed" NUMERIC,
  "total_opted_out" NUMERIC
);


DROP TRIGGER IF EXISTS update_emailsequence_updated_at ON "emailsequence";
CREATE TRIGGER update_emailsequence_updated_at
BEFORE UPDATE ON "emailsequence"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "whatsapptemplate" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "vendor" TEXT,
  "meta_template_id" TEXT,
  "name" TEXT,
  "language" TEXT,
  "category" TEXT,
  "status" TEXT,
  "rejected_reason" TEXT,
  "header_type" TEXT,
  "header_text" TEXT,
  "header_media_url" TEXT,
  "body_text" TEXT,
  "body_examples" JSONB,
  "footer_text" TEXT,
  "buttons" JSONB,
  "linked_actions" JSONB,
  "dlt_template_id" TEXT,
  "last_synced" TEXT,
  "send_count" NUMERIC
);


DROP TRIGGER IF EXISTS update_whatsapptemplate_updated_at ON "whatsapptemplate";
CREATE TRIGGER update_whatsapptemplate_updated_at
BEFORE UPDATE ON "whatsapptemplate"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "clientmessagingconfig" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "whatsapp_provider" TEXT,
  "whatsapp_api_key" TEXT,
  "whatsapp_api_endpoint" TEXT,
  "whatsapp_phone_number_id" TEXT,
  "whatsapp_business_id" TEXT,
  "whatsapp_status" TEXT,
  "whatsapp_last_tested" TEXT,
  "rcs_provider" TEXT,
  "rcs_api_key" TEXT,
  "rcs_api_endpoint" TEXT,
  "rcs_bot_id" TEXT,
  "rcs_pe_id" TEXT,
  "rcs_chain_value" TEXT,
  "rcs_sender_id" TEXT,
  "rcs_status" TEXT,
  "rcs_last_tested" TEXT,
  "email_provider" TEXT,
  "email_api_key" TEXT,
  "email_smtp_host" TEXT,
  "email_smtp_port" NUMERIC,
  "email_smtp_user" TEXT,
  "email_smtp_pass" TEXT,
  "email_from_address" TEXT,
  "email_from_name" TEXT,
  "email_domain" TEXT,
  "email_status" TEXT,
  "email_last_tested" TEXT
);


DROP TRIGGER IF EXISTS update_clientmessagingconfig_updated_at ON "clientmessagingconfig";
CREATE TRIGGER update_clientmessagingconfig_updated_at
BEFORE UPDATE ON "clientmessagingconfig"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "deal" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "title" TEXT,
  "lead_id" TEXT,
  "contact_id" TEXT,
  "value" NUMERIC,
  "currency" TEXT,
  "stage" TEXT,
  "probability" NUMERIC,
  "expected_close_date" TEXT,
  "actual_close_date" TEXT,
  "source" TEXT,
  "assigned_to" TEXT,
  "status" TEXT,
  "lost_reason" TEXT,
  "notes" TEXT,
  "custom_fields" JSONB,
  "last_activity_date" TEXT,
  "proposal_uploaded" BOOLEAN,
  "proposal_url" TEXT
);


DROP TRIGGER IF EXISTS update_deal_updated_at ON "deal";
CREATE TRIGGER update_deal_updated_at
BEFORE UPDATE ON "deal"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "activity" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "lead_id" TEXT,
  "deal_id" TEXT,
  "contact_id" TEXT,
  "call_log_id" TEXT,
  "type" TEXT,
  "title" TEXT,
  "description" TEXT,
  "scheduled_date" TEXT,
  "due_date" TEXT,
  "completed_date" TEXT,
  "status" TEXT,
  "priority" TEXT,
  "assigned_to" TEXT,
  "notes" TEXT,
  "outcome" TEXT,
  "reminder_sent" BOOLEAN,
  "crm_synced" BOOLEAN,
  "auto_created" BOOLEAN
);


DROP TRIGGER IF EXISTS update_activity_updated_at ON "activity";
CREATE TRIGGER update_activity_updated_at
BEFORE UPDATE ON "activity"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "paymentapprovalrequest" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "request_type" TEXT,
  "client_id" TEXT,
  "client_name" TEXT,
  "client_email" TEXT,
  "amount" NUMERIC,
  "transaction_number" TEXT,
  "payment_method" TEXT,
  "payment_date" TEXT,
  "screenshot_url" TEXT,
  "requested_by" TEXT,
  "request_notes" TEXT,
  "request_metadata" JSONB,
  "status" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TEXT,
  "review_notes" TEXT,
  "applied" BOOLEAN,
  "apply_error" TEXT
);


DROP TRIGGER IF EXISTS update_paymentapprovalrequest_updated_at ON "paymentapprovalrequest";
CREATE TRIGGER update_paymentapprovalrequest_updated_at
BEFORE UPDATE ON "paymentapprovalrequest"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "calllog" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "agent_id" TEXT,
  "lead_id" TEXT,
  "call_sid" TEXT,
  "stream_sid" TEXT,
  "caller_id" TEXT,
  "callee_number" TEXT,
  "direction" TEXT,
  "duration" NUMERIC,
  "status" TEXT,
  "recording_url" TEXT,
  "transcript" TEXT,
  "conversation_summary" TEXT,
  "lead_status_updated" TEXT,
  "transferred_to" TEXT,
  "call_start_time" TEXT,
  "call_end_time" TEXT,
  "agent_config_cache" JSONB,
  "crm_pushed_at" TEXT,
  "crm_push_attempts" NUMERIC,
  "crm_push_last_error" TEXT,
  "crm_push_next_retry_at" TEXT
);


DROP TRIGGER IF EXISTS update_calllog_updated_at ON "calllog";
CREATE TRIGGER update_calllog_updated_at
BEFORE UPDATE ON "calllog"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "ownerstatus" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "title" TEXT,
  "description" TEXT,
  "caller_message_hindi" TEXT,
  "is_active" BOOLEAN,
  "start_time" TEXT,
  "end_time" TEXT,
  "is_preset" BOOLEAN,
  "icon" TEXT
);


DROP TRIGGER IF EXISTS update_ownerstatus_updated_at ON "ownerstatus";
CREATE TRIGGER update_ownerstatus_updated_at
BEFORE UPDATE ON "ownerstatus"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "sequenceenrollment" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "sequence_id" TEXT,
  "client_id" TEXT,
  "lead_id" TEXT,
  "recipient_email" TEXT,
  "recipient_name" TEXT,
  "status" TEXT,
  "current_step" NUMERIC,
  "steps_completed" NUMERIC,
  "total_steps" NUMERIC,
  "next_send_date" TEXT,
  "last_sent_date" TEXT,
  "enrolled_date" TEXT,
  "opt_out_date" TEXT,
  "qualification_tier" TEXT,
  "call_outcome" TEXT,
  "call_summary" TEXT,
  "call_topics" JSONB,
  "objections" JSONB,
  "intent_signals" JSONB,
  "send_log" JSONB
);


DROP TRIGGER IF EXISTS update_sequenceenrollment_updated_at ON "sequenceenrollment";
CREATE TRIGGER update_sequenceenrollment_updated_at
BEFORE UPDATE ON "sequenceenrollment"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "socialmediapost" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "title" TEXT,
  "caption" TEXT,
  "hashtags" TEXT,
  "poster_url" TEXT,
  "platform" TEXT,
  "content_type" TEXT,
  "status" TEXT,
  "scheduled_date" TEXT,
  "rejection_reason" TEXT,
  "shared_on" JSONB,
  "ai_prompt_used" TEXT
);


DROP TRIGGER IF EXISTS update_socialmediapost_updated_at ON "socialmediapost";
CREATE TRIGGER update_socialmediapost_updated_at
BEFORE UPDATE ON "socialmediapost"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "contact" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "first_name" TEXT,
  "last_name" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "company" TEXT,
  "job_title" TEXT,
  "lead_id" TEXT,
  "notes" TEXT,
  "custom_fields" JSONB
);


DROP TRIGGER IF EXISTS update_contact_updated_at ON "contact";
CREATE TRIGGER update_contact_updated_at
BEFORE UPDATE ON "contact"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS "outreachlog" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "client_id" TEXT,
  "lead_id" TEXT,
  "call_log_id" TEXT,
  "channel" TEXT,
  "direction" TEXT,
  "vendor" TEXT,
  "vendor_message_id" TEXT,
  "template_id" TEXT,
  "template_name" TEXT,
  "recipient_email" TEXT,
  "recipient_phone" TEXT,
  "subject" TEXT,
  "body" TEXT,
  "outreach_type" TEXT,
  "call_outcome" TEXT,
  "ai_summary" TEXT,
  "status" TEXT,
  "error_message" TEXT,
  "is_retention" BOOLEAN
);


DROP TRIGGER IF EXISTS update_outreachlog_updated_at ON "outreachlog";
CREATE TRIGGER update_outreachlog_updated_at
BEFORE UPDATE ON "outreachlog"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
