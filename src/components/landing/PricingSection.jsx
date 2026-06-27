import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Check, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/api/apiClient';
import { motion } from 'framer-motion';
import { createPageUrl } from '../../utils';

const plans = [
  {
    name: 'Personal AI Assistant',
    price: '₹3,999',
    period: '/month',
    gst: '+ GST',
    billing: '7-day free trial',
    description: 'AI handles your personal calls — screens spam, takes messages, transfers to you',
    features: [
      'AI answers all your calls 24/7',
      'Spam & telemarketing screening',
      'Real-time WhatsApp call alerts',
      'Smart call classification (Family/Business/Spam)',
      'Owner-in-the-loop: instruct AI mid-call',
      'Call transfer to you on demand',
      'Conversation summaries & notes',
      'Meeting scheduling on your behalf',
    ],
    cta: 'Get Your AI Assistant',
    popular: false,
    isPersonal: true,
  },
  {
    name: 'Business Voice AI',
    price: '₹14,999',
    period: '/channel/month',
    gst: '+ GST',
    billing: 'Billed monthly per channel',
    description: 'AI-powered outbound sales calling software for growing businesses',
    features: [
      'AI Voice Agent (Hindi + English)',
      'Dedicated DID Number (+91)',
      'Unlimited AI outbound calls',
      'Real-time call transcription',
      'AI conversation analysis & scoring',
      'Automatic lead status updates',
      'Custom knowledge base upload',
      'Call logs, recordings & analytics',
    ],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Business + CRM',
    price: '₹19,999',
    period: '/channel/month',
    gst: '+ GST',
    billing: 'Billed monthly per channel',
    description: 'Everything in Business + industry-specific sales CRM',
    features: [
      'Everything in Business Voice AI',
      'Industry-specific CRM software',
      'Deal pipeline (Kanban + Table view)',
      'AI sales reports & forecasting',
      'Pipeline automation rules',
      '48h follow-up auto-detection',
      'Custom fields per industry',
    ],
    cta: 'Start Free Trial',
    popular: false,
  }
];

export default function PricingSection() {
  return (
    <section id="pricing" className="py-16 lg:py-20 bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#e67e22]/10 text-[#e67e22] text-sm font-semibold mb-4">
            Pricing
          </div>
          <h2 className="text-4xl font-bold text-gray-900 mb-4">Affordable AI Calling Software Pricing</h2>
          <p className="text-lg text-gray-500">Transparent pricing for AI voice agents in India. No hidden fees. Start with a free trial.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ delay: i * 0.1, duration: 0.35, ease: "easeOut" }}
              whileHover={{ y: -4 }}
            >
              <Card className={`relative h-full transition-shadow ${
                plan.popular
                  ? 'border-[#e67e22] shadow-lg shadow-orange-100'
                  : plan.isPersonal
                    ? 'border-purple-200 hover:border-purple-400 hover:shadow-md'
                    : 'border-gray-200 hover:shadow-md'
              }`}>
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-gradient-to-r from-[#e67e22] to-[#f39c12] text-gray-900 px-4 py-1 border-0">Most Popular</Badge>
                  </div>
                )}
                <CardHeader className="text-center pt-8">
                  <CardTitle className="text-xl font-semibold text-gray-900">{plan.name}</CardTitle>
                  <p className="text-sm text-gray-500 mt-1">{plan.description}</p>
                  <div className="mt-4">
                    <span className="text-4xl font-bold text-[#1a365d]">{plan.price}</span>
                    <span className="text-gray-500 text-sm">{plan.period}</span>
                  </div>
                  <p className="text-xs text-gray-500 font-medium mt-0.5">{plan.gst}</p>
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
                        ? 'bg-gradient-to-r from-[#e67e22] to-[#f39c12] hover:from-[#d35400] hover:to-[#e67e22] text-gray-900 shadow-md shadow-orange-200'
                        : plan.isPersonal
                          ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-gray-900 shadow-md shadow-purple-200'
                          : 'bg-[#1a365d] hover:bg-[#0f1f3d] text-gray-900'
                    }`}
                    size="lg"
                    onClick={() => apiClient.auth.redirectToLogin(createPageUrl('Onboarding') + (plan.isPersonal ? '?type=personal' : ''))}
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