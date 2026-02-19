import React, { useEffect } from 'react';
import Navbar from '../components/landing/Navbar';
import HeroSection from '../components/landing/HeroSection';
import FeaturesSection from '../components/landing/FeaturesSection';
import HowItWorksSection from '../components/landing/HowItWorksSection';
import IndustriesSection from '../components/landing/IndustriesSection';
import PricingSection from '../components/landing/PricingSection';
import FAQSection from '../components/landing/FAQSection';
import FooterSection from '../components/landing/FooterSection';
import VoiceAgentPopup from '../components/landing/VoiceAgentPopup';
import SEOHead from '../components/landing/SEOHead.jsx';
import TrustStrip from '../components/landing/TrustStrip.jsx';
import CTABanner from '../components/landing/CTABanner.jsx';
import TrustedBySection from '../components/landing/TrustedBySection.jsx';

export default function Home() {
  useEffect(() => {
    // Smooth scroll for anchor links
    const handleClick = (e) => {
      const href = e.target.closest('a')?.getAttribute('href');
      if (href?.startsWith('#')) {
        e.preventDefault();
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  return (
    <div className="min-h-screen overflow-x-hidden">
      <SEOHead />
      <Navbar />
      <HeroSection />
      <TrustStrip />
      <TrustedBySection />
      <div id="how-it-works">
        <HowItWorksSection />
      </div>
      <FeaturesSection />
      <div id="industries">
        <IndustriesSection />
      </div>
      <PricingSection />
      <CTABanner />
      <div id="faq">
        <FAQSection />
      </div>
      <FooterSection />
      <VoiceAgentPopup />
    </div>
  );
}