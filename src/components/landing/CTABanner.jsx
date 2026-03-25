import React from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '../../utils';

export default function CTABanner() {
  return (
    <section className="py-12 bg-gradient-to-r from-[#0f1f3d] via-[#1a365d] to-[#1e3a5f] relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:32px_32px]" />
      <div className="absolute top-0 right-0 w-64 h-64 bg-[#FF9933]/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 left-0 w-48 h-48 bg-[#138808]/10 rounded-full blur-3xl" />
      
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.4 }}>
          
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#FF9933]/15 text-[#f39c12] text-sm font-medium mb-4">
            <Sparkles className="w-3.5 h-3.5" /> Limited Time Offer
          </div>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-3">
            AI For Your Business. AI For You.
          </h2>
          <p className="text-slate-300 mb-6 max-w-lg mx-auto">
            Use code <span className="text-[#FF9933] font-bold">VAANI20</span> for 20% off. Start your 7-day free trial — no credit card required.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              size="lg"
              className="bg-gradient-to-r from-[#e67e22] to-[#f39c12] hover:from-[#d35400] hover:to-[#e67e22] text-white px-8 py-5 text-base rounded-xl shadow-lg shadow-orange-500/25 font-semibold"
              onClick={() => base44.auth.redirectToLogin(createPageUrl('Onboarding'))}>
              
              Business AI Agent <ArrowRight className="w-5 h-5 ml-1" />
            </Button>
            <Button
              size="lg"
              className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white px-8 py-5 text-base rounded-xl shadow-lg shadow-purple-500/25 font-semibold"
              onClick={() => base44.auth.redirectToLogin(createPageUrl('Onboarding') + '?type=personal')}>
              
              Personal AI Assistant <ArrowRight className="w-5 h-5 ml-1" />
            </Button>
          </div>
        </motion.div>
      </div>
    </section>);

}