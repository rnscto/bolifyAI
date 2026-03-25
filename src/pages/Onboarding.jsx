import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import ProfileStep from '../components/onboarding/ProfileStep';
import PersonalProfileStep from '../components/onboarding/PersonalProfileStep';
import AccountTypeStep from '../components/onboarding/AccountTypeStep';
import IndustryStep from '../components/onboarding/IndustryStep';
import AgentSetupStep from '../components/onboarding/AgentSetupStep';
import DIDSelectionStep from '../components/onboarding/DIDSelectionStep';
import ComplianceConsentStep from '../components/onboarding/ComplianceConsentStep';
import AgreementSignStep from '../components/onboarding/AgreementSignStep';
import OnboardingComplete from '../components/onboarding/OnboardingComplete';

const BUSINESS_STEPS = ['Account Type', 'Profile', 'Industry', 'Agent', 'Phone Number', 'Compliance', 'Agreement', 'Complete'];
const PERSONAL_STEPS = ['Account Type', 'Profile', 'Agent', 'Phone Number', 'Compliance', 'Agreement', 'Complete'];

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [accountType, setAccountType] = useState('');
  const [profileData, setProfileData] = useState({
    company_name: '',
    email: '',
    phone: '',
    owner_whatsapp_number: '',
  });
  const [industry, setIndustry] = useState('');
  const [agentData, setAgentData] = useState({
    name: '',
    tone: 'professional',
    language: 'en-IN',
    system_prompt: '',
  });
  const [selectedDID, setSelectedDID] = useState(null);
  const [referralCode, setReferralCode] = useState('');
  const [existingClient, setExistingClient] = useState(null);
  const [complianceConsents, setComplianceConsents] = useState({});
  const [agreementData, setAgreementData] = useState(null);

  useEffect(() => {
    // Capture referral code and account type from URL
    const urlParams = new URLSearchParams(window.location.search);
    const ref = urlParams.get('ref') || '';
    if (ref) setReferralCode(ref);
    const type = urlParams.get('type') || '';
    if (type === 'personal') {
      setAccountType('personal');
      setStep(1); // Skip account type chooser
    }
    loadUser();
  }, []);

  const loadUser = async () => {
    const currentUser = await base44.auth.me();
    setUser(currentUser);
    setProfileData(prev => ({
      ...prev,
      email: currentUser.email,
    }));

    // Check if already has a client account
    const clients = await base44.entities.Client.filter({ user_id: currentUser.id });
    if (clients.length > 0) {
      if (clients[0].onboarding_completed) {
        navigate(createPageUrl('ClientDashboard'));
        return;
      }
      // Has incomplete client record — resume onboarding with existing data
      setExistingClient(clients[0]);
      setProfileData({
        company_name: clients[0].company_name || '',
        email: clients[0].email || currentUser.email,
        phone: clients[0].phone || '',
      });
      if (clients[0].industry) setIndustry(clients[0].industry);
    }
    setLoading(false);
  };

  const handleComplete = async (agrDataParam) => {
    const agrData = agrDataParam || agreementData;
    setSaving(true);
    
    const isPersonal = accountType === 'personal';
    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + 7);

    // 1. Create or update Client record
    let client;
    const kycDeadline = new Date(now);
    kycDeadline.setDate(kycDeadline.getDate() + 30);
    const kycDeadlineStr = kycDeadline.toISOString().split('T')[0];

    const clientPayload = {
      company_name: isPersonal ? (user?.full_name || profileData.company_name) : profileData.company_name,
      email: profileData.email,
      phone: profileData.phone,
      registered_address: profileData.registered_address || '',
      company_type: isPersonal ? 'individual' : (profileData.company_type || ''),
      account_type: accountType || 'business',
      industry: isPersonal ? 'Personal Assistant' : industry,
      status: 'active',
      account_status: 'trial',
      trial_start_date: now.toISOString(),
      trial_end_date: trialEnd.toISOString(),
      onboarding_completed: true,
      total_channels: 1,
      kyc_status: isPersonal ? 'not_required' : 'pending',
      kyc_deadline: isPersonal ? undefined : kycDeadlineStr,
      owner_whatsapp_number: profileData.owner_whatsapp_number || '',
      owner_notification_channel: 'whatsapp',
    };

    if (existingClient) {
      await base44.entities.Client.update(existingClient.id, {
        ...clientPayload,
        account_status: existingClient.account_status || 'trial',
        trial_start_date: existingClient.trial_start_date || now.toISOString(),
        trial_end_date: existingClient.trial_end_date || trialEnd.toISOString(),
        kyc_status: existingClient.kyc_status || clientPayload.kyc_status,
        kyc_deadline: existingClient.kyc_deadline || kycDeadlineStr,
      });
      client = { ...existingClient, id: existingClient.id };
    } else {
      clientPayload.user_id = user.id;
      client = await base44.entities.Client.create(clientPayload);
    }

    // 2. Create Agent
    const agentPayload = {
      name: agentData.name,
      client_id: client.id,
      industry: isPersonal ? 'Personal Assistant' : industry,
      persona: {
        voice_type: 'Surbhi-English-India',
        tone: agentData.tone,
        language: agentData.language,
      },
      system_prompt: isPersonal 
        ? (agentData.system_prompt || `You are a personal AI call screening assistant for ${user?.full_name || 'the owner'}.

YOUR PRIMARY JOB:
1. Answer incoming calls warmly and professionally
2. Identify who is calling and their purpose
3. Screen calls — classify each as: family, business, promotional, spam, or unknown
4. Take detailed messages for legitimate callers
5. Politely but firmly end spam/telemarketing calls
6. Never reveal the owner's personal details, schedule, or location

CONVERSATION STYLE:
- Be warm, natural, and conversational — like a friendly human assistant
- Keep responses short (1-2 sentences) since this is a phone call
- For Hindi speakers, respond in Hindi. For English speakers, respond in English.
- Always ask: "May I know who is calling?" and "How can I help you?"

FOR LEGITIMATE CALLERS:
- Get their name, reason for calling, and any message
- Say: "I will make sure [owner name] gets your message"
- If urgent, mention you will notify the owner right away

FOR SPAM/TELEMARKETING:
- Say: "Thank you, but we are not interested. Please remove this number from your list."
- End the call politely but firmly`)
        : agentData.system_prompt,
      status: 'active',
    };

    // 3. Assign DID if selected
    if (selectedDID) {
      agentPayload.assigned_did = selectedDID.number;
      agentPayload.assigned_dids = [selectedDID.number];
      // Demo pool DIDs stay as reserved/shared — don't change ownership
      if (!selectedDID.is_demo) {
        await base44.entities.DID.update(selectedDID.id, {
          status: 'assigned',
          client_id: client.id,
        });
      }
    }

    await base44.entities.Agent.create(agentPayload);

    // Track referral if referral code was used
    if (referralCode) {
      try {
        const partners = await base44.entities.Partner.filter({ referral_code: referralCode });
        if (partners.length > 0) {
          const partner = partners[0];
          await base44.entities.Referral.create({
            partner_id: partner.id,
            client_id: client.id,
            client_name: profileData.company_name,
            client_email: profileData.email,
            client_phone: profileData.phone,
            referral_code_used: referralCode,
            status: 'trial',
            commission_rate: partner.commission_rate || 20,
            signup_date: new Date().toISOString(),
          });
          await base44.entities.Partner.update(partner.id, {
            total_referrals: (partner.total_referrals || 0) + 1,
            active_referrals: (partner.active_referrals || 0) + 1,
          });
        }
      } catch (e) { console.log('Referral tracking error:', e.message); }
    }

    // Log DPDP consent
    const consentTypes = ['platform_tos', 'dpdp_processing', 'ai_voice_usage', 'data_retention'];
    for (const ct of consentTypes) {
      if (complianceConsents[ct]) {
        await base44.entities.ConsentLog.create({
          client_id: client.id,
          consent_type: ct,
          consent_given: true,
          consent_version: '2.1',
          given_by_email: user.email,
          given_by_name: user.full_name,
        });
      }
    }
    // Update client with DPDP consent flag
    await base44.entities.Client.update(client.id, {
      dpdp_consent_given: true,
      dpdp_consent_date: new Date().toISOString(),
    });
    // Audit log
    await base44.entities.AuditLog.create({
      client_id: client.id,
      action_type: 'consent_given',
      actor_email: user.email,
      details: `Onboarding compliance consent given: ${consentTypes.filter(c => complianceConsents[c]).join(', ')}`,
    });

    // Save client agreement if signed
    if (agrData) {
      try {
        await base44.entities.ClientAgreement.create({
          client_id: client.id,
          template_id: agrData.template_id,
          template_version: agrData.template_version,
          agreement_number: agrData.agreement_number,
          status: 'signed',
          client_name: profileData.company_name,
          signatory_name: agrData.signature_name,
          signatory_email: user.email,
          signatory_designation: 'Authorized Signatory',
          signature_name: agrData.signature_name,
          signature_image_url: agrData.signature_image_url,
          signed_date: agrData.signed_date,
          effective_date: agrData.effective_date,
          expiry_date: agrData.expiry_date,
          rendered_html: agrData.rendered_html,
          company_signatory_name: agrData.company_signatory_name,
          company_signatory_designation: agrData.company_signatory_designation,
        });
        // Notify admin
        try {
          await base44.functions.invoke('sendAgreementEmail', {
            type: 'client_admin_notify',
            data: { company_name: profileData.company_name, email: user.email, agreement_number: agrData.agreement_number }
          });
        } catch (e) { console.log('Admin email failed:', e); }
      } catch (e) { console.error('Agreement save failed:', e); }
    }

    toast.success('Account created successfully!');
    setSaving(false);
    setStep(isPersonal ? 6 : 7); // Show completion screen
  };

  const isPersonal = accountType === 'personal';
  const currentSteps = isPersonal ? PERSONAL_STEPS : BUSINESS_STEPS;
  const totalSteps = currentSteps.length - 1; // exclude "Complete" from count

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-white">
        <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-orange-50">
      {/* Progress header */}
      {step < totalSteps && (
        <div className="sticky top-0 bg-white/80 backdrop-blur-lg border-b z-10">
          <div className="max-w-3xl mx-auto px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <img
                src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png"
                alt="VaaniAI"
                className="h-10 object-contain"
              />
              <span className="text-sm text-gray-500">Step {step + 1} of {totalSteps}</span>
            </div>
            <div className="flex gap-2">
              {currentSteps.slice(0, totalSteps).map((s, i) => (
                <div
                  key={s}
                  className={`flex-1 h-1.5 rounded-full transition-all ${
                    i <= step ? (isPersonal ? 'bg-purple-600' : 'bg-blue-600') : 'bg-gray-200'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="max-w-3xl mx-auto px-4 py-12">
        {saving && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center">
            <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-4" />
            <p className="text-lg font-medium text-gray-900">Setting up your {isPersonal ? 'AI assistant' : 'account'}...</p>
            <p className="text-sm text-gray-500 mt-1">This will just take a moment</p>
          </div>
        )}

        {/* Step 0: Choose Account Type */}
        {step === 0 && (
          <AccountTypeStep
            selected={accountType}
            onSelect={setAccountType}
            onNext={() => setStep(1)}
          />
        )}

        {/* Step 1: Profile (different for personal vs business) */}
        {step === 1 && (
          isPersonal ? (
            <PersonalProfileStep
              data={profileData}
              onChange={setProfileData}
              onNext={() => setStep(2)}
              onBack={() => setStep(0)}
              user={user}
            />
          ) : (
            <ProfileStep
              data={profileData}
              onChange={setProfileData}
              onNext={() => setStep(2)}
              onBack={() => setStep(0)}
              user={user}
            />
          )
        )}

        {/* Step 2: Industry (business) or Agent Setup (personal) */}
        {step === 2 && (
          isPersonal ? (
            <AgentSetupStep
              data={agentData}
              onChange={setAgentData}
              onNext={() => setStep(3)}
              onBack={() => setStep(1)}
              industry="Personal Assistant"
            />
          ) : (
            <IndustryStep
              selected={industry}
              onSelect={setIndustry}
              onNext={() => setStep(3)}
              onBack={() => setStep(1)}
            />
          )
        )}

        {/* Step 3: Agent Setup (business) or DID Selection (personal) */}
        {step === 3 && (
          isPersonal ? (
            <DIDSelectionStep
              selected={selectedDID}
              onSelect={setSelectedDID}
              onNext={() => setStep(4)}
              onBack={() => setStep(2)}
            />
          ) : (
            <AgentSetupStep
              data={agentData}
              onChange={setAgentData}
              onNext={() => setStep(4)}
              onBack={() => setStep(2)}
              industry={industry}
            />
          )
        )}

        {/* Step 4: DID Selection (business) or Compliance (personal) */}
        {step === 4 && (
          isPersonal ? (
            <ComplianceConsentStep
              consents={complianceConsents}
              onConsentsChange={setComplianceConsents}
              onNext={() => setStep(5)}
              onBack={() => setStep(3)}
            />
          ) : (
            <DIDSelectionStep
              selected={selectedDID}
              onSelect={setSelectedDID}
              onNext={() => setStep(5)}
              onBack={() => setStep(3)}
            />
          )
        )}

        {/* Step 5: Compliance (business) or Agreement (personal) */}
        {step === 5 && (
          isPersonal ? (
            <AgreementSignStep
              onNext={(agrData) => { setAgreementData(agrData); handleComplete(agrData); }}
              onBack={() => setStep(4)}
              profileData={{ ...profileData, company_name: user?.full_name || profileData.company_name }}
              user={user}
            />
          ) : (
            <ComplianceConsentStep
              consents={complianceConsents}
              onConsentsChange={setComplianceConsents}
              onNext={() => setStep(6)}
              onBack={() => setStep(4)}
            />
          )
        )}

        {/* Step 6: Agreement (business) or Complete (personal) */}
        {step === 6 && (
          isPersonal ? (
            <OnboardingComplete
              agentName={agentData.name}
              didNumber={selectedDID ? `${selectedDID.country_code || '+91'} ${selectedDID.number}` : null}
              isPersonal={true}
            />
          ) : (
            <AgreementSignStep
              onNext={(agrData) => { setAgreementData(agrData); handleComplete(agrData); }}
              onBack={() => setStep(5)}
              profileData={profileData}
              user={user}
            />
          )
        )}

        {/* Step 7: Complete (business only) */}
        {step === 7 && !isPersonal && (
          <OnboardingComplete
            agentName={agentData.name}
            didNumber={selectedDID ? `${selectedDID.country_code || '+91'} ${selectedDID.number}` : null}
          />
        )}
      </div>
    </div>
  );
}