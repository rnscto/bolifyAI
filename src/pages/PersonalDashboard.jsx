import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import TrialBanner from '../components/TrialBanner';
import CallSummaryCards from '../components/personal/CallSummaryCards';
import RecentCallList from '../components/personal/RecentCallList';
import QuickActionsPanel from '../components/personal/QuickActionsPanel';
import TrustedContactsList from '../components/personal/TrustedContactsList';
import VoicemailInbox from '../components/personal/VoicemailInbox';
import PersonalAnalytics from '../components/personal/PersonalAnalytics';
import TelegramConnect from '../components/personal/TelegramConnect';
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
        const [callLogs, trustedContacts, voicemails] = await Promise.all([
          base44.entities.CallLog.filter({ client_id: clients[0].id }, '-created_date', 100),
          base44.entities.TrustedContact.filter({ client_id: clients[0].id }),
          base44.entities.VoicemailMessage.filter({ client_id: clients[0].id }, '-created_date', 50)
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
          Hi, {user?.full_name} 👋
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
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <RecentCallList calls={calls} />
            </div>
            <div className="space-y-6">
              <QuickActionsPanel client={client} onUpdate={setClient} />
              <TelegramConnect client={client} onUpdate={setClient} />
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
      </Tabs>
    </div>
  );
}