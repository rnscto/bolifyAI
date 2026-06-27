import React from 'react';
import { UserPlus, Cpu, PhoneCall, BarChart3 } from 'lucide-react';
import { motion } from 'framer-motion';
import AnimatedWaveform from './AnimatedWaveform';
import PulseRings from './PulseRings';

const steps = [
  {
    step: '01',
    icon: UserPlus,
    title: 'Sign Up & Select Your Industry',
    description: 'Create your free account and choose from 23+ pre-built industry CRM templates — auto-configured in seconds.',
    color: 'bg-[#1a365d]'
  },
  {
    step: '02',
    icon: Cpu,
    title: 'Configure Your AI Voice Agent',
    description: 'Upload your knowledge base, set the conversation tone, and choose Hindi, English, or bilingual mode. Your AI agent is ready.',
    color: 'bg-[#FF9933]'
  },
  {
    step: '03',
    icon: PhoneCall,
    title: 'Launch Automated Calling Campaigns',
    description: 'Import your lead list and let the AI calling agent make outbound sales calls, qualify leads, and schedule follow-ups.',
    color: 'bg-[#138808]'
  },
  {
    step: '04',
    icon: BarChart3,
    title: 'Track Pipeline & Close Deals',
    description: 'Monitor your sales funnel with AI analytics, review call transcripts, and watch deals close automatically.',
    color: 'bg-[#e67e22]'
  }
];

export default function HowItWorksSection() {
  return (
    <section id="how-it-works" className="py-16 lg:py-20 bg-gradient-to-b from-gray-50 to-white relative overflow-hidden">
      {/* Decorative pulses */}
      <div className="absolute top-10 right-[5%] opacity-10 pointer-events-none"><PulseRings color="#e67e22" size={200} rings={3} /></div>
      <div className="absolute bottom-16 left-[3%] opacity-10 pointer-events-none"><PulseRings color="#1a365d" size={150} rings={2} /></div>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#e67e22]/10 text-[#e67e22] text-sm font-semibold mb-4">
            How It Works
          </div>
          <h2 className="text-4xl font-bold text-gray-900 mb-4">Set Up Your AI Calling Agent in Minutes</h2>
          <p className="text-lg text-gray-500 max-w-2xl mx-auto">
            Four simple steps to automate your outbound sales calls with India's best AI voice agent.
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
                transition={{ delay: i * 0.08, duration: 0.35 }}
                className="relative text-center group"
              >
                {i < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-12 left-[60%] w-[80%] h-px bg-gradient-to-r from-gray-300 to-transparent" />
                )}
                <div className="w-24 h-24 rounded-2xl bg-white shadow-md border border-gray-100 flex items-center justify-center mx-auto mb-5 relative group-hover:shadow-lg transition-shadow">
                  <Icon className="w-10 h-10 text-[#1a365d]" />
                  <span className={`absolute -top-2 -right-2 w-8 h-8 rounded-full ${step.color} text-gray-900 text-xs font-bold flex items-center justify-center shadow-md`}>
                    {step.step}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{step.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{step.description}</p>
              </motion.div>
            );
          })}
        </div>

        {/* Voice waveform decoration - compact */}
        <div className="flex justify-center mt-6 opacity-30">
          <AnimatedWaveform barCount={30} color="rgba(26,54,93,0.3)" height={20} />
        </div>
      </div>
    </section>
  );
}