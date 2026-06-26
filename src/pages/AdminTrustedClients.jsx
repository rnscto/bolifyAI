import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Eye, EyeOff, GripVertical, Upload, Image } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export default function AdminTrustedClients() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: '', logo_url: '', order: 0, is_active: true });
  const [uploading, setUploading] = useState(false);

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['trusted-clients'],
    queryFn: () => apiClient.TrustedClient.list('order', 100),
  });

  const createMutation = useMutation({
    mutationFn: (data) => apiClient.TrustedClient.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trusted-clients'] });
      setDialogOpen(false);
      setForm({ name: '', logo_url: '', order: 0, is_active: true });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => apiClient.TrustedClient.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trusted-clients'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiClient.TrustedClient.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trusted-clients'] }),
  });

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const { file_url } = await apiClient.integrations.Core.UploadFile({ file });
    setForm(prev => ({ ...prev, logo_url: file_url }));
    setUploading(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Trusted By - Client Logos</h1>
          <p className="text-gray-500 text-sm mt-1">Manage logos shown in the "Trusted By" marquee on the homepage</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" /> Add Logo
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Client Logo</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <Label>Company Name</Label>
                <Input
                  placeholder="e.g. Reliance Industries"
                  value={form.name}
                  onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>
              <div>
                <Label>Logo</Label>
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <Input
                      placeholder="Logo URL or upload below"
                      value={form.logo_url}
                      onChange={e => setForm(prev => ({ ...prev, logo_url: e.target.value }))}
                    />
                  </div>
                  <label className="cursor-pointer">
                    <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                    <Button variant="outline" size="icon" asChild disabled={uploading}>
                      <span>{uploading ? '...' : <Upload className="w-4 h-4" />}</span>
                    </Button>
                  </label>
                </div>
                {form.logo_url && (
                  <div className="mt-2 p-3 bg-gray-50 rounded-lg flex items-center justify-center">
                    <img src={form.logo_url} alt="Preview" className="h-10 max-w-[160px] object-contain" />
                  </div>
                )}
              </div>
              <div>
                <Label>Display Order (lower = first)</Label>
                <Input
                  type="number"
                  value={form.order}
                  onChange={e => setForm(prev => ({ ...prev, order: parseInt(e.target.value) || 0 }))}
                />
              </div>
              <Button
                className="w-full bg-blue-600 hover:bg-blue-700"
                disabled={!form.name || !form.logo_url || createMutation.isPending}
                onClick={() => createMutation.mutate(form)}
              >
                {createMutation.isPending ? 'Adding...' : 'Add Logo'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : clients.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Image className="w-12 h-12 mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500">No client logos added yet</p>
            <p className="text-sm text-gray-400 mt-1">Add logos to show in the "Trusted By" section on the homepage</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {clients.map(client => (
            <Card key={client.id} className="overflow-hidden">
              <div className="flex items-center gap-4 p-4">
                <GripVertical className="w-4 h-4 text-gray-300 flex-shrink-0" />
                <div className="w-24 h-12 bg-gray-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <img src={client.logo_url} alt={client.name} className="h-8 max-w-[90px] object-contain" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{client.name}</p>
                  <p className="text-xs text-gray-400">Order: {client.order || 0}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    {client.is_active ? (
                      <Badge className="bg-green-50 text-green-700 border-green-200">Visible</Badge>
                    ) : (
                      <Badge variant="outline" className="text-gray-400">Hidden</Badge>
                    )}
                    <Switch
                      checked={client.is_active !== false}
                      onCheckedChange={(checked) => updateMutation.mutate({ id: client.id, data: { is_active: checked } })}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-red-400 hover:text-red-600 hover:bg-red-50"
                    onClick={() => { if (confirm('Delete this logo?')) deleteMutation.mutate(client.id); }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}