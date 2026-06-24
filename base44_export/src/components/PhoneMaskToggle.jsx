import React from 'react';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff } from 'lucide-react';
import { usePhoneMask } from '@/lib/phoneMask';

// Reusable toggle button — drop this anywhere on a page that displays phone
// numbers. Persists per-device via localStorage. Default state: phones VISIBLE.
//
// When ON  (icon = EyeOff): last 5 digits of phone numbers are hidden as XXXXX
// When OFF (icon = Eye)   : phone numbers are shown in full
export default function PhoneMaskToggle({ className = '' }) {
  const { enabled, toggle } = usePhoneMask();

  return (
    <Button
      type="button"
      variant={enabled ? 'default' : 'outline'}
      size="sm"
      onClick={toggle}
      className={`gap-1.5 ${enabled ? 'bg-amber-600 hover:bg-amber-700 text-white' : ''} ${className}`}
      title={enabled
        ? 'Phone numbers are HIDDEN (last 5 digits masked). Click to show.'
        : 'Hide phone numbers for screen sharing / demo'}
    >
      {enabled ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      {enabled ? 'Phones Hidden' : 'Hide Phones'}
    </Button>
  );
}