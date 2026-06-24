import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Building2, Mail, Phone, User, ArrowRight, ArrowLeft, MapPin } from 'lucide-react';

export default function ProfileStep({ data, onChange, onNext, onBack, user }) {
  const handleSubmit = (e) => {
    e.preventDefault();
    onNext();
  };

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Building2 className="w-8 h-8 text-blue-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Set Up Your Profile</h2>
        <p className="text-gray-500 mt-2">Tell us about your business so we can personalize your experience</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label htmlFor="company_name">Company Name *</Label>
          <Input
            id="company_name"
            value={data.company_name}
            onChange={(e) => onChange({ ...data, company_name: e.target.value })}
            placeholder="Acme Corp"
            required
            className="mt-1"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="full_name">Your Name</Label>
            <Input
              id="full_name"
              value={user?.full_name || ''}
              disabled
              className="mt-1 bg-gray-50"
            />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={data.email}
              disabled
              className="mt-1 bg-gray-50"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="phone">Phone Number *</Label>
          <Input
            id="phone"
            value={data.phone}
            onChange={(e) => onChange({ ...data, phone: e.target.value })}
            placeholder="+91 98765 43210"
            required
            className="mt-1"
          />
        </div>

        <div>
          <Label htmlFor="registered_address">Registered Business Address *</Label>
          <Textarea
            id="registered_address"
            value={data.registered_address || ''}
            onChange={(e) => onChange({ ...data, registered_address: e.target.value })}
            placeholder="Full registered address including city, state, and PIN code"
            required
            className="mt-1 min-h-[80px]"
          />
        </div>

        <div>
          <Label htmlFor="company_type">Business Entity Type *</Label>
          <Select
            value={data.company_type || ''}
            onValueChange={(value) => onChange({ ...data, company_type: value })}
            required
          >
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select your business type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="proprietorship">Proprietorship</SelectItem>
              <SelectItem value="partnership">Partnership Firm</SelectItem>
              <SelectItem value="llp">LLP (Limited Liability Partnership)</SelectItem>
              <SelectItem value="private_limited">Private Limited Company</SelectItem>
              <SelectItem value="public_limited">Public Limited Company</SelectItem>
              <SelectItem value="one_person_company">One Person Company (OPC)</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-3">
          {onBack && (
            <Button type="button" variant="outline" onClick={onBack} className="flex-1 h-12">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back
            </Button>
          )}
          <Button
            type="submit"
            disabled={!data.registered_address?.trim() || !data.company_type}
            className="flex-1 bg-blue-600 hover:bg-blue-700 h-12 text-base"
          >
            Continue <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </form>
    </div>
  );
}