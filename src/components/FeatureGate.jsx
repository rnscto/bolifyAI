import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Lock, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function FeatureGate({ client, featureName, children }) {
  // Allow if active or trial
  if (client && ['active', 'trial'].includes(client.account_status)) {
    return <>{children}</>;
  }

  // Block expired/suspended users
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <Card className="max-w-md w-full text-center">
        <CardContent className="pt-8 pb-8 space-y-4">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto">
            <Lock className="w-8 h-8 text-red-500" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">Feature Locked</h2>
            <p className="text-gray-500 mt-2 text-sm">
              {client?.account_status === 'expired'
                ? 'Your free trial has expired. Subscribe to access '
                : 'An active subscription is required to access '}
              <strong>{featureName || 'this feature'}</strong>.
            </p>
          </div>
          <p className="text-xs text-gray-400">
            All your data and agent configurations are safe and will be restored once you subscribe.
          </p>
          <Link to={createPageUrl('ClientSubscription')}>
            <Button className="w-full bg-gradient-to-r from-[#e67e22] to-[#f39c12] text-white font-semibold">
              Subscribe Now <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}