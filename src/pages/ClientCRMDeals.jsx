import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Plus, Edit, Trash2, Upload, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import CRMTrialBanner from '../components/crm/CRMTrialBanner';
import DealKanban from '../components/crm/DealKanban';

export default function ClientCRMDeals() {
  const [client, setClient] = useState(null);
  const [crmConfig, setCrmConfig] = useState(null);
  const [deals, setDeals] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState(null);
  const [viewMode, setViewMode] = useState('kanban');
  const [formData, setFormData] = useState({
    title: '', lead_id: '', value: '', stage: '', source: '',
    expected_close_date: '', probability: 10, assigned_to: '', notes: ''
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await apiClient.auth.me();
    const clients = await apiClient.Client.filter({ user_id: user.id });
    if (clients.length === 0) { setLoading(false); return; }

    const clientData = clients[0];
    setClient(clientData);

    const [configs, dealsData, leadsData] = await Promise.all([
      apiClient.CRMConfig.filter({ client_id: clientData.id }),
      apiClient.Deal.filter({ client_id: clientData.id }, '-created_at'),
      apiClient.Lead.filter({ client_id: clientData.id })
    ]);

    if (configs.length > 0) setCrmConfig(configs[0]);
    setDeals(dealsData);
    setLeads(leadsData);
    setLoading(false);
  };

  const stages = crmConfig?.deal_stages || [];
  const firstStage = stages[0]?.name || 'new';

  const resetForm = () => {
    setEditingDeal(null);
    setFormData({ title: '', lead_id: '', value: '', stage: firstStage, source: '', expected_close_date: '', probability: 10, assigned_to: '', notes: '' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const data = { ...formData, client_id: client.id, value: parseFloat(formData.value) || 0, probability: parseInt(formData.probability) || 10 };

    if (editingDeal) {
      await apiClient.Deal.update(editingDeal.id, data);
      toast.success('Deal updated');
    } else {
      await apiClient.Deal.create(data);
      toast.success('Deal created');
    }
    setDialogOpen(false);
    resetForm();
    loadData();
  };

  const handleEdit = (deal) => {
    setEditingDeal(deal);
    setFormData({
      title: deal.title, lead_id: deal.lead_id || '', value: deal.value?.toString() || '',
      stage: deal.stage || firstStage, source: deal.source || '',
      expected_close_date: deal.expected_close_date || '', probability: deal.probability || 10,
      assigned_to: deal.assigned_to || '', notes: deal.notes || ''
    });
    setDialogOpen(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this deal?')) return;
    await apiClient.Deal.delete(id);
    toast.success('Deal deleted');
    loadData();
  };

  const handleStageDrop = async (dealId, newStage) => {
    await apiClient.Deal.update(dealId, { stage: newStage, last_activity_date: new Date().toISOString() });
    toast.success(`Deal moved to ${newStage}`);
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, stage: newStage } : d));
  };

  const handleProposalUpload = async (dealId, file) => {
    const { file_url } = await apiClient.integrations.Core.UploadFile({ file });
    await apiClient.Deal.update(dealId, {
      proposal_uploaded: true, proposal_url: file_url,
      last_activity_date: new Date().toISOString()
    });
    toast.success('Proposal uploaded');
    loadData();
  };

  const statusColors = { open: 'bg-blue-100 text-blue-800', won: 'bg-green-100 text-green-800', lost: 'bg-red-100 text-red-800', on_hold: 'bg-gray-100 text-gray-800' };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <CRMTrialBanner client={client} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Deals</h1>
          <p className="text-gray-600 mt-1">Manage your sales pipeline</p>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button onClick={() => setViewMode('kanban')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${viewMode === 'kanban' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}>Kanban</button>
            <button onClick={() => setViewMode('table')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${viewMode === 'table' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}>Table</button>
          </div>
          <Button onClick={() => { resetForm(); setDialogOpen(true); }} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" /> New Deal
          </Button>
        </div>
      </div>

      {viewMode === 'kanban' ? (
        <DealKanban deals={deals.filter(d => d.status === 'open')} stages={stages} onDealClick={handleEdit} onStageDrop={handleStageDrop} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Probability</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Close Date</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deals.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-gray-500 py-8">No deals yet. Create your first deal!</TableCell></TableRow>
                ) : deals.map(deal => (
                  <TableRow key={deal.id}>
                    <TableCell className="font-medium">{deal.title}</TableCell>
                    <TableCell><Badge variant="outline">{deal.stage}</Badge></TableCell>
                    <TableCell>₹{(deal.value || 0).toLocaleString()}</TableCell>
                    <TableCell>{deal.probability}%</TableCell>
                    <TableCell><Badge className={statusColors[deal.status]}>{deal.status}</Badge></TableCell>
                    <TableCell>{deal.expected_close_date ? new Date(deal.expected_close_date).toLocaleDateString() : '-'}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => handleEdit(deal)}><Edit className="w-4 h-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(deal.id)}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => document.getElementById(`proposal-${deal.id}`).click()}>
                          <Upload className="w-4 h-4" />
                        </Button>
                        <input id={`proposal-${deal.id}`} type="file" className="hidden" onChange={(e) => { if (e.target.files[0]) handleProposalUpload(deal.id, e.target.files[0]); }} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editingDeal ? 'Edit Deal' : 'New Deal'}</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div><Label>Title</Label><Input value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} required /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Value (₹)</Label><Input type="number" value={formData.value} onChange={e => setFormData({...formData, value: e.target.value})} /></div>
              <div><Label>Probability (%)</Label><Input type="number" min="0" max="100" value={formData.probability} onChange={e => setFormData({...formData, probability: e.target.value})} /></div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Stage</Label>
                <Select value={formData.stage} onValueChange={v => setFormData({...formData, stage: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{stages.map(s => <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Lead</Label>
                <Select value={formData.lead_id} onValueChange={v => setFormData({...formData, lead_id: v})}>
                  <SelectTrigger><SelectValue placeholder="Select lead" /></SelectTrigger>
                  <SelectContent>{leads.map(l => <SelectItem key={l.id} value={l.id}>{l.name || l.phone}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Source</Label>
                <Select value={formData.source} onValueChange={v => setFormData({...formData, source: v})}>
                  <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                  <SelectContent>{(crmConfig?.lead_sources || []).map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Expected Close</Label><Input type="date" value={formData.expected_close_date} onChange={e => setFormData({...formData, expected_close_date: e.target.value})} /></div>
            </div>
            <div><Label>Assigned To</Label><Input value={formData.assigned_to} onChange={e => setFormData({...formData, assigned_to: e.target.value})} placeholder="Email of sales rep" /></div>
            <div><Label>Notes</Label><Textarea value={formData.notes} onChange={e => setFormData({...formData, notes: e.target.value})} /></div>
            <div className="flex gap-3 justify-end">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700">{editingDeal ? 'Update' : 'Create Deal'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}