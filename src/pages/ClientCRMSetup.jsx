import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, ArrowRight, Check, Loader2, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import IndustrySelector from '../components/crm/IndustrySelector';

const STEPS = ['Select Industry', 'Review Configuration', 'Launch CRM'];

export default function ClientCRMSetup() {
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length > 0) setClient(clients[0]);

    const allTemplates = await base44.entities.IndustryTemplate.filter({ status: 'active' });
    setTemplates(allTemplates);
    setLoading(false);
  };

  const handleProvision = async () => {
    if (!client || !selectedTemplate) return;
    setProvisioning(true);

    // Prevent duplicate CRM provisioning
    const existingConfigs = await base44.entities.CRMConfig.filter({ client_id: client.id });
    if (existingConfigs.length > 0) {
      toast.error('CRM is already set up for your account.');
      setProvisioning(false);
      setStep(2);
      return;
    }

    const now = new Date();
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Create CRM config
    await base44.entities.CRMConfig.create({
      client_id: client.id,
      industry_template_id: selectedTemplate.id,
      industry_name: selectedTemplate.name,
      deal_stages: selectedTemplate.default_deal_stages || [],
      lead_sources: selectedTemplate.default_lead_sources || [],
      activity_types: selectedTemplate.default_activity_types || [],
      custom_fields: selectedTemplate.custom_fields || [],
      automation_rules: [
        { name: 'Auto Follow-up (48h no response)', trigger_type: 'time_based', trigger_value: '48h_no_response', action_type: 'create_activity', action_value: 'followup', enabled: true },
        { name: 'Move to Proposal Sent on upload', trigger_type: 'deal_field_change', trigger_value: 'proposal_uploaded', action_type: 'change_stage', action_value: 'Proposal', enabled: true },
        { name: 'Auto-score leads on engagement', trigger_type: 'lead_status_change', trigger_value: 'any', action_type: 'update_score', action_value: 'auto', enabled: true }
      ]
    });

    // Update client
    await base44.entities.Client.update(client.id, {
      has_custom_crm: true,
      crm_subscription_status: 'trialing',
      crm_trial_start_date: now.toISOString(),
      crm_trial_end_date: trialEnd.toISOString(),
      industry_template_id: selectedTemplate.id
    });

    setProvisioning(false);
    setStep(2);
    toast.success('Your CRM is ready!');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Progress */}
      <div className="flex items-center justify-center gap-2">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium ${
              i <= step ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-400'
            }`}>
              {i < step ? <Check className="w-4 h-4" /> : <span>{i + 1}</span>}
              <span className="hidden sm:inline">{s}</span>
            </div>
            {i < STEPS.length - 1 && <div className={`w-12 h-0.5 ${i < step ? 'bg-indigo-400' : 'bg-gray-200'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 0: Industry Selection */}
      {step === 0 && (
        <div className="space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-gray-900">What's your industry?</h1>
            <p className="text-gray-500 mt-2">Choose your industry and we'll set up a custom CRM tailored for you</p>
          </div>
          <IndustrySelector
            templates={templates}
            selectedId={selectedTemplate?.id}
            onSelect={setSelectedTemplate}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => setStep(1)}
              disabled={!selectedTemplate}
              className="bg-indigo-600 hover:bg-indigo-700"
              size="lg"
            >
              Next <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 1: Review */}
      {step === 1 && selectedTemplate && (
        <div className="space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-gray-900">Review Your CRM Setup</h1>
            <p className="text-gray-500 mt-2">Here's what we'll configure for <strong>{selectedTemplate.name}</strong></p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-lg">Sales Pipeline Stages</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {(selectedTemplate.default_deal_stages || []).map((stage, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
                    <span className="text-sm">{stage.name}</span>
                    {i < (selectedTemplate.default_deal_stages?.length || 0) - 1 && (
                      <ArrowRight className="w-3 h-3 text-gray-300" />
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-lg">Lead Sources</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {(selectedTemplate.default_lead_sources || []).map((src, i) => (
                  <Badge key={i} variant="secondary">{src}</Badge>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-lg">Custom Fields</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {(selectedTemplate.custom_fields || []).map((f, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span>{f.field_name}</span>
                    <Badge variant="outline" className="text-xs">{f.entity}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-lg">Automations Included</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {['Auto follow-up for no response (48h)', 'Pipeline auto-progression on events', 'Lead scoring on engagement'].map((a, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-green-500" />
                    <span>{a}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(0)}>
              <ArrowLeft className="w-4 h-4 mr-2" /> Back
            </Button>
            <Button
              onClick={handleProvision}
              disabled={provisioning}
              className="bg-indigo-600 hover:bg-indigo-700"
              size="lg"
            >
              {provisioning ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Setting up...</>
              ) : (
                <><Rocket className="w-4 h-4 mr-2" /> Create My CRM</>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Success */}
      {step === 2 && (
        <div className="text-center space-y-6 py-12">
          <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto">
            <Check className="w-10 h-10 text-green-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Your CRM is Ready! 🎉</h1>
          <p className="text-gray-500 max-w-md mx-auto">
            Your {selectedTemplate?.name} CRM has been configured with a <strong>7-day free trial</strong>.
            Start adding leads and deals now!
          </p>
          <div className="flex gap-4 justify-center">
            <Link to={createPageUrl('ClientCRMDashboard')}>
              <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700">
                Go to CRM Dashboard <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}