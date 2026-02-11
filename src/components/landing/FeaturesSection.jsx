import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Bot, PhoneCall, BarChart3, Users, Zap, Globe,
  Brain, Calendar, Shield
} from 'lucide-react';
import { motion } from 'framer-motion';

const features = [
  {
    icon: Bot,
    title: 'AI Voice Agents',
    description: 'Deploy intelligent voice agents that speak naturally in English and Hindi, trained on your business knowledge.',
    color: 'bg-blue-500/10 text-blue-500'
  },
  {
    icon: PhoneCall,
    title: 'Automated Outbound Calls',
    description: 'Reach hundreds of leads automatically. Your AI agent qualifies, engages, and books follow-ups.',
    color: 'bg-green-500/10 text-green-500'
  },
  {
    icon: BarChart3,
    title: 'Industry-Specific CRM',
    description: 'Pre-built CRM templates for 23+ industries — from Real Estate to Healthcare to SaaS.',
    color: 'bg-indigo-500/10 text-indigo-500'
  },
  {
    icon: Brain,
    title: 'AI Transcript Analysis',
    description: 'Every call is transcribed and analyzed. Auto-detect lead interest, update scores, and trigger actions.',
    color: 'bg-purple-500/10 text-purple-500'
  },
  {
    icon: Zap,
    title: 'Pipeline Automation',
    description: 'Auto-create deals from interested leads, schedule follow-ups, and move deals through stages automatically.',
    color: 'bg-amber-500/10 text-amber-500'
  },
  {
    icon: Globe,
    title: 'Multi-Language Support',
    description: 'Engage leads in English, Hindi, or bilingual mode. Your agents adapt to the conversation.',
    color: 'bg-teal-500/10 text-teal-500'
  },
  {
    icon: Calendar,
    title: 'Smart Follow-ups',
    description: '48-hour no-response detection, auto-scheduled follow-ups, and priority-based task management.',
    color: 'bg-rose-500/10 text-rose-500'
  },
  {
    icon: Users,
    title: 'Lead Scoring',
    description: 'AI-powered lead scoring that updates in real-time based on call outcomes and engagement history.',
    color: 'bg-cyan-500/10 text-cyan-500'
  },
  {
    icon: Shield,
    title: 'Knowledge Base',
    description: 'Upload PDFs, docs, and FAQs. Your AI agent uses them to give accurate, contextual responses.',
    color: 'bg-orange-500/10 text-orange-500'
  }
];

export default function FeaturesSection() {
  return (
    <section id="features" className="py-24 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <p className="text-sm font-semibold text-blue-600 uppercase tracking-wider mb-2">Features</p>
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
                <Card className="h-full hover:shadow-lg transition-shadow border-gray-100">
                  <CardContent className="p-6">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${feature.color}`}>
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