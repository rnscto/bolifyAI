import React from 'react';

export default function FooterSection() {
  return (
    <footer className="bg-slate-950 text-slate-400 py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/5161e7458_WhatsAppImage2026-02-11at44923PM.jpg" alt="VaaniAI" className="h-10 object-contain" />
            </div>
            <p className="text-sm leading-relaxed max-w-sm">
              AI-powered voice sales platform that automates outbound calling, qualifies leads, 
              and manages your entire sales pipeline with an industry-specific CRM.
            </p>
          </div>
          <div>
            <h4 className="text-white font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
              <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
              <li><span className="hover:text-white transition-colors cursor-default">API Docs</span></li>
              <li><span className="hover:text-white transition-colors cursor-default">Integrations</span></li>
            </ul>
          </div>
          <div>
            <h4 className="text-white font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-sm">
              <li><span className="hover:text-white transition-colors cursor-default">About</span></li>
              <li><span className="hover:text-white transition-colors cursor-default">Blog</span></li>
              <li><span className="hover:text-white transition-colors cursor-default">Careers</span></li>
              <li><span className="hover:text-white transition-colors cursor-default">Contact</span></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-slate-800 mt-12 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs">© {new Date().getFullYear()} VaaniAI. All rights reserved.</p>
          <div className="flex gap-6 text-xs">
            <span className="hover:text-white cursor-default">Privacy Policy</span>
            <span className="hover:text-white cursor-default">Terms of Service</span>
          </div>
        </div>
      </div>
    </footer>
  );
}