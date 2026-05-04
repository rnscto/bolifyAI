import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MessageSquare, RefreshCw, Plus, Loader2, Search, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import TemplateCard from '../components/whatsapp/TemplateCard';
import SendTemplateDialog from '../components/whatsapp/SendTemplateDialog';
import LinkActionsDialog from '../components/whatsapp/LinkActionsDialog';
import CreateTemplateDialog from '../components/whatsapp/CreateTemplateDialog';

export default function ClientWhatsAppTemplates() {
  const [client, setClient] = useState(null);
  const [config, setConfig] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sendTarget, setSendTarget] = useState(null);
  const [linkTarget, setLinkTarget] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (clients.length === 0) { setLoading(false); return; }
      const c = clients[0];
      setClient(c);

      const configs = await base44.entities.ClientMessagingConfig.filter({ client_id: c.id });
      if (configs.length > 0) setConfig(configs[0]);

      const tmpl = await base44.entities.WhatsAppTemplate.filter({ client_id: c.id }, '-created_date', 500);
      setTemplates(tmpl);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    if (!client) return;
    setSyncing(true);
    try {
      const res = await base44.functions.invoke('whatsappListTemplates', { client_id: client.id });
      if (res.data.success) {
        toast.success(`Synced ${res.data.synced} templates from Meta`);
        await loadAll();
      } else {
        toast.error(res.data.error || 'Sync failed');
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const filtered = templates.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (search && !t.name.toLowerCase().includes(search.toLowerCase()) &&
        !(t.body_text || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  const isMetaCloud = config?.whatsapp_provider === 'meta_cloud';
  const hasCredentials = config?.whatsapp_api_key && config?.whatsapp_business_id;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <MessageSquare className="w-8 h-8 text-green-600" /> WhatsApp Templates
          </h1>
          <p className="text-gray-500 mt-1">View, create, send, and auto-link Meta-approved WhatsApp templates.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSync} disabled={syncing || !isMetaCloud || !hasCredentials} className="gap-2">
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Sync from Meta
          </Button>
          <Button onClick={() => setShowCreate(true)} disabled={!isMetaCloud || !hasCredentials} className="gap-2 bg-green-600 hover:bg-green-700">
            <Plus className="w-4 h-4" /> New Template
          </Button>
        </div>
      </div>

      {!isMetaCloud && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-yellow-900">Meta Cloud API required</p>
            <p className="text-sm text-yellow-700">
              Templates are only available with the official Meta Cloud API.
              Go to <a href="/ClientIntegrations" className="underline font-medium">Integrations</a> and connect Meta Cloud API to use this feature.
            </p>
          </div>
        </div>
      )}

      {isMetaCloud && !hasCredentials && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-orange-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-orange-900">Credentials missing</p>
            <p className="text-sm text-orange-700">
              Add your Access Token and WhatsApp Business Account ID in <a href="/ClientIntegrations" className="underline font-medium">Integrations</a>.
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or body..."
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="PENDING">Pending Review</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="PAUSED">Paused</SelectItem>
            <SelectItem value="DISABLED">Disabled</SelectItem>
          </SelectContent>
        </Select>
        <div className="text-sm text-gray-500">{filtered.length} of {templates.length} templates</div>
      </div>

      {/* Templates Grid */}
      {filtered.length === 0 ? (
        <div className="border-2 border-dashed rounded-xl p-12 text-center">
          <MessageSquare className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">No templates yet</p>
          <p className="text-sm text-gray-500 mt-1">
            {isMetaCloud && hasCredentials
              ? 'Click "Sync from Meta" to import existing templates, or create a new one.'
              : 'Connect Meta Cloud API first to manage templates.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(t => (
            <TemplateCard
              key={t.id}
              template={t}
              onSend={setSendTarget}
              onEditLinks={setLinkTarget}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <SendTemplateDialog template={sendTarget} open={!!sendTarget} onOpenChange={(o) => !o && setSendTarget(null)} />
      <LinkActionsDialog template={linkTarget} open={!!linkTarget} onOpenChange={(o) => !o && setLinkTarget(null)} onSaved={loadAll} />
      <CreateTemplateDialog clientId={client?.id} open={showCreate} onOpenChange={setShowCreate} onCreated={loadAll} />
    </div>
  );
}