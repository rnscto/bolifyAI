import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { AlertTriangle, Lock, CreditCard, Clock, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';

/**
 * Full-screen lockout shown when a client account is not in a usable state.
 * States blocked: expired | suspended | activation_pending
 * Allowed escape pages: ClientSubscription, ClientSettings, ClientCallbacks (read-only billing/help)
 */
export default function AccountStatusGate({ client, currentPageName }) {
  const location = useLocation();
  const status = client?.account_status;

  // Pages the user is ALLOWED to visit even when locked (so they can pay/renew/see info)
  const allowedPages = ['ClientSubscription', 'ClientSettings'];
  if (allowedPages.includes(currentPageName)) return null;

  const config = {
    expired: {
      icon: Clock,
      color: 'red',
      title: 'Your trial has expired',
      message: 'Your 7-day free trial has ended. Subscribe to a plan or top up your wallet to continue using the platform.',
      cta: 'Subscribe Now',
    },
    suspended: {
      icon: Lock,
      color: 'red',
      title: 'Account suspended',
      message: 'Your account has been suspended due to a pending renewal payment. Please renew your subscription to restore access.',
      cta: 'Renew Subscription',
    },
    activation_pending: {
      icon: AlertTriangle,
      color: 'amber',
      title: 'Activation pending admin approval',
      message: 'Your payment proof has been submitted. Our team will activate your account shortly. You will receive an email once activated.',
      cta: 'View Subscription',
    },
  }[status];

  if (!config) return null;

  const Icon = config.icon;
  const ringColor = config.color === 'amber' ? 'ring-amber-200' : 'ring-red-200';
  const iconBg = config.color === 'amber' ? 'bg-amber-100' : 'bg-red-100';
  const iconColor = config.color === 'amber' ? 'text-amber-600' : 'text-red-600';
  const btnColor = config.color === 'amber' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700';

  return (
    <div className="fixed inset-0 z-[100] bg-gray-50/95 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className={`bg-white max-w-lg w-full rounded-2xl shadow-2xl ring-4 ${ringColor} p-8`}>
        <div className={`mx-auto w-16 h-16 rounded-full ${iconBg} flex items-center justify-center mb-5`}>
          <Icon className={`w-8 h-8 ${iconColor}`} />
        </div>

        <h2 className="text-2xl font-bold text-gray-900 text-center mb-2">{config.title}</h2>
        <p className="text-gray-600 text-center mb-6">{config.message}</p>

        {client?.company_name && (
          <div className="bg-gray-50 rounded-lg p-3 mb-6 text-center text-sm text-gray-700">
            Account: <span className="font-medium">{client.company_name}</span>
            {client.email && <span className="text-gray-500"> · {client.email}</span>}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <Link to={createPageUrl('ClientSubscription')} state={{ from: location.pathname }}>
            <Button className={`w-full ${btnColor} text-white`} size="lg">
              <CreditCard className="w-4 h-4 mr-2" />
              {config.cta}
            </Button>
          </Link>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => base44.auth.logout()}
          >
            <LogOut className="w-4 h-4 mr-2" />
            Log out
          </Button>
        </div>

        <p className="text-xs text-gray-500 text-center mt-6">
          Need help? Email <a href="mailto:support@bolify.ai" className="text-cyan-600 hover:underline">support@bolify.ai</a>
        </p>
      </div>
    </div>
  );
}