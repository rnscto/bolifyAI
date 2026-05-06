import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Loader2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';

const STATUS_COLORS = {
  APPROVED: 'bg-green-100 text-green-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
  REJECTED: 'bg-red-100 text-red-800',
  PAUSED: 'bg-gray-100 text-gray-800',
  DISABLED: 'bg-gray-100 text-gray-800',
  draft: 'bg-blue-100 text-blue-800'
};

export default function PlatformTemplatesTab({ config }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const t = await base44.entities.WhatsAppTemplate.filter({ client_id: 'PLATFORM' }, '-created_date', 500);
      setTemplates(t);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await base44.functions.invoke('syncPlatformTemplates', {});
      if (res.data.success) {
        toast.success(`Synced ${res.data.synced} templates (${res.data.created} new, ${res.data.updated} updated)`);
        await load();
      } else toast.error(res.data.error || 'Sync failed');
    } catch (e) { toast.error(e.message); }
    setSyncing(false);
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-semibold">Platform Templates ({templates.length})</h3>
          <p className="text-sm text-gray-500">Templates owned by the platform admin connection — used for lifecycle nudges and broadcasts.</p>
        </div>
        <Button onClick={handleSync} disabled={syncing || config?.whatsapp_status !== 'connected'} variant="outline" className="gap-2">
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Sync from Vendor
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card><CardContent className="py-12 text-center">
          <MessageSquare className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">No platform templates yet</p>
          <p className="text-sm text-gray-500 mt-1">Click "Sync from Vendor" once your platform connection is configured.</p>
        </CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {templates.map(t => (
            <Card key={t.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium text-sm">{t.name}</p>
                    <p className="text-xs text-gray-500">{t.language} • {t.category} • {t.vendor}</p>
                  </div>
                  <Badge className={STATUS_COLORS[t.status] || 'bg-gray-100'}>{t.status}</Badge>
                </div>
                <p className="text-xs text-gray-700 line-clamp-3 bg-gray-50 p-2 rounded mt-2">{t.body_text}</p>
                {t.send_count > 0 && <p className="text-xs text-gray-400 mt-2">Sent {t.send_count} times</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}