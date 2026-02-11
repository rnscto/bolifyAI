import React from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Play, PhoneCall, TrendingUp, Mic } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { motion } from 'framer-motion';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";

export default function HeroSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-[#0f1f3d] via-[#1a365d] to-[#1e3a5f] min-h-[92vh] flex items-center pt-16">
      {/* Decorative elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-20 right-10 w-80 h-80 bg-[#e67e22]/10 rounded-full blur-3xl" />
        <div className="absolute bottom-20 left-10 w-96 h-96 bg-[#138808]/8 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-[#FF9933]/5 rounded-full blur-3xl" />
        {/* Subtle dot grid */}
        <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:40px_40px]" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left - Text Content */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7 }}
          >
            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[#e67e22]/30 bg-[#e67e22]/10 text-[#f39c12] text-sm font-medium mb-8">
              <Mic className="w-4 h-4" />
              Your Smart AI Voice Agent
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white leading-tight mb-6">
              Turn Every Call
              <span className="block mt-2">
                Into a{' '}
                <span className="bg-gradient-to-r from-[#FF9933] via-[#e67e22] to-[#f39c12] bg-clip-text text-transparent">
                  Conversion
                </span>
              </span>
            </h1>

            <p className="text-lg text-slate-300 max-w-xl mb-8 leading-relaxed">
              VaaniAI deploys intelligent voice agents that engage leads, qualify prospects,
              and close deals — 24/7, in English & Hindi, with your custom CRM built-in.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row gap-4">
              <Button
                size="lg"
                className="bg-gradient-to-r from-[#e67e22] to-[#f39c12] hover:from-[#d35400] hover:to-[#e67e22] text-white px-8 py-6 text-lg rounded-xl shadow-lg shadow-orange-500/25 font-semibold"
                onClick={() => base44.auth.redirectToLogin()}
              >
                Start Free Trial <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
              <Button
                size="lg"
                className="bg-white/10 border border-white/30 text-white hover:bg-white/20 px-8 py-6 text-lg rounded-xl backdrop-blur-sm"
                onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <Play className="w-5 h-5 mr-2" /> See How It Works
              </Button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-6 mt-12 pt-8 border-t border-white/10">
              {[
                { icon: PhoneCall, value: '24/7', label: 'AI Calling' },
                { value: '23+', label: 'Industries' },
                { icon: TrendingUp, value: '3x', label: 'More Conversions' },
              ].map((stat) => (
                <div key={stat.label}>
                  <p className="text-2xl sm:text-3xl font-bold text-white">{stat.value}</p>
                  <p className="text-sm text-slate-400 mt-1">{stat.label}</p>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Right - Visual */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="hidden lg:flex items-center justify-center"
          >
            <div className="relative">
              {/* Glow ring */}
              <div className="absolute inset-0 -m-8 rounded-full bg-gradient-to-br from-[#FF9933]/20 via-transparent to-[#138808]/20 blur-2xl" />
              
              {/* Logo display */}
              <div className="relative bg-white/5 backdrop-blur-sm border border-white/10 rounded-3xl p-8">
                <img src={LOGO_URL} alt="VaaniAI" className="w-80 h-auto drop-shadow-2xl" />
                
                {/* Floating cards */}
                <motion.div
                  animate={{ y: [0, -10, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                  className="absolute -top-4 -right-4 bg-white rounded-xl shadow-xl p-3 flex items-center gap-2"
                >
                  <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                    <PhoneCall className="w-4 h-4 text-green-600" />
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
                  <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center">
                    <TrendingUp className="w-4 h-4 text-[#e67e22]" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-900">Deal Created</p>
                    <p className="text-[10px] text-gray-500">₹2,50,000</p>
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