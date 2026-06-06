import React from 'react';
import { Clock } from 'lucide-react';

export default function TrialBanner({ client }) {
  if (!client || !['trial', 'expired'].includes(client.account_status)) return null;

  if (client.account_status === 'expired') {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-red-600" />
          <span className="text-sm font-medium text-red-800">
            Your free trial has expired. Please contact our team to activate a paid plan.
          </span>
        </div>
      </div>
    );
  }

  const trialEnd = new Date(client.trial_end_date);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
  const isExpired = daysLeft <= 0;

  if (isExpired) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-red-600" />
          <span className="text-sm font-medium text-red-800">
            Your free trial has expired. Please contact our team to activate a paid plan.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 flex items-center mb-4">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-blue-600" />
        <span className="text-sm font-medium text-blue-800">
          Free trial: <strong>{daysLeft} day{daysLeft !== 1 ? 's' : ''} left</strong>
        </span>
      </div>
    </div>
  );
}