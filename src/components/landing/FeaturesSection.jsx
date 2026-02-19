import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Cpu, PhoneCall, BarChart3, Users, Zap, Globe,
  Brain, Calendar, Shield
} from 'lucide-react';
import { motion } from 'framer-motion';
import PulseRings from './PulseRings';
import VoiceWaveBg from './VoiceWaveBg';

const features = [
  {
    icon: Cpu,
    title: 'AI Voice Agent for Business',
    description: 'Deploy voice AI agents that speak naturally in English and Hindi — trained on your products, services, and sales scripts.',
    color: 'from-[#1a365d] to-[#2a4a7f]',
    iconBg: 'bg-[#1a365d]/10 text-[#1a365d]'
  },
  {
    icon: PhoneCall,
    title: 'Automated Outbound Calling',
    description: 'AI-powered outbound call automation that reaches hundreds of leads daily. Qualifies prospects, books meetings, and updates your CRM.',
    color: 'from-[#138808] to-[#1a9e0f]',
    iconBg: 'bg-[#138808]/10 text-[#138808]'
  },
  {
    icon: BarChart3,
    title: 'Industry-Specific Sales CRM',
    description: 'Pre-built CRM software for 23+ industries — Real Estate, Healthcare, Education, Insurance, SaaS, and more.',
    color: 'from-[#e67e22] to-[#f39c12]',
    iconBg: 'bg-[#e67e22]/10 text-[#e67e22]'
  },
  {
    icon: Brain,
    title: 'AI Call Transcript Analysis',
    description: 'Every call is transcribed and analyzed by AI. Auto-detect buyer intent, update lead scores, and trigger follow-up workflows.',
    color: 'from-[#1a365d] to-[#2a4a7f]',
    iconBg: 'bg-purple-500/10 text-purple-600'
  },
  {
    icon: Zap,
    title: 'Sales Pipeline Automation',
    description: 'Automate deal creation from qualified leads, schedule follow-ups, and move opportunities through your sales funnel automatically.',
    color: 'from-[#FF9933] to-[#e67e22]',
    iconBg: 'bg-amber-500/10 text-amber-600'
  },
  {
    icon: Globe,
    title: 'Hindi & English Voice Bot',
    description: 'Multilingual AI voice bot that converses in English, Hindi, or bilingual mode — ideal for Indian businesses and government services.',
    color: 'from-[#138808] to-[#1a9e0f]',
    iconBg: 'bg-teal-500/10 text-teal-600'
  },
  {
    icon: Calendar,
    title: 'Smart Follow-up Automation',
    description: 'Auto-detect no-response leads within 48 hours, schedule AI callback campaigns, and prioritize high-intent prospects.',
    color: 'from-[#e67e22] to-[#f39c12]',
    iconBg: 'bg-rose-500/10 text-rose-500'
  },
  {
    icon: Users,
    title: 'AI Lead Scoring & Qualification',
    description: 'Real-time AI lead scoring based on call outcomes, engagement frequency, and buying signals — never miss a hot lead.',
    color: 'from-[#1a365d] to-[#2a4a7f]',
    iconBg: 'bg-cyan-500/10 text-cyan-600'
  },
  {
    icon: Shield,
    title: 'AI Knowledge Base',
    description: 'Upload product brochures, FAQs, and sales documents. Your AI calling agent uses them to give accurate, context-aware responses on every call.',
    color: 'from-[#FF9933] to-[#e67e22]',
    iconBg: 'bg-[#FF9933]/10 text-[#FF9933]'
  }
];

export default function FeaturesSection() {
  return (
    <section id="features" className="py-16 lg:py-20 bg-white relative overflow-hidden">
      {/* Background wave */}
      <VoiceWaveBg color="rgba(26,54,93,0.03)" position="top" />
      {/* Decorative pulse */}
      <PulseRings className="absolute -top-10 -right-10 opacity-15" color="#1a365d" size={250} rings={3} />
      <PulseRings className="absolute bottom-20 -left-16 opacity-10" color="#138808" size={180} rings={2} />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1a365d]/5 text-[#1a365d] text-sm font-semibold mb-4">
            <Zap className="w-3.5 h-3.5" /> Features
          </div>
          <h2 className="text-4xl font-bold text-gray-900 mb-4">AI Sales Automation Features to Close More Deals</h2>
          <h3 className="text-lg text-gray-500 max-w-2xl mx-auto font-normal">
            From AI voice calling to CRM pipeline automation — VaaniAI is the all-in-one AI calling software for Indian businesses.
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ delay: i * 0.04, duration: 0.3, ease: "easeOut" }}
              >
                <Card className="h-full group hover:shadow-xl hover:-translate-y-1 transition-all duration-200 border-gray-100 hover:border-[#e67e22]/30 overflow-hidden">
                  <CardContent className="p-6 relative">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br opacity-5 rounded-bl-full group-hover:opacity-10 transition-opacity" 
                         style={{ backgroundImage: `linear-gradient(to bottom right, #e67e22, #FF9933)` }} />
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${feature.iconBg}`}>
                      <Icon className="w-6 h-6" />
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">{feature.title}</h3>
                    <p className="text-gray-500 text-sm leading-relaxed">{feature.description}</p>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}