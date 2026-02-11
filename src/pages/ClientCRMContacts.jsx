import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Edit, Trash2, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import CRMTrialBanner from '../components/crm/CRMTrialBanner';

export default function ClientCRMContacts() {
  const [client, setClient] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [search, setSearch] = useState('');
  const [formData, setFormData] = useState({
    first_name: '', last_name: '', email: '', phone: '', company: '', job_title: '', notes: ''
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length > 0) {
      setClient(clients[0]);
      const data = await base44.entities.Contact.filter({ client_id: clients[0].id }, '-created_date');
      setContacts(data);
    }
    setLoading(false);
  };

  const resetForm = () => {
    setEditingContact(null);
    setFormData({ first_name: '', last_name: '', email: '', phone: '', company: '', job_title: '', notes: '' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const data = { ...formData, client_id: client.id };
    if (editingContact) {
      await base44.entities.Contact.update(editingContact.id, data);
      toast.success('Contact updated');
    } else {
      await base44.entities.Contact.create(data);
      toast.success('Contact created');
    }
    setDialogOpen(false);
    resetForm();
    loadData();
  };

  const handleEdit = (c) => {
    setEditingContact(c);
    setFormData({ first_name: c.first_name, last_name: c.last_name || '', email: c.email || '', phone: c.phone, company: c.company || '', job_title: c.job_title || '', notes: c.notes || '' });
    setDialogOpen(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this contact?')) return;
    await base44.entities.Contact.delete(id);
    toast.success('Contact deleted');
    loadData();
  };

  const filtered = contacts.filter(c => {
    const q = search.toLowerCase();
    return !q || `${c.first_name} ${c.last_name} ${c.email} ${c.company} ${c.phone}`.toLowerCase().includes(q);
  });

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-600" /></div>;

  return (
    <div className="space-y-6">
      <CRMTrialBanner client={client} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Contacts</h1>
          <p className="text-gray-600 mt-1">Manage your contacts database</p>
        </div>
        <Button onClick={() => { resetForm(); setDialogOpen(true); }} className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="w-4 h-4 mr-2" /> Add Contact
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input className="pl-10" placeholder="Search contacts..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Job Title</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-gray-500 py-8">No contacts found</TableCell></TableRow>
              ) : filtered.map(c => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.first_name} {c.last_name}</TableCell>
                  <TableCell>{c.email || '-'}</TableCell>
                  <TableCell>{c.phone}</TableCell>
                  <TableCell>{c.company || '-'}</TableCell>
                  <TableCell>{c.job_title || '-'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => handleEdit(c)}><Edit className="w-4 h-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDelete(c.id)}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingContact ? 'Edit Contact' : 'New Contact'}</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><Label>First Name</Label><Input value={formData.first_name} onChange={e => setFormData({...formData, first_name: e.target.value})} required /></div>
              <div><Label>Last Name</Label><Input value={formData.last_name} onChange={e => setFormData({...formData, last_name: e.target.value})} /></div>
            </div>
            <div><Label>Phone</Label><Input value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} required /></div>
            <div><Label>Email</Label><Input type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Company</Label><Input value={formData.company} onChange={e => setFormData({...formData, company: e.target.value})} /></div>
              <div><Label>Job Title</Label><Input value={formData.job_title} onChange={e => setFormData({...formData, job_title: e.target.value})} /></div>
            </div>
            <div><Label>Notes</Label><Input value={formData.notes} onChange={e => setFormData({...formData, notes: e.target.value})} /></div>
            <div className="flex gap-3 justify-end">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700">{editingContact ? 'Update' : 'Create'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}