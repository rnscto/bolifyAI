import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { User, Mail, Phone, Briefcase, Mic } from 'lucide-react';

const SOLUTIONS = [
  'AI Voice Agent for Sales',
  'Automated Lead Qualification',
  'Appointment Booking Agent',
  'Customer Support Automation',
  'Bulk Campaign Calling',
  'Sales CRM',
  'e-Governance Solutions',
  'Other / Custom Solution',
];

export default function PreChatForm({ onStart }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', solution: '' });
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const isValid = form.name.trim() && (form.email.trim() || form.phone.trim());

  const handleStart = (e) => {
    e.preventDefault();
    if (!isValid) return;
    onStart(form);
  };

  return (
    <form onSubmit={handleStart} className="p-4 space-y-3 flex-1 overflow-y-auto">
      <div className="text-center mb-1">
        <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-blue-50 flex items-center justify-center">
          <Mic className="w-7 h-7 text-blue-500" />
        </div>
        <p className="text-sm font-semibold text-gray-800">Talk to VaaniAI</p>
        <p className="text-xs text-gray-500 mt-1 max-w-[260px] mx-auto">
          Share your details to get a personalized experience
        </p>
      </div>

      <div className="relative">
        <User className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Your Name *"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="pl-9 h-9 text-sm"
          required
        />
      </div>

      <div className="relative">
        <Mail className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
        <Input
          type="email"
          placeholder="Email Address *"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className="pl-9 h-9 text-sm"
        />
      </div>

      <div className="relative">
        <Phone className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Mobile Number"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          className="pl-9 h-9 text-sm"
        />
      </div>

      {/* Custom dropdown instead of Select to avoid z-index issues */}
      <div className="relative">
        <Briefcase className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 z-10" />
        <button
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="flex items-center w-full h-9 pl-9 pr-3 text-sm border border-input rounded-md bg-transparent text-left focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <span className={form.solution ? 'text-gray-900' : 'text-muted-foreground'}>
            {form.solution || 'Solution you\'re looking for'}
          </span>
        </button>
        {dropdownOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-[180px] overflow-y-auto">
            {SOLUTIONS.map(s => (
              <button
                key={s}
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors"
                onClick={() => { setForm({ ...form, solution: s }); setDropdownOpen(false); }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <Button
        type="submit"
        disabled={!isValid}
        className="w-full mt-2 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white rounded-full gap-2 shadow-lg shadow-green-200"
      >
        <Mic className="w-4 h-4" />
        Start Voice Chat
      </Button>

      <p className="text-[10px] text-gray-400 text-center">
        By starting, you agree to our terms & privacy policy
      </p>
    </form>
  );
}