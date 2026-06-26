import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2, Settings, FileText, Zap, Megaphone } from 'lucide-react';
import PlatformConfigCard from '../components/admin/messaging/PlatformConfigCard';
import PlatformTemplatesTab from '../components/admin/messaging/PlatformTemplatesTab';
import LifecycleConfigTab from '../components/admin/messaging/LifecycleConfigTab';
import BroadcastTab from '../components/admin/messaging/BroadcastTab';

export default function AdminPlatformMessaging() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const cfgs = await apiClient.PlatformMessagingConfig.list('-created_at', 1);
      setConfig(cfgs[0] || null);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  if (loading) return <div className="flex justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3"><Megaphone className="w-8 h-8 text-blue-600" /> Platform Messaging</h1>
        <p className="text-gray-500 mt-1">RCS Digital connection for admin-level lifecycle nudges and broadcasts.</p>
      </div>

      <Tabs defaultValue="config" className="w-full">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="config" className="gap-2"><Settings className="w-4 h-4" /> Config</TabsTrigger>
          <TabsTrigger value="templates" className="gap-2"><FileText className="w-4 h-4" /> Templates</TabsTrigger>
          <TabsTrigger value="lifecycle" className="gap-2"><Zap className="w-4 h-4" /> Lifecycle</TabsTrigger>
          <TabsTrigger value="broadcast" className="gap-2"><Megaphone className="w-4 h-4" /> Broadcasts</TabsTrigger>
        </TabsList>
        <TabsContent value="config" className="mt-4">
          <PlatformConfigCard config={config} onSaved={load} />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <PlatformTemplatesTab config={config} />
        </TabsContent>
        <TabsContent value="lifecycle" className="mt-4">
          <LifecycleConfigTab config={config} onSaved={load} />
        </TabsContent>
        <TabsContent value="broadcast" className="mt-4">
          <BroadcastTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}