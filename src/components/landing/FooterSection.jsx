import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';
import { Mail, Phone, MapPin } from 'lucide-react';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";

export default function FooterSection() {
  return (
    <footer className="bg-[#0f1f3d] text-slate-400 py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
          {/* Company Info */}
          <div className="md:col-span-2">
            <div className="mb-4">
              <img src={LOGO_URL} alt="VaaniAI" className="h-12 object-contain" />
            </div>
            <p className="text-sm leading-relaxed max-w-sm mb-6">
              AI-powered voice sales platform that automates outbound calling, qualifies leads,
              and manages your entire sales pipeline with an industry-specific CRM.
            </p>
            <div className="space-y-2 text-sm">
              <p className="text-white font-semibold text-xs uppercase tracking-wider mb-3">
                Tech Brainbucks Infosoft Pvt Ltd
              </p>
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-slate-500" />
                <span>101 Chanda Tower, Gandhi Path, Vaishali Nagar, Jaipur 302021</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">CIN:</span>
                <span>U74999RJ2022PTC083830</span>
              </div>
            </div>
          </div>

          {/* Product Links */}
          <div>
            <h4 className="text-white font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#features" className="hover:text-[#f39c12] transition-colors">Features</a></li>
              <li><a href="#pricing" className="hover:text-[#f39c12] transition-colors">Pricing</a></li>
              <li><a href="#how-it-works" className="hover:text-[#f39c12] transition-colors">How It Works</a></li>
              <li><a href="#industries" className="hover:text-[#f39c12] transition-colors">Industries</a></li>
            </ul>

            <h4 className="text-white font-semibold mt-6 mb-4">Legal</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to={createPageUrl('PrivacyPolicy')} className="hover:text-[#f39c12] transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link to={createPageUrl('TermsOfService')} className="hover:text-[#f39c12] transition-colors">
                  Terms of Service
                </Link>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-white font-semibold mb-4">Contact Us</h4>
            <ul className="space-y-3 text-sm">
              <li>
                <a href="tel:+917020609101" className="flex items-center gap-2 hover:text-[#f39c12] transition-colors">
                  <Phone className="w-4 h-4 text-[#e67e22]" />
                  +91-7020609101
                </a>
              </li>
              <li>
                <a href="mailto:sales@vaaniai.io" className="flex items-center gap-2 hover:text-[#f39c12] transition-colors">
                  <Mail className="w-4 h-4 text-[#e67e22]" />
                  sales@vaaniai.io
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-white/10 mt-12 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs">
            © {new Date().getFullYear()} Tech Brainbucks Infosoft Pvt Ltd. All rights reserved.
          </p>
          <div className="flex gap-6 text-xs">
            <Link to={createPageUrl('PrivacyPolicy')} className="hover:text-[#f39c12] transition-colors">
              Privacy Policy
            </Link>
            <Link to={createPageUrl('TermsOfService')} className="hover:text-[#f39c12] transition-colors">
              Terms of Service
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}