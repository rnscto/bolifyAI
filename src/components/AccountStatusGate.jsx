import React from 'react';
import { AlertTriangle, Lock, Clock, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/api/apiClient';

/**
 * Full-screen lockout shown when a client account is not in a usable state.
 * States blocked: expired | suspended | activation_pending
 * Allowed escape pages: ClientSettings (so user can see profile / contact info)
 * Subscription / renewal / activation is admin-managed — contact support.
 */
export default function AccountStatusGate({ client, currentPageName }) {
  const status = client?.account_status;

  // Pages the user is ALLOWED to visit even when locked
  const allowedPages = ['ClientSettings'];
  if (allowedPages.includes(currentPageName)) return null;

  const config = {
    expired: {
      icon: Clock,
      color: 'red',
      title: 'Your trial has expired',
      message: 'Your 7-day free trial has ended. Please contact our team to activate a paid plan.',
    },
    suspended: {
      icon: Lock,
      color: 'red',
      title: 'Account suspended',
      message: 'Your account has been suspended due to a pending renewal payment. Please contact our team to restore access.',
    },
    activation_pending: {
      icon: AlertTriangle,
      color: 'amber',
      title: 'Activation pending admin approval',
      message: 'Your payment proof has been submitted. Our team will activate your account shortly. You will receive an email once activated.',
    },
  }[status];

  if (!config) return null;

  const Icon = config.icon;
  const ringColor = config.color === 'amber' ? 'ring-amber-200' : 'ring-red-200';
  const iconBg = config.color === 'amber' ? 'bg-amber-100' : 'bg-red-100';
  const iconColor = config.color === 'amber' ? 'text-amber-600' : 'text-red-600';

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
          <Button
            variant="outline"
            className="w-full"
            onClick={() => apiClient.auth.logout()}
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