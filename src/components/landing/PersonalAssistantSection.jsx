import React from 'react';
import { Button } from '@/components/ui/button';
import { Shield, Phone, MessageSquare, Calendar, ArrowRight, UserCheck, Filter, Bell } from 'lucide-react';
import { motion } from 'framer-motion';
import { apiClient } from '@/api/apiClient';
import { createPageUrl } from '../../utils';

const features = [
  { icon: Shield, title: 'Spam Protection', desc: 'AI screens every call — spam and telemarketing never reach you.' },
  { icon: Bell, title: 'Real-Time Alerts', desc: 'Get WhatsApp notifications with caller info and call purpose instantly.' },
  { icon: MessageSquare, title: 'Owner-in-the-Loop', desc: 'Tell your AI what to say mid-call — "tell them I\'m busy" or "transfer to me".' },
  { icon: Filter, title: 'Smart Classification', desc: 'Calls auto-classified as Family, Business, Promotional, or Spam.' },
  { icon: Calendar, title: 'Meeting Scheduling', desc: 'AI schedules meetings on your behalf and adds them to your calendar.' },
  { icon: UserCheck, title: 'Call Summaries', desc: 'Get conversation outcomes, notes, and action items after every call.' },
];

export default function PersonalAssistantSection() {
  return (
    <section id="personal-assistant" className="py-16 lg:py-20 bg-gradient-to-br from-purple-50 via-white to-indigo-50 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-96 h-96 bg-purple-200/20 rounded-full blur-3xl" />
      <div className="absolute bottom-0 left-0 w-72 h-72 bg-indigo-200/20 rounded-full blur-3xl" />
      
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left — Text */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-100 text-purple-700 text-sm font-semibold mb-6">
              <Phone className="w-3.5 h-3.5" /> NEW — Personal AI Assistant
            </div>

            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 leading-tight mb-5">
              Your AI Handles Calls.
              <span className="block text-purple-600">You Stay in Control.</span>
            </h2>

            <p className="text-lg text-gray-600 mb-8 max-w-lg">
              Forward your calls to your AI assistant's number. It answers, screens spam, takes messages, 
              and sends you real-time WhatsApp updates. Tell it what to say — or transfer the call to yourself when needed.
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                size="lg"
                className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white px-8 py-5 text-base rounded-xl shadow-lg shadow-purple-500/25 font-semibold"
                onClick={() => apiClient.auth.redirectToLogin(createPageUrl('Onboarding') + '?type=personal')}
              >
                Get Your AI Assistant <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </div>

            {/* Quick stats */}
            <div className="flex gap-8 mt-8 pt-6 border-t border-purple-100">
              <div>
                <p className="text-2xl font-bold text-gray-900">100%</p>
                <p className="text-sm text-gray-500">Privacy Protected</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">24/7</p>
                <p className="text-sm text-gray-500">Call Screening</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">&lt;3s</p>
                <p className="text-sm text-gray-500">Alert Speed</p>
              </div>
            </div>
          </motion.div>

          {/* Right — Feature grid */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {features.map((f, i) => {
                const Icon = f.icon;
                return (
                  <motion.div
                    key={f.title}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.06 }}
                    className="bg-white rounded-xl border border-purple-100 p-4 hover:shadow-md hover:border-purple-200 transition-all"
                  >
                    <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center mb-3">
                      <Icon className="w-5 h-5 text-purple-600" />
                    </div>
                    <h4 className="font-semibold text-gray-900 text-sm mb-1">{f.title}</h4>
                    <p className="text-xs text-gray-500 leading-relaxed">{f.desc}</p>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}