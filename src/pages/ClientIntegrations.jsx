import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Plug, MessageSquare, Smartphone, Mail, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import WhatsAppSetup from '../components/integrations/WhatsAppSetup';
import RCSSetup from '../components/integrations/RCSSetup';
import EmailSetup from '../components/integrations/EmailSetup';
import ShopifySetup from '../components/integrations/ShopifySetup';

export default function ClientIntegrations() {
  const [client, setClient] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length > 0) {
      setClient(clients[0]);
      const configs = await base44.entities.ClientMessagingConfig.filter({ client_id: clients[0].id });
      if (configs.length > 0) {
        setConfig(configs[0]);
      } else {
        // Create default config
        const newConfig = await base44.entities.ClientMessagingConfig.create({ client_id: clients[0].id });
        setConfig(newConfig);
      }
    }
    setLoading(false);
  };

  const handleSave = async (updates) => {
    if (!config) return;
    await base44.entities.ClientMessagingConfig.update(config.id, updates);
    setConfig({ ...config, ...updates });
    toast.success('Integration saved');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
      </div>
    );
  }

  const connectedCount = [
    config?.whatsapp_provider !== 'none' && config?.whatsapp_provider,
    config?.rcs_provider !== 'none' && config?.rcs_provider,
    config?.email_provider !== 'none' && config?.email_provider,
  ].filter(Boolean).length;

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
          <Plug className="w-8 h-8 text-blue-600" /> Messaging Integrations
        </h1>
        <p className="text-gray-500 mt-1">Connect your own WhatsApp, RCS/SMS, and Email APIs — 100% plug & play</p>
      </div>

      {/* Status Overview */}
      <div className="grid grid-cols-3 gap-4">
        <div className={`flex items-center gap-3 p-4 rounded-xl border-2 ${config?.whatsapp_provider && config?.whatsapp_provider !== 'none' ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
          <MessageSquare className={`w-6 h-6 ${config?.whatsapp_provider && config?.whatsapp_provider !== 'none' ? 'text-green-600' : 'text-gray-400'}`} />
          <div>
            <p className="text-sm font-medium">WhatsApp</p>
            <p className="text-xs text-gray-500">{config?.whatsapp_provider && config?.whatsapp_provider !== 'none' ? config.whatsapp_provider.replace(/_/g, ' ') : 'Not connected'}</p>
          </div>
          {config?.whatsapp_provider && config?.whatsapp_provider !== 'none' && <CheckCircle2 className="w-5 h-5 text-green-600 ml-auto" />}
        </div>
        <div className={`flex items-center gap-3 p-4 rounded-xl border-2 ${config?.rcs_provider && config?.rcs_provider !== 'none' ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
          <Smartphone className={`w-6 h-6 ${config?.rcs_provider && config?.rcs_provider !== 'none' ? 'text-green-600' : 'text-gray-400'}`} />
          <div>
            <p className="text-sm font-medium">RCS / SMS</p>
            <p className="text-xs text-gray-500">{config?.rcs_provider && config?.rcs_provider !== 'none' ? config.rcs_provider.replace(/_/g, ' ') : 'Not connected'}</p>
          </div>
          {config?.rcs_provider && config?.rcs_provider !== 'none' && <CheckCircle2 className="w-5 h-5 text-green-600 ml-auto" />}
        </div>
        <div className={`flex items-center gap-3 p-4 rounded-xl border-2 ${config?.email_provider && config?.email_provider !== 'none' ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
          <Mail className={`w-6 h-6 ${config?.email_provider && config?.email_provider !== 'none' ? 'text-green-600' : 'text-gray-400'}`} />
          <div>
            <p className="text-sm font-medium">Email</p>
            <p className="text-xs text-gray-500">{config?.email_provider && config?.email_provider !== 'none' ? config.email_provider : 'Not connected'}</p>
          </div>
          {config?.email_provider && config?.email_provider !== 'none' && <CheckCircle2 className="w-5 h-5 text-green-600 ml-auto" />}
        </div>
      </div>

      {connectedCount === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
          <Plug className="w-10 h-10 text-blue-500 mx-auto mb-3" />
          <h3 className="font-semibold text-blue-900 mb-1">Get Started</h3>
          <p className="text-sm text-blue-700">Connect at least one messaging channel below to start sending automated follow-ups through your own APIs.</p>
        </div>
      )}

      {/* Marketplace Integrations */}
      <div className="pt-4 border-t">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Marketplace Integrations</h2>
        <p className="text-sm text-gray-500 mb-4">Connect your e-commerce store so AI agents can look up orders, products, and tracking during customer calls.</p>
        <ShopifySetup clientId={client?.id} />
      </div>

      {/* Messaging Integration Cards */}
      <div className="pt-4 border-t">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Messaging Channels</h2>
      </div>
      <WhatsAppSetup config={config} onSave={handleSave} />
      <RCSSetup config={config} onSave={handleSave} />
      <EmailSetup config={config} onSave={handleSave} />

      <div className="bg-gray-50 rounded-xl p-5 text-center text-sm text-gray-500">
        <p>Your API credentials are stored securely and only used for sending messages on your behalf.</p>
        <p className="mt-1">Need help? Contact <a href="mailto:support@vaaniai.io" className="text-blue-600 underline">support@vaaniai.io</a></p>
      </div>
    </div>
  );
}