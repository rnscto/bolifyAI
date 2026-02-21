import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Loader2, Users, IndianRupee, TrendingUp, Handshake } from 'lucide-react';
import { motion } from 'framer-motion';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";

const BENEFITS = [
  { icon: IndianRupee, title: '20% Revenue Share', desc: 'Earn 20% recurring commission on every client you refer' },
  { icon: TrendingUp, title: 'Recurring Income', desc: 'Earn every month as long as your referral stays active' },
  { icon: Users, title: 'Partner Dashboard', desc: 'Track referrals, commissions, and payouts in real-time' },
  { icon: Handshake, title: 'Dedicated Support', desc: 'Priority support and sales materials to help you close deals' },
];

export default function PartnerSignup() {
  const [form, setForm] = useState({
    name: '', email: '', phone: '', company_name: '', city: '', state: '', gst_number: '', pan_number: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.phone) {
      setError('Please fill in name, email, and phone.');
      return;
    }
    setSubmitting(true);
    setError('');

    // Generate referral code
    const code = 'VAANI-' + form.name.split(' ')[0].toUpperCase().substring(0, 6) + Math.floor(1000 + Math.random() * 9000);
    const referralLink = `${window.location.origin}?ref=${code}`;

    await base44.entities.Partner.create({
      ...form,
      referral_code: code,
      referral_link: referralLink,
      status: 'pending',
      commission_rate: 20
    });

    setSubmitted(true);
    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          <Card className="max-w-md w-full text-center">
            <CardContent className="pt-8 pb-8">
              <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Application Submitted!</h2>
              <p className="text-gray-600 mb-4">Thank you for your interest in the VaaniAI Partner Program. Our team will review your application and get back to you within 24-48 hours.</p>
              <Badge className="bg-yellow-100 text-yellow-800">Pending Approval</Badge>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#1a365d] to-[#2563eb] text-white py-16 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <img src={LOGO_URL} alt="VaaniAI" className="h-16 mx-auto mb-6 brightness-0 invert" />
          <h1 className="text-3xl md:text-4xl font-bold mb-3">VaaniAI Partner Program</h1>
          <p className="text-lg text-blue-100 max-w-2xl mx-auto">Earn 20% recurring revenue by referring businesses to India's #1 AI Voice Agent platform</p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 -mt-8">
        {/* Benefits */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {BENEFITS.map((b, i) => (
            <motion.div key={i} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: i * 0.1 }}>
              <Card className="text-center h-full">
                <CardContent className="pt-6">
                  <b.icon className="w-8 h-8 text-blue-600 mx-auto mb-2" />
                  <p className="font-semibold text-sm text-gray-900">{b.title}</p>
                  <p className="text-xs text-gray-500 mt-1">{b.desc}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Signup Form */}
        <Card className="max-w-2xl mx-auto mb-16">
          <CardHeader>
            <CardTitle>Apply as a Channel Partner</CardTitle>
            <CardDescription>Fill in your details below. We'll review and approve your application.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>Full Name *</Label>
                  <Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Your full name" />
                </div>
                <div>
                  <Label>Email *</Label>
                  <Input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} placeholder="you@email.com" />
                </div>
                <div>
                  <Label>Phone *</Label>
                  <Input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="+91 98XXXXXXXX" />
                </div>
                <div>
                  <Label>Company / Agency Name</Label>
                  <Input value={form.company_name} onChange={e => setForm({...form, company_name: e.target.value})} placeholder="Your company name" />
                </div>
                <div>
                  <Label>City</Label>
                  <Input value={form.city} onChange={e => setForm({...form, city: e.target.value})} placeholder="Mumbai" />
                </div>
                <div>
                  <Label>State</Label>
                  <Input value={form.state} onChange={e => setForm({...form, state: e.target.value})} placeholder="Maharashtra" />
                </div>
                <div>
                  <Label>GST Number</Label>
                  <Input value={form.gst_number} onChange={e => setForm({...form, gst_number: e.target.value})} placeholder="Optional" />
                </div>
                <div>
                  <Label>PAN Number</Label>
                  <Input value={form.pan_number} onChange={e => setForm({...form, pan_number: e.target.value})} placeholder="Optional" />
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <Button type="submit" disabled={submitting} className="w-full bg-gradient-to-r from-[#1a365d] to-[#2563eb] h-11 text-base">
                {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Submit Application'}
              </Button>

              <p className="text-xs text-gray-400 text-center">By applying, you agree to VaaniAI's partner terms and conditions.</p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}