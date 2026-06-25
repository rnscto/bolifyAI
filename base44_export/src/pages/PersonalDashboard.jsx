import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import TrialBanner from '../components/TrialBanner';
import CallSummaryCards from '../components/personal/CallSummaryCards';
import RecentCallList from '../components/personal/RecentCallList';
import QuickActionsPanel from '../components/personal/QuickActionsPanel';
import TrustedContactsList from '../components/personal/TrustedContactsList';
import VoicemailInbox from '../components/personal/VoicemailInbox';
import PersonalAnalytics from '../components/personal/PersonalAnalytics';
import NotificationSettings from '../components/personal/NotificationSettings';
import CallForwardingGuide from '../components/personal/CallForwardingGuide';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function PersonalDashboard() {
  const [user, setUser] = useState(null);
  const [client, setClient] = useState(null);
  const [calls, setCalls] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  // Live updates via WebSocket subscriptions — replaces the old 60s polling loop.
  // No integration credits, no repeated reads. Patches calls + voicemails in place.
  useEffect(() => {
    if (!client?.id) return;
    const unsubCalls = base44.entities.CallLog.subscribe((event) => {
      if (event.data?.client_id !== client.id) return;
      if (event.type === 'create') {
        setCalls(prev => (prev.some(c => c.id === event.id) ? prev : [event.data, ...prev]));
      } else if (event.type === 'update') {
        setCalls(prev => prev.map(c => (c.id === event.id ? { ...c, ...event.data } : c)));
      } else if (event.type === 'delete') {
        setCalls(prev => prev.filter(c => c.id !== event.id));
      }
    });
    const unsubVoicemails = base44.entities.VoicemailMessage.subscribe((event) => {
      if (event.data?.client_id !== client.id) return;
      if (event.type === 'create') {
        setMessages(prev => (prev.some(m => m.id === event.id) ? prev : [event.data, ...prev]));
      } else if (event.type === 'update') {
        setMessages(prev => prev.map(m => (m.id === event.id ? { ...m, ...event.data } : m)));
      } else if (event.type === 'delete') {
        setMessages(prev => prev.filter(m => m.id !== event.id));
      }
    });
    return () => { unsubCalls(); unsubVoicemails(); };
  }, [client?.id]);

  const loadData = async () => {
    try {
      const currentUser = await base44.auth.me();
      setUser(currentUser);

      const clients = await base44.entities.Client.filter({ user_id: currentUser.id });
      if (clients.length > 0) {
        setClient(clients[0]);
        const [callLogs, trustedContacts, voicemails] = await Promise.all([
          base44.entities.CallLog.filter({ client_id: clients[0].id }, '-created_at', 100),
          base44.entities.TrustedContact.filter({ client_id: clients[0].id }),
          base44.entities.VoicemailMessage.filter({ client_id: clients[0].id }, '-created_at', 50)
        ]);
        setCalls(callLogs);
        setContacts(trustedContacts);
        setMessages(voicemails);
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

  const unreadMessages = messages.filter(m => !m.is_read).length;

  return (
    <div className="space-y-6">
      <TrialBanner client={client} />

      <div>
        <h1 className="text-3xl font-bold text-gray-900">
          Hi, {user?.display_name || user?.data?.display_name || user?.full_name} 👋
        </h1>
        <p className="text-gray-600 mt-1">Your AI assistant is screening your calls</p>
      </div>

      <CallSummaryCards calls={calls} />

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="messages" className="relative">
            Messages
            {unreadMessages > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold bg-purple-600 text-white rounded-full">
                {unreadMessages}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="setup">Setup</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <RecentCallList calls={calls} />
            </div>
            <div>
              <QuickActionsPanel client={client} onUpdate={setClient} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="messages">
          <VoicemailInbox messages={messages} onRefresh={loadData} />
        </TabsContent>

        <TabsContent value="contacts">
          <TrustedContactsList
            contacts={contacts}
            clientId={client?.id}
            onRefresh={loadData}
          />
        </TabsContent>

        <TabsContent value="analytics">
          <PersonalAnalytics calls={calls} />
        </TabsContent>

        <TabsContent value="setup">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <CallForwardingGuide client={client} />
            <NotificationSettings client={client} onUpdate={setClient} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}