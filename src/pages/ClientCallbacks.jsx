import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Phone, RefreshCw, Calendar as CalendarIcon, List,
  AlertTriangle, Clock, CheckCircle2, ClipboardList, Wand2
} from 'lucide-react';
import CallbackStats from '../components/callbacks/CallbackStats';
import CallbackList from '../components/callbacks/CallbackList';
import CallbackCalendar from '../components/callbacks/CallbackCalendar';
import HumanTasksTab from '../components/callbacks/HumanTasksTab';
import { toast } from 'sonner';

export default function ClientCallbacks() {
  const [callbacks, setCallbacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('list');
  const [filter, setFilter] = useState('all');
  const [clientId, setClientId] = useState(null);
  const [activeTab, setActiveTab] = useState('callbacks');
  const [callingLeadId, setCallingLeadId] = useState(null);
  const [backfilling, setBackfilling] = useState(false);

  const [isAdmin, setIsAdmin] = useState(false);
  const [allClients, setAllClients] = useState([]);

  useEffect(() => {
    loadClient();
  }, []);

  const loadClient = async () => {
    try {
      const user = await apiClient.auth.me();
      if (user.role === 'admin' || user.role === 'master_admin') {
        // Block admins explicitly as requested
        setLoading(false);
        return;
      }
      const clients = await apiClient.Client.filter({ user_id: user.id });
      if (clients.length > 0) {
        setClientId(clients[0].id);
        fetchCallbacks(clients[0].id);
      } else {
        setLoading(false);
      }
    } catch (err) {
      setError('Failed to load client');
      setLoading(false);
    }
  };

  const handleClientChange = (cId) => {
    setClientId(cId);
    fetchCallbacks(cId);
  };

  const fetchCallbacks = async (cId) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.functions.invoke('parseCallbacks', { client_id: cId });
      setCallbacks(res.data.callbacks || []);
    } catch (err) {
      console.error('Failed to load callbacks:', err);
      setError(err.message || 'Failed to load callbacks');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    if (clientId) fetchCallbacks(clientId);
  };

  const handleBackfill = async () => {
    if (!clientId || backfilling) return;
    setBackfilling(true);
    try {
      const res = await apiClient.functions.invoke('backfillCallbackActivities', { client_id: clientId });
      const d = res.data || {};
      if (d.success) {
        toast.success(`Backfilled: scanned ${d.scanned || 0} calls, queued ${d.extractor_invoked || 0} for AI extraction`);
        // Refresh after a short delay so newly-created Activities are picked up
        setTimeout(() => fetchCallbacks(clientId), 2500);
      } else {
        toast.error(d.error || 'Backfill failed');
      }
    } catch (err) {
      console.error('Backfill failed:', err);
      toast.error(err.message || 'Backfill failed');
    } finally {
      setBackfilling(false);
    }
  };

  const handleCall = async (item) => {
    if (!item?.lead_id || !clientId) {
      toast.error('Lead not linked — cannot call');
      return;
    }
    if (callingLeadId) return;

    setCallingLeadId(item.lead_id);
    try {
      // Find an active agent for this client
      const agents = await apiClient.Agent.filter({ client_id: clientId, status: 'active' });
      if (!agents || agents.length === 0) {
        toast.error('No active agent available. Activate an agent first.');
        setCallingLeadId(null);
        return;
      }

      const response = await apiClient.functions.invoke('initiateCall', {
        lead_id: item.lead_id,
        agent_id: agents[0].id,
        phone_number: item.lead_phone
      });

      if (response.data?.success) {
        toast.success(`Calling ${item.lead_name || item.lead_phone}...`);
        setTimeout(() => {
          setCallingLeadId(null);
          fetchCallbacks(clientId);
        }, 5000);
      } else {
        setCallingLeadId(null);
        toast.error(response.data?.error || 'Failed to initiate call');
      }
    } catch (err) {
      console.error('Callback call failed:', err);
      setCallingLeadId(null);
      toast.error(err.message || 'Failed to initiate call');
    }
  };

  const filterCounts = {
    all: callbacks.length,
    overdue: callbacks.filter(c => c.extracted?.callback_datetime && new Date(c.extracted.callback_datetime) < new Date()).length,
    today: callbacks.filter(c => {
      if (!c.extracted?.callback_datetime) return false;
      const d = new Date(c.extracted.callback_datetime);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    }).length,
    upcoming: callbacks.filter(c => c.extracted?.callback_datetime && new Date(c.extracted.callback_datetime) > new Date()).length,
    unscheduled: callbacks.filter(c => !c.extracted?.callback_datetime).length,
  };

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Phone className="w-6 h-6 text-blue-600" />
            Callbacks & Tasks
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            AI-parsed follow-ups & tasks requiring your attention
          </p>
        </div>
      </div>

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="callbacks" className="flex items-center gap-1.5">
            <Phone className="w-4 h-4" /> AI Callbacks
          </TabsTrigger>
          <TabsTrigger value="human_tasks" className="flex items-center gap-1.5">
            <ClipboardList className="w-4 h-4" /> Tasks (Human Attention)
          </TabsTrigger>
        </TabsList>

        <TabsContent value="callbacks" className="space-y-4 mt-4">
          {/* View toggle + refresh */}
          <div className="flex items-center gap-2 justify-end">
            <div className="flex border rounded-lg overflow-hidden">
              <button onClick={() => setView('list')}
                className={`px-3 py-2 text-sm flex items-center gap-1.5 ${view === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                <List className="w-4 h-4" /> List
              </button>
              <button onClick={() => setView('calendar')}
                className={`px-3 py-2 text-sm flex items-center gap-1.5 ${view === 'calendar' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                <CalendarIcon className="w-4 h-4" /> Calendar
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={handleBackfill} disabled={backfilling || loading} title="Scan past 30 days of calls and auto-schedule callbacks for any that requested one">
              <Wand2 className={`w-4 h-4 mr-1 ${backfilling ? 'animate-spin' : ''}`} /> {backfilling ? 'Backfilling…' : 'Backfill Past Calls'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>

          {/* Error */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          {/* Loading */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
              <p className="text-sm text-gray-500">Analyzing call transcripts for callbacks...</p>
            </div>
          ) : (
            <>
              <CallbackStats callbacks={callbacks} />

              {view === 'list' && (
                <div className="flex gap-2 flex-wrap">
                  {[
                    { key: 'all', label: 'All', icon: null },
                    { key: 'overdue', label: 'Overdue', icon: AlertTriangle },
                    { key: 'today', label: 'Today', icon: Clock },
                    { key: 'upcoming', label: 'Upcoming', icon: CalendarIcon },
                    { key: 'unscheduled', label: 'Unscheduled', icon: CheckCircle2 },
                  ].map(f => {
                    const Icon = f.icon;
                    return (
                      <button key={f.key} onClick={() => setFilter(f.key)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                          filter === f.key ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'}`}>
                        {Icon && <Icon className="w-3.5 h-3.5" />}
                        {f.label}
                        <span className={`ml-0.5 text-xs ${filter === f.key ? 'text-blue-200' : 'text-gray-400'}`}>{filterCounts[f.key]}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {view === 'list' ? (
                <CallbackList callbacks={callbacks} filter={filter} onCall={handleCall} />
              ) : (
                <CallbackCalendar callbacks={callbacks} onCall={handleCall} />
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="human_tasks" className="mt-4">
          {clientId ? (
            <HumanTasksTab clientId={clientId} />
          ) : (
            <div className="py-16 text-center text-gray-500">Loading client data...</div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}