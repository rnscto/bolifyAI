import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import ProfileStep from '../components/onboarding/ProfileStep';
import IndustryStep from '../components/onboarding/IndustryStep';
import AgentSetupStep from '../components/onboarding/AgentSetupStep';
import DIDSelectionStep from '../components/onboarding/DIDSelectionStep';
import OnboardingComplete from '../components/onboarding/OnboardingComplete';

const STEPS = ['Profile', 'Industry', 'Agent', 'Phone Number', 'Complete'];

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [profileData, setProfileData] = useState({
    company_name: '',
    email: '',
    phone: '',
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

  useEffect(() => {
    // Capture referral code from URL
    const urlParams = new URLSearchParams(window.location.search);
    const ref = urlParams.get('ref') || '';
    if (ref) setReferralCode(ref);
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

  const handleComplete = async () => {
    setSaving(true);
    
    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + 7);

    // 1. Create or update Client record
    let client;
    if (existingClient) {
      await base44.entities.Client.update(existingClient.id, {
        company_name: profileData.company_name,
        email: profileData.email,
        phone: profileData.phone,
        industry: industry,
        status: 'active',
        account_status: existingClient.account_status || 'trial',
        trial_start_date: existingClient.trial_start_date || now.toISOString(),
        trial_end_date: existingClient.trial_end_date || trialEnd.toISOString(),
        onboarding_completed: true,
      });
      client = { ...existingClient, id: existingClient.id };
    } else {
      client = await base44.entities.Client.create({
        company_name: profileData.company_name,
        email: profileData.email,
        phone: profileData.phone,
        user_id: user.id,
        industry: industry,
        status: 'active',
        account_status: 'trial',
        trial_start_date: now.toISOString(),
        trial_end_date: trialEnd.toISOString(),
        onboarding_completed: true,
        total_channels: 1,
      });
    }

    // 2. Create Agent
    const agentPayload = {
      name: agentData.name,
      client_id: client.id,
      industry: industry,
      persona: {
        voice_type: 'Surbhi-English-India',
        tone: agentData.tone,
        language: agentData.language,
      },
      system_prompt: agentData.system_prompt,
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

    toast.success('Account created successfully!');
    setSaving(false);
    setStep(4); // Show completion screen
  };

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
      {step < 4 && (
        <div className="sticky top-0 bg-white/80 backdrop-blur-lg border-b z-10">
          <div className="max-w-3xl mx-auto px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <img
                src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png"
                alt="VaaniAI"
                className="h-10 object-contain"
              />
              <span className="text-sm text-gray-500">Step {step + 1} of 4</span>
            </div>
            <div className="flex gap-2">
              {STEPS.slice(0, 4).map((s, i) => (
                <div
                  key={s}
                  className={`flex-1 h-1.5 rounded-full transition-all ${
                    i <= step ? 'bg-blue-600' : 'bg-gray-200'
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
            <p className="text-lg font-medium text-gray-900">Setting up your account...</p>
            <p className="text-sm text-gray-500 mt-1">This will just take a moment</p>
          </div>
        )}

        {step === 0 && (
          <ProfileStep
            data={profileData}
            onChange={setProfileData}
            onNext={() => setStep(1)}
            user={user}
          />
        )}

        {step === 1 && (
          <IndustryStep
            selected={industry}
            onSelect={setIndustry}
            onNext={() => setStep(2)}
            onBack={() => setStep(0)}
          />
        )}

        {step === 2 && (
          <AgentSetupStep
            data={agentData}
            onChange={setAgentData}
            onNext={() => setStep(3)}
            onBack={() => setStep(1)}
            industry={industry}
          />
        )}

        {step === 3 && (
          <DIDSelectionStep
            selected={selectedDID}
            onSelect={setSelectedDID}
            onNext={handleComplete}
            onBack={() => setStep(2)}
          />
        )}

        {step === 4 && (
          <OnboardingComplete
            agentName={agentData.name}
            didNumber={selectedDID ? `${selectedDID.country_code || '+91'} ${selectedDID.number}` : null}
          />
        )}
      </div>
    </div>
  );
}