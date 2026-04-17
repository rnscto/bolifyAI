import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';
import { MapPin } from 'lucide-react';

const LOGO_URL = "https://media.base44.com/images/public/69c78272bd33d5309cbe2b7c/77d0f07f9_WhatsAppImage2026-04-16at102149AM.jpg";

export default function FooterSection() {
  return (
    <footer className="bg-white border-t border-gray-200">
      {/* Main footer */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
          {/* Company Info */}
          <div className="md:col-span-2">
            <div className="mb-5">
              <img src={LOGO_URL} alt="Bolify AI" className="h-[64px] object-contain rounded-md" />
            </div>
            <p className="text-xs text-[#00bcd4] font-bold tracking-wider uppercase mb-1">Speak · Connect · Automate</p>
            <p className="text-sm leading-relaxed max-w-sm mb-6 text-gray-500">
            India's leading Business Automation Platform — AI CRM, AI Agent, IVR & WhatsApp automation for 23+ industries in Hindi & English.
            </p>
            <div className="space-y-2 text-sm">
            <p className="text-[#0097a7] font-semibold text-xs uppercase tracking-wider mb-3">
              BOLIFY AI TECHNOLOGY
            </p>
              <div className="flex items-start gap-2 text-gray-600">
                <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-[#00bcd4]" />
                <span>SCO: 24, 2nd Floor, Above Om Sweets, Huda Market, Sector-10A, GURUGRAM (HR) - 122001</span>
              </div>
            </div>
          </div>

          {/* Product Links */}
          <div>
            <h4 className="text-[#0097a7] font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#features" className="text-gray-500 hover:text-[#00bcd4] transition-colors">Features</a></li>
              <li><a href="#pricing" className="text-gray-500 hover:text-[#00bcd4] transition-colors">Pricing</a></li>
              <li><a href="#how-it-works" className="text-gray-500 hover:text-[#00bcd4] transition-colors">How It Works</a></li>
              <li><a href="#industries" className="text-gray-500 hover:text-[#00bcd4] transition-colors">Industries</a></li>
            </ul>

            <h4 className="text-[#0097a7] font-semibold mt-6 mb-4">Partners</h4>
            <ul className="space-y-2 text-sm mb-6">
              <li>
                <Link to={createPageUrl('PartnerSignup')} className="text-gray-500 hover:text-[#00bcd4] transition-colors">
                  Partner Program
                </Link>
              </li>
            </ul>

            <h4 className="text-[#0097a7] font-semibold mt-6 mb-4">Legal</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to={createPageUrl('PrivacyPolicy')} className="text-gray-500 hover:text-[#00bcd4] transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link to={createPageUrl('TermsOfService')} className="text-gray-500 hover:text-[#00bcd4] transition-colors">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link to={createPageUrl('RefundPolicy')} className="text-gray-500 hover:text-[#00bcd4] transition-colors">
                  Refund Policy
                </Link>
              </li>
              <li>
                <Link to={createPageUrl('CompliancePolicy')} className="text-gray-500 hover:text-[#00bcd4] transition-colors">
                  Compliance Policy
                </Link>
              </li>
            </ul>
          </div>


        </div>
      </div>

      {/* Bottom bar */}
      <div style={{ background: 'linear-gradient(135deg, #003d4d, #0097a7)' }}>
        {/* Cyan accent strip */}
        <div className="h-1 bg-gradient-to-r from-[#00bcd4] via-[#00e5ff] to-[#00bcd4]" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-cyan-100">
            © {new Date().getFullYear()} Bolify AI — Business Automation Platform. All rights reserved.
          </p>
          <div className="flex gap-6 text-xs">
            <Link to={createPageUrl('PrivacyPolicy')} className="text-cyan-200 hover:text-white transition-colors">
              Privacy Policy
            </Link>
            <Link to={createPageUrl('TermsOfService')} className="text-cyan-200 hover:text-white transition-colors">
              Terms of Service
            </Link>
            <Link to={createPageUrl('RefundPolicy')} className="text-cyan-200 hover:text-white transition-colors">
              Refund Policy
            </Link>
            <Link to={createPageUrl('CompliancePolicy')} className="text-cyan-200 hover:text-white transition-colors">
              Compliance Policy
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}