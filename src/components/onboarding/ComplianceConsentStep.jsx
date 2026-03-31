import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Shield, ArrowRight, ArrowLeft, Scale, Database, Phone, Eye } from 'lucide-react';
import { motion } from 'framer-motion';

const CONSENTS = [
  {
    id: 'platform_tos',
    label: 'Terms of Service & Platform Usage',
    description: 'I agree to Getway AI\'s Terms of Service and acceptable use policy for AI voice calling.',
    icon: Scale,
    required: true,
  },
  {
    id: 'dpdp_processing',
    label: 'Data Processing (DPDP Act 2023)',
    description: 'I consent to Getway AI processing voice recordings, transcripts, and lead data as a Data Processor under the DPDP Act. All data is stored on Indian servers.',
    icon: Database,
    required: true,
  },
  {
    id: 'ai_voice_usage',
    label: 'AI Voice Disclosure (TRAI Compliance)',
    description: 'I acknowledge that all AI-generated calls must disclose their AI nature within the first 15 seconds, as mandated by TRAI. I will ensure my agent prompts include this disclosure.',
    icon: Phone,
    required: true,
  },
  {
    id: 'data_retention',
    label: 'Data Retention Policy',
    description: 'I understand that call recordings and transcripts are automatically purged after 30 days unless a legal mandate requires longer retention. I can request data erasure at any time.',
    icon: Eye,
    required: true,
  },
];

export default function ComplianceConsentStep({ onNext, onBack, consents, onConsentsChange }) {
  const allRequired = CONSENTS.filter(c => c.required).every(c => consents[c.id]);

  const toggleConsent = (id) => {
    onConsentsChange({ ...consents, [id]: !consents[id] });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="text-center mb-8">
        <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Shield className="w-8 h-8 text-blue-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Regulatory Compliance</h2>
        <p className="text-gray-500 mt-2 max-w-md mx-auto">
          As per DPDP Act 2023, TRAI regulations, and IT Act guidelines, please review and accept the following before proceeding.
        </p>
      </div>

      <div className="space-y-3">
        {CONSENTS.map((consent) => {
          const Icon = consent.icon;
          return (
            <Card
              key={consent.id}
              className={`cursor-pointer transition-all border-2 ${
                consents[consent.id] ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 hover:border-gray-300'
              }`}
              onClick={() => toggleConsent(consent.id)}
            >
              <CardContent className="p-4 flex items-start gap-4">
                <div className="mt-0.5">
                  <Checkbox checked={consents[consent.id] || false} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className="w-4 h-4 text-blue-600" />
                    <p className="font-medium text-gray-900 text-sm">{consent.label}</p>
                    {consent.required && <span className="text-xs text-red-500">*Required</span>}
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">{consent.description}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* DPO Info */}
      <div className="bg-gray-50 rounded-xl p-4 text-sm">
        <p className="font-medium text-gray-700 mb-2">Data Protection Officer (DPO)</p>
        <div className="text-gray-500 space-y-1">
          <p>Satish Saini</p>
          <p>Email: connect@getway.in | Phone: +91-9255522544</p>
          <p className="text-xs mt-2">For data access, correction, or erasure requests, contact the DPO.</p>
        </div>
      </div>

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack} className="h-11">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        <Button
          onClick={onNext}
          disabled={!allRequired}
          className="bg-blue-600 hover:bg-blue-700 h-11"
        >
          I Accept & Continue <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </motion.div>
  );
}