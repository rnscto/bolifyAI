import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import TrialBanner from '../components/TrialBanner';
import PlanSelector from '../components/subscription/PlanSelector';
import ActiveSubscription from '../components/subscription/ActiveSubscription';
import PaymentHistory from '../components/subscription/PaymentHistory';

export default function ClientSubscription() {
  const [client, setClient] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [channels, setChannels] = useState(1);
  const [includeCRM, setIncludeCRM] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  // Check for return from payment
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order_id');
    const status = params.get('status');

    if (orderId) {
      verifyPayment(orderId);
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });

    if (clients.length > 0) {
      const clientData = clients[0];
      setClient(clientData);
      setChannels(clientData.total_channels || 1);
      setIncludeCRM(clientData.has_custom_crm || false);

      const [subs, pays] = await Promise.all([
        base44.entities.Subscription.filter({ client_id: clientData.id }),
        base44.entities.Payment.filter({ client_id: clientData.id }, '-created_date', 20),
      ]);

      if (subs.length > 0) setSubscription(subs[0]);
      setPayments(pays);
    }
    setLoading(false);
  };

  const verifyPayment = async (orderId) => {
    setVerifying(true);
    const response = await base44.functions.invoke('verifyPayment', { order_id: orderId });
    
    if (response.data.status === 'paid') {
      toast.success('Payment successful! Your subscription is now active.');
      await loadData(); // Refresh everything
    } else if (response.data.status === 'failed') {
      toast.error('Payment failed. Please try again.');
    } else {
      toast.info('Payment is being processed. Please wait a moment.');
    }
    setVerifying(false);
  };

  const handleSubscribe = async () => {
    setPaying(true);
    const response = await base44.functions.invoke('createPaymentOrder', {
      channels,
      plan_type: 'quarterly',
      include_crm: includeCRM,
    });

    const { payment_session_id, environment } = response.data;

    if (!payment_session_id) {
      toast.error('Failed to create payment order. Please try again.');
      setPaying(false);
      return;
    }

    // Load Cashfree JS SDK and redirect
    const sdkUrl = environment === 'production'
      ? 'https://sdk.cashfree.com/js/v3/cashfree.js'
      : 'https://sdk.cashfree.com/js/v3/cashfree.js';

    if (!window.Cashfree) {
      const script = document.createElement('script');
      script.src = sdkUrl;
      script.async = true;
      script.onload = () => initCashfreeCheckout(payment_session_id, environment);
      document.body.appendChild(script);
    } else {
      initCashfreeCheckout(payment_session_id, environment);
    }
  };

  const initCashfreeCheckout = (sessionId, environment) => {
    const cashfree = window.Cashfree({
      mode: environment === 'production' ? 'production' : 'sandbox',
    });

    cashfree.checkout({
      paymentSessionId: sessionId,
      redirectTarget: '_self',
    });

    setPaying(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (verifying) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <p className="text-gray-600 font-medium">Verifying your payment...</p>
      </div>
    );
  }

  const isActive = client?.account_status === 'active' && subscription?.status === 'active';
  const isTrial = client?.account_status === 'trial';
  const isExpired = client?.account_status === 'expired';

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <TrialBanner client={client} />

      <div>
        <h1 className="text-3xl font-bold text-gray-900">Subscription</h1>
        <p className="text-gray-600 mt-1">
          {isActive ? 'Manage your active subscription' : 'Subscribe to continue using VaaniAI'}
        </p>
      </div>

      {/* Show expired warning */}
      {isExpired && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-red-800">Your trial has expired</p>
            <p className="text-sm text-red-700 mt-1">Subscribe now to regain access to all features.</p>
          </div>
        </div>
      )}

      {/* Active subscription view */}
      {isActive && (
        <ActiveSubscription client={client} subscription={subscription} />
      )}

      {/* Plan selector for trial/expired users */}
      {(isTrial || isExpired || !isActive) && (
        <PlanSelector
          channels={channels}
          setChannels={setChannels}
          includeCRM={includeCRM}
          setIncludeCRM={setIncludeCRM}
          onSubscribe={handleSubscribe}
          loading={paying}
        />
      )}

      {/* Payment History */}
      <PaymentHistory payments={payments} />
    </div>
  );
}