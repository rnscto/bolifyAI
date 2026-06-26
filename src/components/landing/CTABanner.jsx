import React from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import { apiClient } from '@/api/apiClient';
import { createPageUrl } from '../../utils';

export default function CTABanner() {
  return (
    <section className="py-12 relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #003d4d, #005f73, #0097a7)' }}>
      <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:32px_32px]" />
      <div className="absolute top-0 right-0 w-64 h-64 bg-[#00bcd4]/15 rounded-full blur-3xl" />
      <div className="absolute bottom-0 left-0 w-48 h-48 bg-[#00e5ff]/10 rounded-full blur-3xl" />
      
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.4 }}>
          
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#00bcd4]/20 text-[#b2ebf2] text-sm font-medium mb-4">
            <Sparkles className="w-3.5 h-3.5" /> Limited Time Offer
          </div>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-3">
            AI For Your Business. AI For You.
          </h2>
          <p className="text-cyan-100 mb-6 max-w-lg mx-auto">
            Use code <span className="text-[#00e5ff] font-bold">BOLIFY20</span> for 20% off. Start your 7-day free trial — no credit card required.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              size="lg"
              className="text-white px-8 py-5 text-base rounded-xl font-semibold border-0"
              style={{ background: 'linear-gradient(135deg, #00bcd4, #0097a7)', boxShadow: '0 8px 24px rgba(0,188,212,0.35)' }}
              onClick={() => apiClient.auth.redirectToLogin(createPageUrl('Onboarding'))}>
              
              Business AI Agent <ArrowRight className="w-5 h-5 ml-1" />
            </Button>
            <Button
              size="lg"
              className="bg-white/15 hover:bg-white/25 text-white px-8 py-5 text-base rounded-xl font-semibold border border-white/30"
              onClick={() => apiClient.auth.redirectToLogin(createPageUrl('Onboarding') + '?type=personal')}>
              
              Personal AI Assistant <ArrowRight className="w-5 h-5 ml-1" />
            </Button>
          </div>
        </motion.div>
      </div>
    </section>);

}