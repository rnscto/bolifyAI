import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { User, ArrowRight, ArrowLeft } from 'lucide-react';

export default function PersonalProfileStep({ data, onChange, onNext, onBack, user }) {
  const handleSubmit = (e) => {
    e.preventDefault();
    onNext();
  };

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 bg-purple-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <User className="w-8 h-8 text-purple-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Your Personal Details</h2>
        <p className="text-gray-500 mt-2">Set up your AI personal call assistant</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="full_name">Your Name</Label>
            <Input id="full_name" value={user?.full_name || ''} disabled className="mt-1 bg-gray-50" />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={data.email} disabled className="mt-1 bg-gray-50" />
          </div>
        </div>

        <div>
          <Label htmlFor="phone">Your Phone Number *</Label>
          <Input
            id="phone"
            value={data.phone}
            onChange={(e) => onChange({ ...data, phone: e.target.value })}
            placeholder="+91 98765 43210"
            required
            className="mt-1"
          />
          <p className="text-xs text-gray-400 mt-1">Calls to your AI assistant's number will be screened for you</p>
        </div>

        <div>
          <Label htmlFor="whatsapp">WhatsApp Number (for real-time notifications) *</Label>
          <Input
            id="whatsapp"
            value={data.owner_whatsapp_number || ''}
            onChange={(e) => onChange({ ...data, owner_whatsapp_number: e.target.value })}
            placeholder="+91 98765 43210 (same as phone or different)"
            required
            className="mt-1"
          />
          <p className="text-xs text-gray-400 mt-1">You'll get live call updates and can instruct your AI via WhatsApp</p>
        </div>

        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={onBack} className="flex-1 h-12">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          <Button
            type="submit"
            disabled={!data.phone?.trim() || !data.owner_whatsapp_number?.trim()}
            className="flex-1 bg-purple-600 hover:bg-purple-700 h-12 text-base text-white"
          >
            Continue <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </form>
    </div>
  );
}