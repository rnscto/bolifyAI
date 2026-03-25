import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import TrialBanner from '../components/TrialBanner';
import CallSummaryCards from '../components/personal/CallSummaryCards';
import RecentCallList from '../components/personal/RecentCallList';
import QuickActionsPanel from '../components/personal/QuickActionsPanel';

export default function PersonalDashboard() {
  const [user, setUser] = useState(null);
  const [client, setClient] = useState(null);
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const currentUser = await base44.auth.me();
      setUser(currentUser);

      const clients = await base44.entities.Client.filter({ user_id: currentUser.id });
      if (clients.length > 0) {
        setClient(clients[0]);
        const callLogs = await base44.entities.CallLog.filter(
          { client_id: clients[0].id },
          '-created_date',
          100
        );
        setCalls(callLogs);
      }
    } catch (error) {
      console.error('Error loading personal dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TrialBanner client={client} />

      <div>
        <h1 className="text-3xl font-bold text-gray-900">
          Hi, {user?.full_name} 👋
        </h1>
        <p className="text-gray-600 mt-1">Your AI assistant is screening your calls</p>
      </div>

      <CallSummaryCards calls={calls} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RecentCallList calls={calls} />
        </div>
        <div>
          <QuickActionsPanel client={client} onUpdate={setClient} />
        </div>
      </div>
    </div>
  );
}