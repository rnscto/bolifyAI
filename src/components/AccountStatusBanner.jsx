import React from 'react';
import { Clock, ArrowRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';

/**
 * Unified status banner. Renders for trial (with days-left countdown) and for
 * accounts in 'activation_pending' state. Hard-blocked states (expired/suspended)
 * are handled by AccountStatusGate, so we skip them here.
 */
export default function AccountStatusBanner({ client }) {
  if (!client) return null;
  const status = client.account_status;

  if (status === 'activation_pending') {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-medium text-amber-800">
            Activation pending admin approval. You'll get email confirmation once activated.
          </span>
        </div>
      </div>
    );
  }

  if (status === 'trial' && client.trial_end_date) {
    const trialEnd = new Date(client.trial_end_date);
    const daysLeft = Math.max(0, Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24)));
    if (daysLeft <= 0) return null; // gate will handle this
    const urgent = daysLeft <= 2;
    return (
      <div className={`${urgent ? 'bg-orange-50 border-orange-200' : 'bg-blue-50 border-blue-200'} border rounded-lg px-4 py-3 flex items-center justify-between mb-4`}>
        <div className="flex items-center gap-2">
          <Clock className={`w-4 h-4 ${urgent ? 'text-orange-600' : 'text-blue-600'}`} />
          <span className={`text-sm font-medium ${urgent ? 'text-orange-800' : 'text-blue-800'}`}>
            Free trial: <strong>{daysLeft} day{daysLeft !== 1 ? 's' : ''} left</strong>
          </span>
        </div>
        <Link to={createPageUrl('ClientSubscription')}>
          <Button size="sm" variant="outline" className={urgent ? 'border-orange-300 text-orange-700 hover:bg-orange-100' : 'border-blue-300 text-blue-700 hover:bg-blue-100'}>
            View Plans <ArrowRight className="w-3 h-3 ml-1" />
          </Button>
        </Link>
      </div>
    );
  }

  return null;
}