import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Edit, Trash2, FileText } from 'lucide-react';
import { toast } from 'sonner';
import ClientAgreementTemplateEditor from '../components/admin/ClientAgreementTemplateEditor';
import AdminSignedAgreements from '../components/admin/AdminSignedAgreements';
import AdminKYCManagement from '../components/admin/AdminKYCManagement';

export default function AdminClients() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [users, setUsers] = useState([]);
  const [formData, setFormData] = useState({
    company_name: '',
    email: '',
    phone: '',
    total_channels: 1,
    user_id: ''
  });

  useEffect(() => {
    loadClients();
  }, []);

  const loadClients = async () => {
    try {
      const [clientsData, usersData] = await Promise.all([
        base44.entities.Client.list('-created_date'),
        base44.entities.User.list()
      ]);
      setClients(clientsData);
      setUsers(usersData);
    } catch (error) {
      console.error('Error loading clients:', error);
      toast.error('Failed to load clients');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const nextBillingDate = new Date();
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 3);

      const clientData = {
        ...formData,
        status: 'active',
        subscription_plan: 'quarterly',
        monthly_rate_per_channel: 6500,
        next_billing_date: nextBillingDate.toISOString().split('T')[0]
      };

      if (editingClient) {
        await base44.entities.Client.update(editingClient.id, clientData);
        toast.success('Client updated successfully');
      } else {
        await base44.entities.Client.create(clientData);
        toast.success('Client created successfully');
      }

      setDialogOpen(false);
      setEditingClient(null);
      setFormData({ company_name: '', email: '', phone: '', total_channels: 1, user_id: '' });
      loadClients();
    } catch (error) {
      console.error('Error saving client:', error);
      toast.error('Failed to save client');
    }
  };

  const handleEdit = (client) => {
    setEditingClient(client);
    setFormData({
      company_name: client.company_name,
      email: client.email,
      phone: client.phone || '',
      total_channels: client.total_channels,
      user_id: client.user_id || ''
    });
    setDialogOpen(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this client?')) return;
    
    try {
      await base44.entities.Client.delete(id);
      toast.success('Client deleted');
      loadClients();
    } catch (error) {
      console.error('Error deleting client:', error);
      toast.error('Failed to delete client');
    }
  };

  const statusColors = {
    active: 'bg-green-100 text-green-800',
    suspended: 'bg-yellow-100 text-yellow-800',
    cancelled: 'bg-red-100 text-red-800'
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
          <h1 className="text-3xl font-bold text-gray-900">Clients</h1>
          <p className="text-gray-600 mt-1">Manage your client accounts</p>
        </div>
      </div>

      <Tabs defaultValue="clients">
        <TabsList>
          <TabsTrigger value="clients">Clients ({clients.length})</TabsTrigger>
          <TabsTrigger value="kyc">KYC Verification</TabsTrigger>
          <TabsTrigger value="signed"><FileText className="w-4 h-4 mr-1" /> Signed Agreements</TabsTrigger>
          <TabsTrigger value="agreements">Agreement Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="clients">
      <div className="flex items-center justify-end">
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Add Client
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingClient ? 'Edit Client' : 'Add New Client'}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="company_name">Company Name</Label>
                <Input
                  id="company_name"
                  value={formData.company_name}
                  onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
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
                  required
                />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="user_id">Assign to User Account</Label>
                <Select 
                  value={formData.user_id}
                  onValueChange={(value) => setFormData({ ...formData, user_id: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select user (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.filter(u => u.role !== 'admin').map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.full_name} ({user.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500 mt-1">
                  Link this client to a user account for portal access
                </p>
              </div>
              <div>
                <Label htmlFor="total_channels">Number of Channels</Label>
                <Input
                  id="total_channels"
                  type="number"
                  min="1"
                  value={formData.total_channels}
                  onChange={(e) => setFormData({ ...formData, total_channels: parseInt(e.target.value) })}
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  ₹{(formData.total_channels * 6500).toLocaleString()}/month
                </p>
              </div>
              <div className="flex gap-3 justify-end">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                  {editingClient ? 'Update' : 'Create'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Clients ({clients.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>KYC</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Next Billing</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-gray-500">
                    No clients found. Add your first client to get started.
                  </TableCell>
                </TableRow>
              ) : (
                clients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-medium">{client.company_name}</TableCell>
                    <TableCell>{client.email}</TableCell>
                    <TableCell>{client.phone || '-'}</TableCell>
                    <TableCell>{client.total_channels}</TableCell>
                    <TableCell>
                      <Badge className={{
                        active: 'bg-green-100 text-green-800',
                        trial: 'bg-blue-100 text-blue-800',
                        expired: 'bg-red-100 text-red-800',
                        onboarding: 'bg-yellow-100 text-yellow-800',
                        suspended: 'bg-gray-100 text-gray-800',
                      }[client.account_status] || 'bg-gray-100 text-gray-800'}>
                        {client.account_status || 'unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={{
                        pending: 'bg-yellow-100 text-yellow-800',
                        under_review: 'bg-blue-100 text-blue-800',
                        approved: 'bg-green-100 text-green-800',
                        rejected: 'bg-red-100 text-red-800',
                        not_required: 'bg-gray-100 text-gray-800',
                      }[client.kyc_status] || 'bg-yellow-100 text-yellow-800'}>
                        {(client.kyc_status || 'pending').replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[client.status]}>
                        {client.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {client.next_billing_date ? 
                        new Date(client.next_billing_date).toLocaleDateString() : '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEdit(client)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(client.id)}
                        >
                          <Trash2 className="w-4 h-4 text-red-600" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="kyc">
          <AdminKYCManagement />
        </TabsContent>

        <TabsContent value="signed">
          <AdminSignedAgreements />
        </TabsContent>

        <TabsContent value="agreements">
          <ClientAgreementTemplateEditor />
        </TabsContent>
      </Tabs>
    </div>
  );
}