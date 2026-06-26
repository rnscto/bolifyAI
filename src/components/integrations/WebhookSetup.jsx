import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Webhook, Plus, Trash2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export default function WebhookSetup({ clientId }) {
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const [newWebhook, setNewWebhook] = useState({
    crm_type: 'webhook',
    webhook_url: '',
    api_key: ''
  });

  useEffect(() => {
    if (clientId) loadWebhooks();
  }, [clientId]);

  const loadWebhooks = async () => {
    try {
      const res = await apiClient.CrmIntegration.filter({ client_id: clientId });
      setWebhooks(res.filter(w => ['webhook', 'zapier', 'make'].includes(w.crm_type) && w.status === 'active'));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!newWebhook.webhook_url.startsWith('https://')) {
      toast.error('Webhook URL must be a valid HTTPS URL');
      return;
    }

    try {
      await apiClient.CrmIntegration.create({
        client_id: clientId,
        crm_type: newWebhook.crm_type,
        webhook_url: newWebhook.webhook_url,
        api_key: newWebhook.api_key || null,
        status: 'active'
      });

      toast.success('Webhook added successfully');
      setNewWebhook({ crm_type: 'webhook', webhook_url: '', api_key: '' });
      setAdding(false);
      loadWebhooks();
    } catch (e) {
      toast.error(e.message || 'Failed to add webhook');
    }
  };

  const handleDelete = async (id) => {
    try {
      await apiClient.CrmIntegration.update(id, { status: 'deleted' });
      toast.success('Webhook removed');
      loadWebhooks();
    } catch (e) {
      toast.error('Failed to remove webhook');
    }
  };

  return (
    <Card className="border-2 border-indigo-100/50 shadow-sm overflow-hidden group">
      <CardHeader className="bg-indigo-50/50 pb-4 border-b border-indigo-100/50">
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-100 rounded-xl text-indigo-600">
              <Webhook className="w-6 h-6" />
            </div>
            <div>
              <CardTitle className="text-xl">Outbound Webhooks</CardTitle>
              <CardDescription className="mt-1 text-sm text-gray-500">
                Send real-time call data to Zapier, Make, or custom servers.
              </CardDescription>
            </div>
          </div>
          {webhooks.length > 0 && (
            <Badge className="bg-green-100 text-green-700 border-green-200">
              <CheckCircle2 className="w-3 h-3 mr-1" /> Active
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-6 space-y-6">
        {webhooks.length > 0 && (
          <div className="space-y-3">
            <Label>Active Webhooks</Label>
            {webhooks.map(wh => (
              <div key={wh.id} className="flex items-center justify-between p-3 border rounded-md bg-gray-50">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="uppercase text-xs">{wh.crm_type}</Badge>
                    <span className="text-sm font-medium truncate max-w-[300px]">{wh.webhook_url}</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleDelete(wh.id)} className="text-red-500 hover:text-red-700 hover:bg-red-50">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {!adding ? (
          <Button variant="outline" onClick={() => setAdding(true)} className="w-full border-dashed">
            <Plus className="w-4 h-4 mr-2" /> Add Webhook Destination
          </Button>
        ) : (
          <div className="p-4 border rounded-xl bg-gray-50 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Destination Type</Label>
                <Select value={newWebhook.crm_type} onValueChange={v => setNewWebhook({ ...newWebhook, crm_type: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webhook">Custom Webhook</SelectItem>
                    <SelectItem value="zapier">Zapier Catch Hook</SelectItem>
                    <SelectItem value="make">Make.com Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Webhook URL</Label>
                <Input
                  placeholder="https://hooks.zapier.com/..."
                  value={newWebhook.webhook_url}
                  onChange={e => setNewWebhook({ ...newWebhook, webhook_url: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Secret / Signing Key (Optional)</Label>
              <Input
                placeholder="Enter a secret string to sign the payload (HMAC SHA-256)"
                value={newWebhook.api_key}
                onChange={e => setNewWebhook({ ...newWebhook, api_key: e.target.value })}
              />
              <p className="text-xs text-gray-500 mt-1">If provided, we will send an `x-bolify-signature` header.</p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button onClick={handleAdd}>Save Webhook</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
