import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Play, Pause, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import RetentionOverview from '../components/retention/RetentionOverview';
import RetentionSettings from '../components/retention/RetentionSettings';
import ObjectionHandlers from '../components/retention/ObjectionHandlers';
import RetentionCallLog from '../components/retention/RetentionCallLog';

export default function AdminRetention() {
  const [config, setConfig] = useState(null);
  const [dids, setDids] = useState([]);
  const [agents, setAgents] = useState([]);
  const [clients, setClients] = useState([]);
  const [callLogs, setCallLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [triggeringManual, setTriggeringManual] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const [configList, didsData, agentsData, clientsData, callLogsData] = await Promise.all([
      base44.entities.RetentionConfig.list('-created_date', 1),
      base44.entities.DID.list(),
      base44.entities.Agent.list(),
      base44.entities.Client.list(),
      base44.entities.CallLog.list('-created_date', 100),
    ]);

    setConfig(configList[0] || null);
    setDids(didsData);
    setAgents(agentsData);
    setClients(clientsData);
    setCallLogs(callLogsData);
    setLoading(false);
  };

  const handleSaveSettings = async (formData) => {
    setSaving(true);
    if (config) {
      await base44.entities.RetentionConfig.update(config.id, formData);
    } else {
      await base44.entities.RetentionConfig.create(formData);
    }
    toast.success('Retention settings saved');
    await loadData();
    setSaving(false);
  };

  const handleSaveHandlers = async (handlers) => {
    setSaving(true);
    if (config) {
      await base44.entities.RetentionConfig.update(config.id, { objection_handlers: handlers });
    } else {
      await base44.entities.RetentionConfig.create({ objection_handlers: handlers });
    }
    toast.success('Objection handlers saved');
    await loadData();
    setSaving(false);
  };

  const handleToggleSystem = async () => {
    const newState = config?.is_active === false;
    if (config) {
      await base44.entities.RetentionConfig.update(config.id, { is_active: newState });
    } else {
      await base44.entities.RetentionConfig.create({ is_active: newState });
    }
    toast.success(newState ? 'Retention system activated' : 'Retention system paused');
    loadData();
  };

  const handleManualTrigger = async () => {
    setTriggeringManual(true);
    const response = await base44.functions.invoke('retentionCall', { force: true });
    if (response.data?.success) {
      const initiated = response.data.calls_initiated?.length || 0;
      const errors = response.data.errors?.length || 0;
      toast.success(`Manual run complete: ${initiated} calls initiated, ${errors} errors`);
    } else {
      toast.error(response.data?.error || 'Failed to trigger');
    }
    setTriggeringManual(false);
    loadData();
  };

  const stats = {
    totalRetentionCalls: callLogs.filter(l => l.call_sid?.startsWith('ret_') || l.conversation_summary?.includes('Retention')).length,
    answeredCalls: callLogs.filter(l => (l.call_sid?.startsWith('ret_') || l.conversation_summary?.includes('Retention')) && (l.status === 'answered' || l.status === 'completed')).length,
    expiredClients: clients.filter(c => c.account_status === 'expired').length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Retention System</h1>
          <p className="text-gray-600 mt-1">Manage automated retention calls, offers, and AI instructions</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleToggleSystem}
            className={config?.is_active !== false ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-green-200 text-green-700 hover:bg-green-50'}
          >
            {config?.is_active !== false ? <><Pause className="w-4 h-4 mr-2" /> Pause System</> : <><Play className="w-4 h-4 mr-2" /> Activate System</>}
          </Button>
          <Button
            onClick={handleManualTrigger}
            disabled={triggeringManual}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <RotateCcw className={`w-4 h-4 mr-2 ${triggeringManual ? 'animate-spin' : ''}`} />
            {triggeringManual ? 'Running...' : 'Run Now'}
          </Button>
        </div>
      </div>

      <RetentionOverview config={config} stats={stats} />

      <Tabs defaultValue="settings" className="w-full">
        <TabsList>
          <TabsTrigger value="settings">Settings & DID Mapping</TabsTrigger>
          <TabsTrigger value="objections">Objection Handlers</TabsTrigger>
          <TabsTrigger value="logs">Call History</TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="mt-4">
          <RetentionSettings
            config={config}
            dids={dids}
            agents={agents}
            onSave={handleSaveSettings}
            saving={saving}
          />
        </TabsContent>

        <TabsContent value="objections" className="mt-4">
          <ObjectionHandlers
            handlers={config?.objection_handlers || []}
            onSave={handleSaveHandlers}
            saving={saving}
          />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <RetentionCallLog callLogs={callLogs} clients={clients} />
        </TabsContent>
      </Tabs>

      {/* How It Works Section */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 space-y-4">
        <h3 className="font-semibold text-blue-900">How the Retention System Works</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-blue-800">
          <div>
            <p className="font-medium mb-1">📞 Outbound Retention Calls</p>
            <ul className="list-disc ml-4 space-y-1 text-blue-700">
              <li>Runs daily at 11 AM IST via scheduled automation</li>
              <li>Finds expired trial clients based on configured call days</li>
              <li>Uses the mapped DID and AI agent to place calls via Smartflo</li>
              <li>AI generates personalized scripts using client data, your custom instructions, active offers, and objection handlers</li>
              <li>Sends follow-up email after each call</li>
            </ul>
          </div>
          <div>
            <p className="font-medium mb-1">📲 Incoming Call Identification</p>
            <ul className="list-disc ml-4 space-y-1 text-blue-700">
              <li>When someone calls the retention DID, the system looks up their phone number</li>
              <li>If matched to a registered client, it loads their account data</li>
              <li>The AI agent gets context about the client (company, industry, trial status)</li>
              <li>Provides a personalized experience based on their history</li>
              <li>Unrecognized numbers are handled with a general greeting</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}