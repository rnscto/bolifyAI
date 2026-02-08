import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Plus, Database, CheckCircle, XCircle } from 'lucide-react';
import { toast } from 'sonner';

export default function ClientCRM() {
  const [integrations, setIntegrations] = useState([]);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    crm_type: '',
    webhook_url: '',
    api_key: '',
    api_endpoint: '',
    sync_direction: 'push'
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const integrationsData = await base44.entities.CRMIntegration.filter({
          client_id: clientData.id
        });
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
    try {
      const integrationData = {
        ...formData,
        client_id: client.id,
        status: 'active'
      };

      await base44.entities.CRMIntegration.create(integrationData);
      toast.success('CRM integration created');
      setDialogOpen(false);
      setFormData({
        crm_type: '',
        webhook_url: '',
        api_key: '',
        api_endpoint: '',
        sync_direction: 'push'
      });
      loadData();
    } catch (error) {
      console.error('Error creating integration:', error);
      toast.error('Failed to create integration');
    }
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">CRM Integration</h1>
          <p className="text-gray-600 mt-1">Connect with your existing CRM systems</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Add Integration
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add CRM Integration</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="crm_type">CRM Platform</Label>
                <Select
                  value={formData.crm_type}
                  onValueChange={(value) => setFormData({ ...formData, crm_type: value })}
                  required
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select CRM" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="salesforce">Salesforce</SelectItem>
                    <SelectItem value="hubspot">HubSpot</SelectItem>
                    <SelectItem value="zoho">Zoho CRM</SelectItem>
                    <SelectItem value="custom">Custom Webhook</SelectItem>
                    <SelectItem value="built_in">Built-in CRM</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {formData.crm_type !== 'built_in' && (
                <>
                  <div>
                    <Label htmlFor="webhook_url">Webhook URL</Label>
                    <Input
                      id="webhook_url"
                      value={formData.webhook_url}
                      onChange={(e) => setFormData({ ...formData, webhook_url: e.target.value })}
                      placeholder="https://your-crm.com/webhook"
                    />
                  </div>

                  <div>
                    <Label htmlFor="api_endpoint">API Endpoint</Label>
                    <Input
                      id="api_endpoint"
                      value={formData.api_endpoint}
                      onChange={(e) => setFormData({ ...formData, api_endpoint: e.target.value })}
                      placeholder="https://api.your-crm.com"
                    />
                  </div>

                  <div>
                    <Label htmlFor="api_key">API Key</Label>
                    <Input
                      id="api_key"
                      type="password"
                      value={formData.api_key}
                      onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                      placeholder="Enter API key"
                    />
                  </div>

                  <div>
                    <Label htmlFor="sync_direction">Sync Direction</Label>
                    <Select
                      value={formData.sync_direction}
                      onValueChange={(value) => setFormData({ ...formData, sync_direction: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="push">Push (One-way to CRM)</SelectItem>
                        <SelectItem value="pull">Pull (One-way from CRM)</SelectItem>
                        <SelectItem value="bidirectional">Bidirectional Sync</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div className="flex gap-3 justify-end">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                  Create Integration
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {integrations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Database className="w-16 h-16 text-gray-300 mb-4" />
            <p className="text-gray-500 mb-4">No CRM integrations configured</p>
            <Button onClick={() => setDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Add Your First Integration
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {integrations.map((integration) => (
            <Card key={integration.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-lg capitalize">
                      {integration.crm_type.replace('_', ' ')}
                    </CardTitle>
                    <p className="text-sm text-gray-500 mt-1 capitalize">
                      {integration.sync_direction} sync
                    </p>
                  </div>
                  <Badge className={statusColors[integration.status]}>
                    {integration.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm">
                  <p className="text-gray-600">
                    Endpoint: {integration.api_endpoint || 'Built-in'}
                  </p>
                  {integration.last_sync && (
                    <p className="text-gray-600">
                      Last sync: {new Date(integration.last_sync).toLocaleString()}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}