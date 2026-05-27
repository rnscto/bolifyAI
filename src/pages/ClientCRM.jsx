import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Plus, Database, CheckCircle, XCircle, RefreshCw, Copy, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import BuildCRMCard from '../components/crm/BuildCRMCard';
import FeatureGate from '../components/FeatureGate';
import CRMAccessGate from '../components/crm/CRMAccessGate';

export default function ClientCRM() {
  const [integrations, setIntegrations] = useState([]);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    crm_type: '', webhook_url: '', api_key: '', api_endpoint: '', sync_direction: 'push'
  });
  const [showApiKey, setShowApiKey] = useState({});

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);
        const integrationsData = await base44.entities.CRMIntegration.filter({ client_id: clientData.id });
        setIntegrations(integrationsData);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const integrationData = { ...formData, client_id: client.id, status: 'active' };
    await base44.entities.CRMIntegration.create(integrationData);
    toast.success('CRM integration created');
    setDialogOpen(false);
    setFormData({ crm_type: '', webhook_url: '', api_key: '', api_endpoint: '', sync_direction: 'push' });
    loadData();
  };

  const getTrialDaysLeft = () => {
    if (!client?.crm_trial_end_date) return 0;
    return Math.max(0, Math.ceil((new Date(client.crm_trial_end_date) - new Date()) / (1000 * 60 * 60 * 24)));
  };

  const statusColors = {
    active: 'bg-green-100 text-green-800',
    inactive: 'bg-gray-100 text-gray-800',
    error: 'bg-red-100 text-red-800'
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <FeatureGate client={client} featureName="CRM Integration">
    <div className="space-y-6">
      {/* Build CRM Card - shown if CRM not active */}
      <BuildCRMCard
        onGetStarted={() => window.location.href = createPageUrl('ClientCRMSetup')}
        trialDaysLeft={getTrialDaysLeft()}
        crmStatus={client?.crm_subscription_status || 'none'}
      />

      {/* CRM Active - Quick Access */}
       {client?.has_custom_crm && (
         <Card className="border-primary/20 bg-primary/5">
           <CardContent className="p-6">
             <div className="flex items-center justify-between flex-wrap gap-4">
               <div className="flex items-center gap-3">
                 <CheckCircle className="w-6 h-6 text-primary" />
                 <div>
                   <p className="font-semibold text-primary">Custom CRM Active</p>
                   <p className="text-sm text-primary/70">Your industry-specific CRM is ready to use</p>
                 </div>
               </div>
               <Link to={createPageUrl('ClientCRMDashboard')}>
                 <Button className="bg-primary hover:bg-primary/90">Go to CRM Dashboard</Button>
               </Link>
             </div>
           </CardContent>
         </Card>
       )}

      {/* External CRM Integrations — gated behind admin-approved access */}
      <CRMAccessGate client={client} onChange={loadData}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">External CRM Integration</h1>
          <p className="text-gray-600 mt-1">Connect with your existing CRM systems</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700"><Plus className="w-4 h-4 mr-2" />Add Integration</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add CRM Integration</DialogTitle></DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label>CRM Platform</Label>
                <Select value={formData.crm_type} onValueChange={v => setFormData({...formData, crm_type: v})}>
                  <SelectTrigger><SelectValue placeholder="Select CRM" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="salesforce">Salesforce</SelectItem>
                    <SelectItem value="hubspot">HubSpot</SelectItem>
                    <SelectItem value="zoho">Zoho CRM</SelectItem>
                    <SelectItem value="custom">Custom Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Webhook URL</Label><Input value={formData.webhook_url} onChange={e => setFormData({...formData, webhook_url: e.target.value})} placeholder="https://your-crm.com/webhook" /></div>
              <div><Label>API Endpoint</Label><Input value={formData.api_endpoint} onChange={e => setFormData({...formData, api_endpoint: e.target.value})} placeholder="https://api.your-crm.com" /></div>
              <div>
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <Input type="password" value={formData.api_key} onChange={e => setFormData({...formData, api_key: e.target.value})} placeholder="Enter or generate a key" />
                  <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => {
                    const key = 'bf_' + crypto.randomUUID().replace(/-/g, '').substring(0, 32);
                    setFormData({...formData, api_key: key});
                    toast.success('API key generated!');
                  }}>
                    <RefreshCw className="w-4 h-4 mr-1" /> Generate
                  </Button>
                </div>
                <p className="text-xs text-gray-500 mt-1">This key is used to authenticate CRM API calls (x-api-key header)</p>
              </div>
              <div>
                <Label>Sync Direction</Label>
                <Select value={formData.sync_direction} onValueChange={v => setFormData({...formData, sync_direction: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="push">Push</SelectItem>
                    <SelectItem value="pull">Pull</SelectItem>
                    <SelectItem value="bidirectional">Bidirectional</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-3 justify-end">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-blue-600 hover:bg-blue-700">Create</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {integrations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Database className="w-16 h-16 text-gray-300 mb-4" />
            <p className="text-gray-500 mb-4">No external CRM integrations configured</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {integrations.map(i => (
            <Card key={i.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-lg capitalize">{i.crm_type.replace('_', ' ')}</CardTitle>
                    <p className="text-sm text-gray-500 mt-1 capitalize">{i.sync_direction} sync</p>
                  </div>
                  <Badge className={statusColors[i.status]}>{i.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm text-gray-600">Endpoint: {i.api_endpoint || 'N/A'}</p>
                {i.api_key && (
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-gray-600">API Key: </p>
                    <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono">
                      {showApiKey[i.id] ? i.api_key : '••••••••••••'}
                    </code>
                    <button onClick={() => setShowApiKey(prev => ({...prev, [i.id]: !prev[i.id]}))} className="text-gray-400 hover:text-gray-600">
                      {showApiKey[i.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => { navigator.clipboard.writeText(i.api_key); toast.success('API key copied!'); }} className="text-gray-400 hover:text-gray-600">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {i.last_sync && <p className="text-sm text-gray-600">Last sync: {new Date(i.last_sync).toLocaleString()}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      </CRMAccessGate>
    </div>
    </FeatureGate>
  );
}