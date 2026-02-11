import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Check, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { base44 } from '@/api/base44Client';
import { motion } from 'framer-motion';
import { createPageUrl } from '../../utils';

const plans = [
  {
    name: 'Voice AI Agent',
    price: '₹6,500',
    period: '/channel/month',
    billing: 'Billed quarterly',
    description: 'AI-powered outbound calling with smart agents',
    features: [
      'AI Voice Agent (English + Hindi)',
      'Dedicated DID Number',
      'Unlimited outbound calls',
      'Real-time call transcripts',
      'AI conversation analysis',
      'Lead status auto-update',
      'Knowledge base upload',
      'Call logs & analytics',
    ],
    cta: 'Get Started',
    popular: false,
  },
  {
    name: 'Custom Sales CRM',
    price: '₹1,999',
    period: '/month',
    billing: '7-day free trial',
    description: 'Industry-specific CRM with full automation',
    features: [
      'Everything in Voice AI Agent',
      'Industry-tailored CRM',
      'Deal pipeline (Kanban + Table)',
      'Contact & company management',
      'Sales reports & forecasting',
      'Auto lead scoring',
      'Pipeline automation rules',
      '48h follow-up auto-detection',
      'Proposal tracking',
      'Custom fields per industry',
    ],
    cta: 'Start Free Trial',
    popular: true,
  }
];

export default function PricingSection() {
  return (
    <section id="pricing" className="py-24 bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#e67e22]/10 text-[#e67e22] text-sm font-semibold mb-4">
            Pricing
          </div>
          <h2 className="text-4xl font-bold text-gray-900 mb-4">Simple, Transparent Pricing</h2>
          <p className="text-lg text-gray-500">No hidden fees. Scale as you grow.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className={`relative h-full transition-shadow ${
                plan.popular
                  ? 'border-[#e67e22] shadow-lg shadow-orange-100'
                  : 'border-gray-200 hover:shadow-md'
              }`}>
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-gradient-to-r from-[#e67e22] to-[#f39c12] text-white px-4 py-1 border-0">Most Popular</Badge>
                  </div>
                )}
                <CardHeader className="text-center pt-8">
                  <CardTitle className="text-xl font-semibold text-gray-900">{plan.name}</CardTitle>
                  <p className="text-sm text-gray-500 mt-1">{plan.description}</p>
                  <div className="mt-4">
                    <span className="text-4xl font-bold text-[#1a365d]">{plan.price}</span>
                    <span className="text-gray-500">{plan.period}</span>
                  </div>
                  <p className="text-xs text-[#e67e22] font-semibold mt-1">{plan.billing}</p>
                </CardHeader>
                <CardContent className="pb-8">
                  <ul className="space-y-3 mb-8">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm">
                        <Check className="w-4 h-4 text-[#138808] mt-0.5 shrink-0" />
                        <span className="text-gray-600">{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    className={`w-full font-semibold ${
                      plan.popular
                        ? 'bg-gradient-to-r from-[#e67e22] to-[#f39c12] hover:from-[#d35400] hover:to-[#e67e22] text-white shadow-md shadow-orange-200'
                        : 'bg-[#1a365d] hover:bg-[#0f1f3d] text-white'
                    }`}
                    size="lg"
                    onClick={() => base44.auth.redirectToLogin(createPageUrl('Onboarding'))}
                  >
                    {plan.cta} <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}