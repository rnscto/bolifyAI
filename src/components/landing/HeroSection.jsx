import React from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, PhoneCall, TrendingUp, Mic, Zap } from 'lucide-react';
import { apiClient } from '@/api/apiClient';
import { motion } from 'framer-motion';
import { createPageUrl } from '../../utils';
import AnimatedWaveform from './AnimatedWaveform';
import PulseRings from './PulseRings';

import { BOLIFYAI_LOGO } from '@/lib/assets';

const LOGO_URL = BOLIFYAI_LOGO;

export default function HeroSection() {
  return (
    <section className="relative overflow-hidden min-h-[90vh] flex items-center pt-20 pb-8"
      style={{ background: 'linear-gradient(135deg, #003d4d 0%, #005f73 40%, #007a8a 70%, #00bcd4 100%)' }}>
      {/* Decorative elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-20 right-10 w-80 h-80 bg-[#00bcd4]/15 rounded-full blur-3xl" />
        <div className="absolute bottom-20 left-10 w-96 h-96 bg-[#00e5ff]/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-white/3 rounded-full blur-3xl" />
        {/* Dot grid */}
        <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:40px_40px]" />
        {/* Diagonal lines matching logo */}
        <div className="absolute top-0 right-0 w-1/3 h-full opacity-5">
          <div className="h-full w-full" style={{ backgroundImage: 'repeating-linear-gradient(-45deg, white 0, white 2px, transparent 0, transparent 50%)', backgroundSize: '20px 20px' }} />
        </div>
        <PulseRings className="absolute top-16 right-[15%] opacity-30" color="#00e5ff" size={160} rings={3} />
        <PulseRings className="absolute bottom-24 left-[8%] opacity-20" color="#00bcd4" size={120} rings={2} />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left - Text Content */}
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          >
            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[#00e5ff]/40 bg-[#00bcd4]/15 text-[#b2ebf2] text-sm font-medium mb-8">
              <Mic className="w-4 h-4" />
              Business Automation Platform — Speak · Connect · Automate
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 leading-tight mb-6">
              AI CRM · AI Agent
              <span className="block mt-2">
                IVR ·{' '}
                <span className="text-[#00e5ff]">
                  WhatsApp
                </span>
              </span>
            </h1>

            <h2 className="text-lg text-cyan-100 max-w-xl mb-8 leading-relaxed font-normal">
              <strong className="text-gray-900">For Business:</strong> AI sales agent that qualifies leads, makes calls & closes deals 24/7.
              <br />
              <strong className="text-gray-900">For You:</strong> Personal AI assistant that screens your calls, blocks spam & keeps you in control.
            </h2>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row gap-4">
              <Button
                size="lg"
                className="text-gray-900 px-8 py-6 text-lg rounded-xl shadow-lg font-semibold border-0"
                style={{ background: 'linear-gradient(135deg, #00bcd4, #0097a7)', boxShadow: '0 8px 24px rgba(0,188,212,0.35)' }}
                onClick={() => apiClient.auth.redirectToLogin(createPageUrl('Onboarding'))}
              >
                For Business <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
              <Button
                size="lg"
                className="bg-white/15 hover:bg-white/25 text-gray-900 px-8 py-6 text-lg rounded-xl font-semibold border border-slate-200/30 "
                onClick={() => apiClient.auth.redirectToLogin(createPageUrl('Onboarding') + '?type=personal')}
              >
                Personal AI Assistant <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-6 mt-12 pt-8 border-t border-white/15">
              {[
                { icon: PhoneCall, value: '24/7', label: 'AI Calling & Screening' },
                { value: '23+', label: 'Industry CRMs' },
                { icon: TrendingUp, value: '100%', label: 'Privacy Protected' },
              ].map((stat) => (
                <div key={stat.label}>
                  <p className="text-2xl sm:text-3xl font-bold text-gray-900">{stat.value}</p>
                  <p className="text-sm text-cyan-200 mt-1">{stat.label}</p>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Right - Visual */}
          <motion.div
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.15, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="hidden lg:flex items-center justify-center"
          >
            <div className="relative">
              {/* Glow ring */}
              <div className="absolute inset-0 -m-8 rounded-full bg-gradient-to-br from-[#00bcd4]/30 via-transparent to-[#00e5ff]/20 blur-2xl" />
              
              {/* Logo display */}
              <div className="relative bg-slate-50  border border-slate-200/20 rounded-3xl p-8">
                <img src={LOGO_URL} alt="Bolify AI" className="w-80 h-auto drop-shadow-2xl rounded-xl" />
                
                {/* Voice waveform overlay */}
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
                  <AnimatedWaveform barCount={24} color="rgba(0,229,255,0.4)" height={30} />
                </div>
                
                {/* Floating cards */}
                <motion.div
                  animate={{ y: [0, -10, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                  className="absolute -top-4 -right-4 bg-white rounded-xl shadow-xl p-3 flex items-center gap-2"
                >
                  <div className="w-8 h-8 rounded-full bg-cyan-100 flex items-center justify-center">
                    <PhoneCall className="w-4 h-4 text-[#00bcd4]" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-900">Lead Qualified</p>
                    <p className="text-[10px] text-gray-500">Just now</p>
                  </div>
                </motion.div>

                <motion.div
                  animate={{ y: [0, 10, 0] }}
                  transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
                  className="absolute -bottom-4 -left-4 bg-white rounded-xl shadow-xl p-3 flex items-center gap-2"
                >
                  <div className="w-8 h-8 rounded-full bg-cyan-100 flex items-center justify-center">
                    <TrendingUp className="w-4 h-4 text-[#0097a7]" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-900">Deal Created</p>
                    <p className="text-[10px] text-gray-500">₹2,50,000</p>
                  </div>
                </motion.div>

                <motion.div
                  animate={{ y: [0, -8, 0] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
                  className="absolute top-1/2 -left-6 bg-white rounded-xl shadow-xl p-3 flex items-center gap-2"
                >
                  <div className="w-8 h-8 rounded-full bg-cyan-100 flex items-center justify-center">
                    <Zap className="w-4 h-4 text-[#00bcd4]" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-900">Automation</p>
                    <p className="text-[10px] text-gray-500">Active</p>
                  </div>
                </motion.div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}