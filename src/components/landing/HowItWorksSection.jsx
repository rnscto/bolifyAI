import React from 'react';
import { UserPlus, Cpu, PhoneCall, BarChart3 } from 'lucide-react';
import { motion } from 'framer-motion';

const steps = [
  {
    step: '01',
    icon: UserPlus,
    title: 'Sign Up & Choose Industry',
    description: 'Create your account and select from 23+ industry templates. Your CRM configures itself in seconds.',
    color: 'bg-[#1a365d]'
  },
  {
    step: '02',
    icon: Cpu,
    title: 'Train Your AI Agent',
    description: 'Upload your knowledge base, set the tone and language. Your AI agent learns your business.',
    color: 'bg-[#FF9933]'
  },
  {
    step: '03',
    icon: PhoneCall,
    title: 'Start Calling Leads',
    description: 'Import leads and let your AI agent make outbound calls, qualify prospects, and book follow-ups.',
    color: 'bg-[#138808]'
  },
  {
    step: '04',
    icon: BarChart3,
    title: 'Track & Close Deals',
    description: 'Monitor your pipeline, review AI-analyzed transcripts, and watch deals progress automatically.',
    color: 'bg-[#e67e22]'
  }
];

export default function HowItWorksSection() {
  return (
    <section id="how-it-works" className="py-24 bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#e67e22]/10 text-[#e67e22] text-sm font-semibold mb-4">
            How It Works
          </div>
          <h2 className="text-4xl font-bold text-gray-900 mb-4">Up and Running in Minutes</h2>
          <p className="text-lg text-gray-500 max-w-2xl mx-auto">
            Four simple steps to transform your sales process with AI.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={step.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.4 }}
                className="relative text-center group"
              >
                {i < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-12 left-[60%] w-[80%] h-px bg-gradient-to-r from-gray-300 to-transparent" />
                )}
                <div className="w-24 h-24 rounded-2xl bg-white shadow-md border border-gray-100 flex items-center justify-center mx-auto mb-5 relative group-hover:shadow-lg transition-shadow">
                  <Icon className="w-10 h-10 text-[#1a365d]" />
                  <span className={`absolute -top-2 -right-2 w-8 h-8 rounded-full ${step.color} text-white text-xs font-bold flex items-center justify-center shadow-md`}>
                    {step.step}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{step.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{step.description}</p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}