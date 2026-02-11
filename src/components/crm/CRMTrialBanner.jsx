import React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Clock, CreditCard } from 'lucide-react';

export default function CRMTrialBanner({ client }) {
  if (!client?.has_custom_crm || client.crm_subscription_status !== 'trialing') return null;

  const trialEnd = new Date(client.crm_trial_end_date);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
  const expired = daysLeft <= 0;

  if (expired) {
    return (
      <Alert className="bg-red-50 border-red-200 mb-6">
        <AlertDescription className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-red-600" />
            <span className="text-red-800 font-medium">Your CRM trial has expired. Subscribe to continue using CRM features.</span>
          </div>
          <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white">
            Subscribe Now — ₹1,999/mo
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="bg-indigo-50 border-indigo-200 mb-6">
      <AlertDescription className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-indigo-600" />
        <span className="text-indigo-800">
          <strong>{daysLeft} day{daysLeft !== 1 ? 's' : ''}</strong> left in your free CRM trial
        </span>
      </AlertDescription>
    </Alert>
  );
}