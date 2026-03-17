import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import FeatureGate from '../components/FeatureGate';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Plus, Upload, Phone as PhoneIcon, Edit, Trash2, Filter, Loader2, PhoneCall, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import CSVImportDialog from '../components/leads/CSVImportDialog';
import LeadScoreBadge from '../components/leads/LeadScoreBadge';

export default function ClientLeads() {
  const [leads, setLeads] = useState([]);
  const [client, setClient] = useState(null);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLead, setEditingLead] = useState(null);
  const [csvDialogOpen, setCsvDialogOpen] = useState(false);
  const [tierFilter, setTierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [callingLeadId, setCallingLeadId] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    company: '',
    notes: ''
  });

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const [leadsData, agentsData] = await Promise.all([
          base44.entities.Lead.filter({ client_id: clientData.id }, '-created_date'),
          base44.entities.Agent.filter({ client_id: clientData.id })
        ]);

        setLeads(leadsData);
        setAgents(agentsData);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!client) {
      toast.error('Client not loaded. Please refresh the page.');
      return;
    }
    
    try {
      const leadData = {
        ...formData,
        client_id: client.id,
        status: 'new'
      };

      if (editingLead) {
        await base44.entities.Lead.update(editingLead.id, leadData);
        toast.success('Lead updated');
      } else {
        await base44.entities.Lead.create(leadData);
        toast.success('Lead added');
      }

      setDialogOpen(false);
      resetForm();
      loadData();
    } catch (error) {
      console.error('Error saving lead:', error);
      toast.error('Failed to save lead');
    }
  };

  const resetForm = () => {
    setEditingLead(null);
    setFormData({ name: '', phone: '', email: '', company: '', notes: '' });
    setDialogOpen(false);
  };

  const handleEdit = (lead) => {
    setEditingLead(lead);
    setFormData({
      name: lead.name,
      phone: lead.phone,
      email: lead.email || '',
      company: lead.company || '',
      notes: lead.notes || ''
    });
    setDialogOpen(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this lead?')) return;
    
    try {
      await base44.entities.Lead.delete(id);
      toast.success('Lead deleted');
      loadData();
    } catch (error) {
      console.error('Error deleting lead:', error);
      toast.error('Failed to delete lead');
    }
  };

  const initiateCall = async (lead) => {
    const activeAgents = agents.filter(a => a.status === 'active');
    if (activeAgents.length === 0) {
      toast.error('No active agents available. Please activate an agent first.');
      return;
    }

    setCallingLeadId(lead.id);
    try {
      const response = await base44.functions.invoke('initiateCall', {
        lead_id: lead.id,
        agent_id: activeAgents[0].id,
        phone_number: lead.phone
      });

      if (response.data.success) {
        toast.success('Call initiated! AI agent is connecting...');
        // Keep the calling state for a few seconds to show progress
        setTimeout(() => {
          setCallingLeadId(null);
          loadData();
        }, 5000);
      } else {
        setCallingLeadId(null);
        toast.error(response.data.error || 'Failed to initiate call');
      }
    } catch (error) {
      setCallingLeadId(null);
      console.error('Error initiating call:', error);
      toast.error('Failed to initiate call');
    }
  };

  const statusColors = {
    new: 'bg-blue-100 text-blue-800',
    contacted: 'bg-purple-100 text-purple-800',
    interested: 'bg-green-100 text-green-800',
    not_interested: 'bg-red-100 text-red-800',
    callback: 'bg-yellow-100 text-yellow-800',
    converted: 'bg-emerald-100 text-emerald-800',
    do_not_call: 'bg-gray-100 text-gray-800'
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <FeatureGate client={client} featureName="Leads">
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Leads</h1>
          <p className="text-gray-600 mt-1">Manage your lead database</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCsvDialogOpen(true)}>
            <Upload className="w-4 h-4 mr-2" /> Import Leads
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button 
                className="bg-blue-600 hover:bg-blue-700"
                onClick={() => resetForm()}
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Lead
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {editingLead ? 'Edit Lead' : 'Add New Lead'}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="company">Company</Label>
                  <Input
                    id="company"
                    value={formData.company}
                    onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="notes">Notes</Label>
                  <Input
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  />
                </div>
                <div className="flex gap-3 justify-end">
                  <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }}>
                    Cancel
                  </Button>
                  <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                    {editingLead ? 'Update' : 'Add Lead'}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Tier summary cards */}
      {leads.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { key: 'hot', label: 'Hot', emoji: '🔥', bg: 'bg-red-50 border-red-200' },
            { key: 'warm', label: 'Warm', emoji: '🌡️', bg: 'bg-orange-50 border-orange-200' },
            { key: 'nurture', label: 'Nurture', emoji: '🌱', bg: 'bg-blue-50 border-blue-200' },
            { key: 'cold', label: 'Cold', emoji: '❄️', bg: 'bg-slate-50 border-slate-200' },
            { key: 'disqualified', label: 'Disqualified', emoji: '🚫', bg: 'bg-gray-50 border-gray-200' },
          ].map(t => {
            const count = leads.filter(l => l.qualification_tier === t.key).length;
            return (
              <button key={t.key}
                onClick={() => setTierFilter(tierFilter === t.key ? 'all' : t.key)}
                className={`rounded-xl border p-3 text-center transition-all ${t.bg} ${tierFilter === t.key ? 'ring-2 ring-offset-1 ring-blue-500 shadow-md' : 'hover:shadow'}`}>
                <div className="text-lg">{t.emoji}</div>
                <div className="text-xl font-bold">{count}</div>
                <div className="text-xs text-gray-600">{t.label}</div>
              </button>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle>
              {tierFilter === 'all' ? `All Leads (${leads.length})` : `${tierFilter.charAt(0).toUpperCase() + tierFilter.slice(1)} Leads`}
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                placeholder="Search name, phone, company..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-48 h-8 text-sm"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40 h-8 text-sm">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="contacted">Contacted</SelectItem>
                  <SelectItem value="interested">Interested</SelectItem>
                  <SelectItem value="not_interested">Not Interested</SelectItem>
                  <SelectItem value="callback">Callback</SelectItem>
                  <SelectItem value="converted">Converted</SelectItem>
                  <SelectItem value="do_not_call">Do Not Call</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="w-40 h-8 text-sm">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  {[...new Set(leads.map(l => l.source).filter(Boolean))].map(src => (
                    <SelectItem key={src} value={src}>{src}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(tierFilter !== 'all' || statusFilter !== 'all' || sourceFilter !== 'all') && (
                <Button size="sm" variant="ghost" onClick={() => { setTierFilter('all'); setStatusFilter('all'); setSourceFilter('all'); }}>
                  <Filter className="w-3 h-3 mr-1" /> Clear filters
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>AI Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Call</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(() => {
                const filtered = leads
                  .filter(l => tierFilter === 'all' || l.qualification_tier === tierFilter)
                  .filter(l => statusFilter === 'all' || l.status === statusFilter)
                  .filter(l => sourceFilter === 'all' || l.source === sourceFilter)
                  .filter(l => {
                    if (!searchTerm) return true;
                    const s = searchTerm.toLowerCase();
                    return (l.name || '').toLowerCase().includes(s) || 
                           (l.phone || '').includes(s) || 
                           (l.company || '').toLowerCase().includes(s);
                  });
                return filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500">
                    {leads.length === 0 ? 'No leads found. Add your first lead to get started.' : 'No leads match the current filter.'}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((lead) => (
                  <TableRow key={lead.id} className={lead.qualification_tier === 'disqualified' ? 'opacity-50' : ''}>
                    <TableCell>
                      <Link to={createPageUrl('LeadDetail') + `?id=${lead.id}`} className="hover:underline">
                        <span className="font-medium text-blue-700">{lead.name}</span>
                        {lead.email && <p className="text-xs text-gray-400">{lead.email}</p>}
                      </Link>
                    </TableCell>
                    <TableCell>{lead.phone}</TableCell>
                    <TableCell>{lead.company || '-'}</TableCell>
                    <TableCell>
                      <LeadScoreBadge lead={lead} />
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[lead.status]}>
                        {lead.status.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {lead.last_call_date ? 
                        new Date(lead.last_call_date).toLocaleDateString() : '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Link to={createPageUrl('LeadDetail') + `?id=${lead.id}`}>
                          <Button size="sm" variant="ghost" title="View Details">
                            <Eye className="w-4 h-4" />
                          </Button>
                        </Link>
                        <Button
                          size="sm"
                          variant={callingLeadId === lead.id ? "default" : "outline"}
                          onClick={() => initiateCall(lead)}
                          disabled={callingLeadId !== null}
                          title={callingLeadId === lead.id ? "Calling..." : "Call Now"}
                          className={callingLeadId === lead.id ? "bg-green-600 hover:bg-green-700 text-white animate-pulse" : ""}
                        >
                          {callingLeadId === lead.id ? (
                            <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Calling</>
                          ) : (
                            <PhoneIcon className="w-4 h-4" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEdit(lead)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(lead.id)}
                        >
                          <Trash2 className="w-4 h-4 text-red-600" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              );
              })()}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CSVImportDialog
        open={csvDialogOpen}
        onOpenChange={setCsvDialogOpen}
        clientId={client?.id}
        onComplete={loadData}
      />
    </div>
    </FeatureGate>
  );
}