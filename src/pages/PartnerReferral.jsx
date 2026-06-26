import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Loader2, Users, IndianRupee, TrendingUp, Handshake, Phone, Cpu, BarChart3 } from 'lucide-react';
import { motion } from 'framer-motion';

const DEFAULT_LOGO = "https://media.base44.com/images/public/69c78272bd33d5309cbe2b7c/77d0f07f9_WhatsAppImage2026-04-16at102149AM.jpg";

const FEATURES = [
  { icon: Phone, title: 'AI Voice Calls', desc: 'Automated outbound & inbound calls in Hindi/English' },
  { icon: Cpu, title: 'Smart AI Agents', desc: 'Custom-trained agents for your industry' },
  { icon: BarChart3, title: 'Lead Scoring', desc: 'AI-powered lead qualification & follow-up' },
  { icon: Users, title: 'CRM Built-in', desc: 'Complete pipeline & deal management' },
];

export default function PartnerReferral() {
  const [partner, setPartner] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ company_name: '', email: '', phone: '', contact_name: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadPartner();
  }, []);

  const loadPartner = async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code') || urlParams.get('ref');
    if (!code) { setLoading(false); return; }

    const partners = await apiClient.Partner.filter({ referral_code: code });
    if (partners.length > 0) setPartner(partners[0]);
    setLoading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.company_name || !form.email || !form.phone) {
      setError('Please fill in company name, email, and phone.');
      return;
    }
    setSubmitting(true);
    setError('');

    // Create a referral record
    await apiClient.Referral.create({
      partner_id: partner.id,
      client_name: form.company_name,
      client_email: form.email,
      client_phone: form.phone,
      referral_code_used: partner.referral_code,
      status: 'signed_up',
      signup_date: new Date().toISOString(),
      commission_rate: partner.commission_rate || 20,
    });

    // Update partner referral count
    await apiClient.Partner.update(partner.id, {
      total_referrals: (partner.total_referrals || 0) + 1,
    });

    setSubmitted(true);
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!partner) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-8 pb-8">
            <h2 className="text-xl font-bold mb-2">Invalid Referral Link</h2>
            <p className="text-gray-600">This referral link is not valid. Please check with your partner for the correct link.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const brandColor = partner.brand_color || '#2563eb';
  const logo = partner.brand_logo_url || DEFAULT_LOGO;
  const tagline = partner.brand_tagline || `Recommended by ${partner.company_name || partner.name}`;

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: `linear-gradient(135deg, ${brandColor}08, ${brandColor}15)` }}>
        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          <Card className="max-w-md w-full text-center">
            <CardContent className="pt-8 pb-8">
              <CheckCircle2 className="w-16 h-16 mx-auto mb-4" style={{ color: brandColor }} />
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Thank You!</h2>
              <p className="text-gray-600 mb-4">Your interest has been recorded. Our team will contact you shortly to set up your Bolify AI account.</p>
              <Badge style={{ backgroundColor: `${brandColor}20`, color: brandColor }}>Referred by {partner.company_name || partner.name}</Badge>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: `linear-gradient(135deg, #f8fafc, ${brandColor}08)` }}>
      {/* Hero */}
      <div className="text-white py-16 px-4" style={{ background: `linear-gradient(135deg, ${brandColor}, ${brandColor}dd)` }}>
        <div className="max-w-4xl mx-auto text-center">
          <img src={logo} alt="Logo" className="h-14 mx-auto mb-6 object-contain brightness-0 invert" />
          <h1 className="text-3xl md:text-4xl font-bold mb-3">AI Voice Agents for Your Business</h1>
          <p className="text-lg opacity-90 max-w-2xl mx-auto">{tagline}</p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 -mt-8">
        {/* Features */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {FEATURES.map((f, i) => (
            <motion.div key={i} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: i * 0.1 }}>
              <Card className="text-center h-full">
                <CardContent className="pt-6">
                  <f.icon className="w-8 h-8 mx-auto mb-2" style={{ color: brandColor }} />
                  <p className="font-semibold text-sm text-gray-900">{f.title}</p>
                  <p className="text-xs text-gray-500 mt-1">{f.desc}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Signup Form */}
        <Card className="max-w-xl mx-auto mb-16">
          <CardHeader>
            <CardTitle>Get Started with Bolify AI</CardTitle>
            <CardDescription>Fill in your details and our team will set you up within 24 hours.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>Company Name *</Label>
                  <Input value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} placeholder="Your company" />
                </div>
                <div>
                  <Label>Contact Person</Label>
                  <Input value={form.contact_name} onChange={e => setForm({ ...form, contact_name: e.target.value })} placeholder="Your name" />
                </div>
                <div>
                  <Label>Email *</Label>
                  <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" />
                </div>
                <div>
                  <Label>Phone *</Label>
                  <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+91 98XXXXXXXX" />
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <Button type="submit" disabled={submitting} className="w-full h-11 text-base" style={{ backgroundColor: brandColor }}>
                {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Request Demo'}
              </Button>

              <p className="text-xs text-gray-400 text-center">
                Referred by <strong>{partner.company_name || partner.name}</strong> • Powered by Bolify AI
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}