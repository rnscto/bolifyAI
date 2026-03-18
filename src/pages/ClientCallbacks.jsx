import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Phone, RefreshCw, Calendar as CalendarIcon, List,
  AlertTriangle, Clock, CheckCircle2, ClipboardList
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import CallbackStats from '../components/callbacks/CallbackStats';
import CallbackList from '../components/callbacks/CallbackList';
import CallbackCalendar from '../components/callbacks/CallbackCalendar';
import HumanTasksTab from '../components/callbacks/HumanTasksTab';

export default function ClientCallbacks() {
  const [callbacks, setCallbacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('list');
  const [filter, setFilter] = useState('all');
  const [clientId, setClientId] = useState(null);
  const [activeTab, setActiveTab] = useState('callbacks');

  const [isAdmin, setIsAdmin] = useState(false);
  const [allClients, setAllClients] = useState([]);

  useEffect(() => {
    loadClient();
  }, []);

  const loadClient = async () => {
    const user = await base44.auth.me();
    if (user.role === 'admin') {
      setIsAdmin(true);
      // Load all clients for admin selector
      const clients = await base44.entities.Client.filter({ status: 'active' });
      setAllClients(clients);
      if (clients.length > 0) {
        setClientId(clients[0].id);
        fetchCallbacks(clients[0].id);
      } else {
        setLoading(false);
      }
    } else {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (clients.length > 0) {
        setClientId(clients[0].id);
        fetchCallbacks(clients[0].id);
      }
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
      const res = await base44.functions.invoke('parseCallbacks', { client_id: cId });
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

  const handleCall = async (item) => {
    // Navigate to lead or trigger call
    window.open(`/ClientLeads?lead_id=${item.lead_id}`, '_self');
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Phone className="w-6 h-6 text-blue-600" />
            Callbacks & Tasks
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            AI-parsed follow-ups & tasks requiring your attention
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && allClients.length > 0 && (
            <Select value={clientId || ''} onValueChange={handleClientChange}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {allClients.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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