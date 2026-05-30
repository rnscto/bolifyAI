import React from 'react';
import { Clock, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function TrialBanner({ client }) {
  if (!client || !['trial', 'expired'].includes(client.account_status)) return null;

  if (client.account_status === 'expired') {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-red-600" />
          <span className="text-sm font-medium text-red-800">
            Your free trial has expired. Subscribe to continue using Bolify AI.
          </span>
        </div>
        <Link to={createPageUrl('ClientSubscription')}>
          <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white">
            Subscribe Now <ArrowRight className="w-3 h-3 ml-1" />
          </Button>
        </Link>
      </div>
    );
  }

  const trialEnd = new Date(client.trial_end_date);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
  const isExpired = daysLeft <= 0;

  if (isExpired) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-red-600" />
          <span className="text-sm font-medium text-red-800">
            Your free trial has expired. Subscribe to continue using Bolify AI.
          </span>
        </div>
        <Link to={createPageUrl('ClientSubscription')}>
          <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white">
            Subscribe Now <ArrowRight className="w-3 h-3 ml-1" />
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-blue-600" />
        <span className="text-sm font-medium text-blue-800">
          Free trial: <strong>{daysLeft} day{daysLeft !== 1 ? 's' : ''} left</strong>
        </span>
      </div>
      <Link to={createPageUrl('ClientSubscription')}>
        <Button size="sm" variant="outline" className="border-blue-300 text-blue-700 hover:bg-blue-100">
          View Plans <ArrowRight className="w-3 h-3 ml-1" />
        </Button>
      </Link>
    </div>
  );
}