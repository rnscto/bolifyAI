import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';
import { Mail, Phone, MapPin } from 'lucide-react';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";

export default function FooterSection() {
  return (
    <footer className="bg-white border-t border-gray-200">
      {/* Main footer */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
          {/* Company Info */}
          <div className="md:col-span-2">
            <div className="mb-5">
              <img src={LOGO_URL} alt="VaaniAI" className="h-[76px] object-contain" />
            </div>
            <p className="text-sm leading-relaxed max-w-sm mb-6 text-gray-500">
              India's leading AI voice agent platform for automated outbound sales calling, AI lead qualification, and CRM pipeline management — available in Hindi & English for 23+ industries.
            </p>
            <div className="space-y-2 text-sm">
              <p className="text-[#1a365d] font-semibold text-xs uppercase tracking-wider mb-3">
                Tech Brainbucks Infosoft Pvt Ltd
              </p>
              <div className="flex items-start gap-2 text-gray-600">
                <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-[#138808]" />
                <span>101 Chanda Tower, Gandhi Path, Vaishali Nagar, Jaipur 302021</span>
              </div>
              <div className="flex items-center gap-2 text-gray-600">
                <span className="text-xs text-gray-400">CIN:</span>
                <span>U74999RJ2022PTC083830</span>
              </div>
            </div>
          </div>

          {/* Product Links */}
          <div>
            <h4 className="text-[#1a365d] font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#features" className="text-gray-500 hover:text-[#e67e22] transition-colors">Features</a></li>
              <li><a href="#pricing" className="text-gray-500 hover:text-[#e67e22] transition-colors">Pricing</a></li>
              <li><a href="#how-it-works" className="text-gray-500 hover:text-[#e67e22] transition-colors">How It Works</a></li>
              <li><a href="#industries" className="text-gray-500 hover:text-[#e67e22] transition-colors">Industries</a></li>
            </ul>

            <h4 className="text-[#1a365d] font-semibold mt-6 mb-4">Legal</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to={createPageUrl('PrivacyPolicy')} className="text-gray-500 hover:text-[#e67e22] transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link to={createPageUrl('TermsOfService')} className="text-gray-500 hover:text-[#e67e22] transition-colors">
                  Terms of Service
                </Link>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-[#1a365d] font-semibold mb-4">Contact Us</h4>
            <ul className="space-y-3 text-sm">
              <li>
                <a href="tel:+917020609101" className="flex items-center gap-2 text-gray-500 hover:text-[#e67e22] transition-colors">
                  <Phone className="w-4 h-4 text-[#FF9933]" />
                  +91-7020609101
                </a>
              </li>
              <li>
                <a href="mailto:sales@vaaniai.io" className="flex items-center gap-2 text-gray-500 hover:text-[#e67e22] transition-colors">
                  <Mail className="w-4 h-4 text-[#FF9933]" />
                  sales@vaaniai.io
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Bottom bar with tricolor accent */}
      <div className="bg-[#1a365d]">
        {/* Tricolor strip */}
        <div className="flex h-1">
          <div className="flex-1 bg-[#FF9933]" />
          <div className="flex-1 bg-white" />
          <div className="flex-1 bg-[#138808]" />
        </div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-slate-300">
            © {new Date().getFullYear()} Tech Brainbucks Infosoft Pvt Ltd. All rights reserved.
          </p>
          <div className="flex gap-6 text-xs">
            <Link to={createPageUrl('PrivacyPolicy')} className="text-slate-300 hover:text-[#FF9933] transition-colors">
              Privacy Policy
            </Link>
            <Link to={createPageUrl('TermsOfService')} className="text-slate-300 hover:text-[#FF9933] transition-colors">
              Terms of Service
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}