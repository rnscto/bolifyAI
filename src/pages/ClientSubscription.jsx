import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { AlertCircle, Wallet } from 'lucide-react';
import TrialBanner from '../components/TrialBanner';
import PlanSelector from '../components/subscription/PlanSelector';
import ActiveSubscription from '../components/subscription/ActiveSubscription';
import PaymentHistory from '../components/subscription/PaymentHistory';
import WalletCard from '../components/subscription/WalletCard';
import TopupSection from '../components/subscription/TopupSection';
import UsageHistory from '../components/subscription/UsageHistory';

export default function ClientSubscription() {
  const [client, setClient] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [channels, setChannels] = useState(1);
  const [includeCRM, setIncludeCRM] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order_id');
    if (orderId) {
      verifyPayment(orderId);
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
        base44.entities.Subscription.filter({ client_id: clientData.id }, '-created_date', 10),
        base44.entities.Payment.filter({ client_id: clientData.id }, '-created_date', 20),
      ]);

      const activeSub = subs.find(s => s.status === 'active') || subs[0];
      if (activeSub) setSubscription(activeSub);
      setPayments(pays);
    }
    setLoading(false);
  };

  const verifyPayment = async (orderId) => {
    setVerifying(true);
    const response = await base44.functions.invoke('verifyPayment', { order_id: orderId });
    
    if (response.data.status === 'paid') {
      if (response.data.type === 'wallet_topup') {
        toast.success(`Wallet topped up! New balance: ₹${response.data.new_balance?.toLocaleString()}`);
      } else {
        toast.success('Payment successful! Your subscription is now active.');
      }
      await loadData();
    } else if (response.data.status === 'failed') {
      toast.error('Payment failed. Please try again.');
    } else {
      toast.info('Payment is being processed. Please wait a moment.');
    }
    setVerifying(false);
  };

  const initCashfreeCheckout = (sessionId, environment) => {
    const cashfree = window.Cashfree({
      mode: environment === 'production' ? 'production' : 'sandbox',
    });
    cashfree.checkout({ paymentSessionId: sessionId, redirectTarget: '_self' });
    setPaying(false);
  };

  const loadCashfreeAndCheckout = (sessionId, environment) => {
    const sdkUrl = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    if (!window.Cashfree) {
      const script = document.createElement('script');
      script.src = sdkUrl;
      script.async = true;
      script.onload = () => initCashfreeCheckout(sessionId, environment);
      document.body.appendChild(script);
    } else {
      initCashfreeCheckout(sessionId, environment);
    }
  };

  const handleTopup = async (amount) => {
    setPaying(true);
    const response = await base44.functions.invoke('createTopupOrder', { amount });
    const { payment_session_id, environment } = response.data;
    if (!payment_session_id) {
      toast.error(response.data.error || 'Failed to create top-up order.');
      setPaying(false);
      return;
    }
    loadCashfreeAndCheckout(payment_session_id, environment);
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
    loadCashfreeAndCheckout(payment_session_id, environment);
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
  const isPerMinute = client?.billing_type !== 'unlimited';
  const isUnlimited = client?.billing_type === 'unlimited';

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <TrialBanner client={client} />

      <div>
        <h1 className="text-3xl font-bold text-gray-900">Subscription & Wallet</h1>
        <p className="text-gray-600 mt-1">
          {isUnlimited && isActive
            ? 'Manage your unlimited subscription'
            : 'Manage your calling wallet and plans'
          }
        </p>
      </div>

      {/* Expired warning */}
      {isExpired && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-red-800">Your trial has expired</p>
            <p className="text-sm text-red-700 mt-1">Top up your wallet or subscribe to an unlimited plan to continue.</p>
          </div>
        </div>
      )}

      {/* Low balance warning for per-minute users */}
      {isPerMinute && (client?.wallet_balance || 0) < 100 && (client?.free_minutes_remaining || 0) <= 0 && !isExpired && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <Wallet className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-amber-800">Low wallet balance</p>
            <p className="text-sm text-amber-700 mt-1">
              Minimum ₹100 balance required to make calls. Top up now to continue calling.
            </p>
          </div>
        </div>
      )}

      {/* Wallet overview (for per-minute billing) */}
      {isPerMinute && <WalletCard client={client} />}

      {/* Active unlimited subscription view */}
      {isUnlimited && isActive && (
        <ActiveSubscription client={client} subscription={subscription} />
      )}

      {/* Top-up section (always visible for per-minute) */}
      {isPerMinute && (
        <TopupSection
          onTopup={handleTopup}
          loading={paying}
          rate={client?.per_minute_rate || 4}
        />
      )}

      {/* Plan selector — upgrade to unlimited */}
      {(isTrial || isExpired || (!isActive && !isPerMinute)) && (
        <>
          <div className="relative flex items-center py-2">
            <div className="flex-grow border-t border-gray-200"></div>
            <span className="mx-4 text-sm text-gray-400 font-medium">Or upgrade to Unlimited Plan</span>
            <div className="flex-grow border-t border-gray-200"></div>
          </div>
          <PlanSelector
            channels={channels}
            setChannels={setChannels}
            includeCRM={includeCRM}
            setIncludeCRM={setIncludeCRM}
            onSubscribe={handleSubscribe}
            loading={paying}
          />
        </>
      )}

      {/* Usage history (for per-minute) */}
      {isPerMinute && client?.id && <UsageHistory clientId={client.id} />}

      {/* Payment History */}
      <PaymentHistory payments={payments} />
    </div>
  );
}