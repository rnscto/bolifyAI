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
    title: 'AI Voice Agents',
    description: 'Deploy intelligent voice agents that speak naturally in English and Hindi, trained on your business knowledge.',
    color: 'from-[#1a365d] to-[#2a4a7f]',
    iconBg: 'bg-[#1a365d]/10 text-[#1a365d]'
  },
  {
    icon: PhoneCall,
    title: 'Automated Outbound Calls',
    description: 'Reach hundreds of leads automatically. Your AI agent qualifies, engages, and books follow-ups.',
    color: 'from-[#138808] to-[#1a9e0f]',
    iconBg: 'bg-[#138808]/10 text-[#138808]'
  },
  {
    icon: BarChart3,
    title: 'Industry-Specific CRM',
    description: 'Pre-built CRM templates for 23+ industries — from Real Estate to Healthcare to SaaS.',
    color: 'from-[#e67e22] to-[#f39c12]',
    iconBg: 'bg-[#e67e22]/10 text-[#e67e22]'
  },
  {
    icon: Brain,
    title: 'AI Transcript Analysis',
    description: 'Every call is transcribed and analyzed. Auto-detect lead interest, update scores, and trigger actions.',
    color: 'from-[#1a365d] to-[#2a4a7f]',
    iconBg: 'bg-purple-500/10 text-purple-600'
  },
  {
    icon: Zap,
    title: 'Pipeline Automation',
    description: 'Auto-create deals from interested leads, schedule follow-ups, and move deals through stages automatically.',
    color: 'from-[#FF9933] to-[#e67e22]',
    iconBg: 'bg-amber-500/10 text-amber-600'
  },
  {
    icon: Globe,
    title: 'Multi-Language Support',
    description: 'Engage leads in English, Hindi, or bilingual mode. Your agents adapt to the conversation.',
    color: 'from-[#138808] to-[#1a9e0f]',
    iconBg: 'bg-teal-500/10 text-teal-600'
  },
  {
    icon: Calendar,
    title: 'Smart Follow-ups',
    description: '48-hour no-response detection, auto-scheduled follow-ups, and priority-based task management.',
    color: 'from-[#e67e22] to-[#f39c12]',
    iconBg: 'bg-rose-500/10 text-rose-500'
  },
  {
    icon: Users,
    title: 'Lead Scoring',
    description: 'AI-powered lead scoring that updates in real-time based on call outcomes and engagement history.',
    color: 'from-[#1a365d] to-[#2a4a7f]',
    iconBg: 'bg-cyan-500/10 text-cyan-600'
  },
  {
    icon: Shield,
    title: 'Knowledge Base',
    description: 'Upload PDFs, docs, and FAQs. Your AI agent uses them to give accurate, contextual responses.',
    color: 'from-[#FF9933] to-[#e67e22]',
    iconBg: 'bg-[#FF9933]/10 text-[#FF9933]'
  }
];

export default function FeaturesSection() {
  return (
    <section id="features" className="py-24 bg-white relative overflow-hidden">
      {/* Background wave */}
      <VoiceWaveBg color="rgba(26,54,93,0.03)" position="top" />
      {/* Decorative pulse */}
      <PulseRings className="absolute -top-10 -right-10 opacity-15" color="#1a365d" size={250} rings={3} />
      <PulseRings className="absolute bottom-20 -left-16 opacity-10" color="#138808" size={180} rings={2} />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1a365d]/5 text-[#1a365d] text-sm font-semibold mb-4">
            <Zap className="w-3.5 h-3.5" /> Features
          </div>
          <h2 className="text-4xl font-bold text-gray-900 mb-4">Everything You Need to Close More Deals</h2>
          <p className="text-lg text-gray-500 max-w-2xl mx-auto">
            From AI voice calling to pipeline automation — VaaniAI handles your entire sales workflow.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05, duration: 0.4 }}
              >
                <Card className="h-full group hover:shadow-lg transition-all duration-300 border-gray-100 hover:border-[#e67e22]/30 overflow-hidden">
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