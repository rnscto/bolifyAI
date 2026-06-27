import React, { useState, useEffect } from 'react';
import { apiClient, apiFetch } from '@/api/apiClient';
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
  DialogFooter,
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
import { Plus, Edit, Trash2, FileText, CreditCard, Download, Crown } from 'lucide-react';
import { toast } from 'sonner';
import ClientAgreementTemplateEditor from '../components/admin/ClientAgreementTemplateEditor';
import AdminSignedAgreements from '../components/admin/AdminSignedAgreements';
import AdminKYCManagement from '../components/admin/AdminKYCManagement';
import ActivateClientDialog from '../components/admin/ActivateClientDialog';
import CEOStatusOverrideDialog from '../components/admin/CEOStatusOverrideDialog';
import ResellerTopupDialog from '../components/reseller/ResellerTopupDialog';
import { ArrowDownCircle, ArrowRightLeft } from 'lucide-react';

export default function AdminClients() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [users, setUsers] = useState([]);
  const [activateClient, setActivateClient] = useState(null);
  const [overrideClient, setOverrideClient] = useState(null);
  const [resellerTopupClient, setResellerTopupClient] = useState(null);
  const [deleteClient, setDeleteClient] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [roleClient, setRoleClient] = useState(null);
  const [selectedRole, setSelectedRole] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [pricingLimits, setPricingLimits] = useState(null);
  const [formData, setFormData] = useState({
    company_name: '',
    email: '',
    phone: '',
    total_channels: 1,
    user_id: '',
    per_minute_rate: '',
    monthly_rate_per_channel: ''
  });

  useEffect(() => {
    loadClients();
    apiClient.auth.me().then(user => {
      setCurrentUser(user);
      if (user.role === 'reseller' || user.role === 'master_reseller') {
        fetchPricingLimits();
      }
    }).catch(() => {});
  }, []);

  const fetchPricingLimits = async () => {
    try {
      const res = await apiFetch('/reseller/pricing-limits');
      if (res.success) {
        setPricingLimits(res);
        setFormData(prev => ({
          ...prev,
          per_minute_rate: res.min_per_minute_rate,
          monthly_rate_per_channel: res.min_monthly_rate_per_channel
        }));
      }
    } catch (err) {
      console.error('Failed to fetch pricing limits', err);
    }
  };

  const loadClients = async () => {
    try {
      const res = await apiClient.functions.invoke('adminListClients', { action: 'list' });
      setClients(res.data.clients || []);
      setUsers(res.data.users || []);
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
        monthly_rate_per_channel: formData.monthly_rate_per_channel ? Number(formData.monthly_rate_per_channel) : 6500,
        per_minute_rate: formData.per_minute_rate ? Number(formData.per_minute_rate) : undefined,
        next_billing_date: nextBillingDate.toISOString().split('T')[0]
      };

      if (editingClient) {
        await apiClient.functions.invoke('adminListClients', { action: 'update', client_id: editingClient.id, data: clientData });
        toast.success('Client updated successfully');
      } else {
        await apiClient.functions.invoke('adminListClients', { action: 'create', data: clientData });
        toast.success('Client created successfully');
      }

      setDialogOpen(false);
      setEditingClient(null);
      setFormData({ 
        company_name: '', 
        email: '', 
        phone: '', 
        total_channels: 1, 
        user_id: '',
        per_minute_rate: pricingLimits?.min_per_minute_rate || '',
        monthly_rate_per_channel: pricingLimits?.min_monthly_rate_per_channel || ''
      });
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
      user_id: client.user_id || '',
      per_minute_rate: client.per_minute_rate || pricingLimits?.min_per_minute_rate || '',
      monthly_rate_per_channel: client.monthly_rate_per_channel || pricingLimits?.min_monthly_rate_per_channel || ''
    });
    setDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (deleteConfirmText !== 'DELETE') return;
    try {
      await apiClient.functions.invoke('adminListClients', { action: 'delete', client_id: deleteClient.id });
      toast.success('Client deleted');
      loadClients();
      setDeleteClient(null);
    } catch (error) {
      console.error('Error deleting client:', error);
      toast.error('Failed to delete client');
    }
  };

  const saveRole = async () => {
    try {
      const res = await apiFetch('/reseller/admin/promote', {
        method: 'POST',
        body: JSON.stringify({ client_id: roleClient.id, new_role: selectedRole })
      });
      if (res.error) throw new Error(res.error);
      toast.success(res.message || 'Role updated');
      loadClients();
      setRoleClient(null);
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'Failed to update role');
    }
  };

  const statusColors = {
    active: 'bg-green-100 text-green-800',
    suspended: 'bg-yellow-100 text-yellow-800',
    cancelled: 'bg-red-100 text-red-800'
  };

  const filteredClients = statusFilter === 'all'
    ? clients
    : clients.filter((c) => c.account_status === statusFilter);

  const handleExportCSV = () => {
    if (filteredClients.length === 0) {
      toast.error('No clients to export');
      return;
    }
    const headers = ['Company', 'Email', 'Phone', 'Billing Type', 'Per Min Rate', 'Wallet Balance', 'Free Minutes', 'Account Status', 'KYC Status', 'Status', 'Activated (Paid)', 'Next Billing'];
    const rows = filteredClients.map((c) => [
      c.company_name || '',
      c.email || '',
      c.phone || '',
      c.billing_type || '',
      c.per_minute_rate ?? '',
      c.wallet_balance ?? '',
      c.free_minutes_remaining ?? '',
      c.account_status || '',
      c.kyc_status || '',
      c.status || '',
      c.activation_date ? new Date(c.activation_date).toLocaleDateString() : '',
      c.next_billing_date ? new Date(c.next_billing_date).toLocaleDateString() : '',
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `clients-${statusFilter}-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="trial">Trial</SelectItem>
              <SelectItem value="activation_pending">Activation in progress</SelectItem>
              <SelectItem value="onboarding">Onboarding</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={handleExportCSV}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        </div>
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
                  Base cost: ₹{(formData.total_channels * (pricingLimits?.min_monthly_rate_per_channel || 6500)).toLocaleString()}/month
                </p>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="per_minute_rate">Per Minute Rate (Retail ₹)</Label>
                  <Input
                    id="per_minute_rate"
                    type="number"
                    step="0.1"
                    min={pricingLimits?.min_per_minute_rate || 0}
                    value={formData.per_minute_rate}
                    onChange={(e) => setFormData({ ...formData, per_minute_rate: e.target.value })}
                  />
                  {pricingLimits && (
                    <p className="text-xs text-gray-500 mt-1">Min: ₹{pricingLimits.min_per_minute_rate}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="monthly_rate_per_channel">Monthly Channel Rate (Retail ₹)</Label>
                  <Input
                    id="monthly_rate_per_channel"
                    type="number"
                    min={pricingLimits?.min_monthly_rate_per_channel || 0}
                    value={formData.monthly_rate_per_channel}
                    onChange={(e) => setFormData({ ...formData, monthly_rate_per_channel: e.target.value })}
                  />
                  {pricingLimits && (
                    <p className="text-xs text-gray-500 mt-1">Min: ₹{pricingLimits.min_monthly_rate_per_channel}</p>
                  )}
                </div>
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
          <CardTitle>All Clients ({filteredClients.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead>Balance / Minutes</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>KYC</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Activated (Paid)</TableHead>
                <TableHead>Next Billing</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredClients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-gray-500">
                    No clients found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredClients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-medium">{client.company_name}</TableCell>
                    <TableCell>{client.email}</TableCell>
                    <TableCell>{client.phone || '-'}</TableCell>
                    <TableCell>
                      <Badge className="bg-gray-100 text-gray-800">
                        {users.find(u => u.client_id === client.id)?.role?.replace('_', ' ') || 'user'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={client.billing_type === 'unlimited' ? 'bg-purple-100 text-purple-800' : 'bg-cyan-100 text-cyan-800'}>
                        {client.billing_type === 'unlimited' ? `Unlimited ×${client.total_channels || 1}` : `₹${client.per_minute_rate || 4}/min`}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {client.billing_type === 'unlimited' ? (
                        <span className="text-sm text-gray-500">—</span>
                      ) : (
                        <div className="text-xs space-y-0.5">
                          <div className={`font-medium ${(client.wallet_balance || 0) < 100 ? 'text-red-600' : 'text-green-700'}`}>
                            ₹{(client.wallet_balance || 0).toLocaleString()}
                          </div>
                          {(client.free_minutes_remaining || 0) > 0 && (
                            <div className="text-blue-600">{client.free_minutes_remaining} free min</div>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={{
                        active: 'bg-green-100 text-green-800',
                        trial: 'bg-blue-100 text-blue-800',
                        activation_pending: 'bg-amber-100 text-amber-800',
                        expired: 'bg-red-100 text-red-800',
                        onboarding: 'bg-yellow-100 text-yellow-800',
                        suspended: 'bg-gray-100 text-gray-800',
                      }[client.account_status] || 'bg-gray-100 text-gray-800'}>
                        {client.account_status === 'activation_pending'
                          ? 'Activation in progress'
                          : (client.account_status || 'unknown')}
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
                      {client.activation_date ?
                        new Date(client.activation_date).toLocaleDateString() : '-'}
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
                          title="Manage Account & Billing"
                          onClick={() => setActivateClient(client)}
                        >
                          <CreditCard className="w-4 h-4 text-blue-600" />
                        </Button>
                        {['reseller', 'master_reseller'].includes(currentUser?.role) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Top-Up Downline Wallet"
                            onClick={() => setResellerTopupClient(client)}
                          >
                            <ArrowRightLeft className="w-4 h-4 text-green-600" />
                          </Button>
                        )}
                        {['admin', 'master_admin'].includes(currentUser?.role) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Override status → Expired / Suspended / Trial"
                            onClick={() => setOverrideClient(client)}
                          >
                            <ArrowDownCircle className="w-4 h-4 text-amber-600" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Edit Details"
                          onClick={() => handleEdit(client)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Manage Role"
                          onClick={() => {
                            setRoleClient(client);
                            setSelectedRole(users.find(u => u.client_id === client.id)?.role || 'user');
                          }}
                        >
                          <Crown className="w-4 h-4 text-purple-600" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600"
                          title="Delete Client"
                          onClick={() => {
                            setDeleteClient(client);
                            setDeleteConfirmText('');
                          }}
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
      {activateClient && (
        <ActivateClientDialog
          client={activateClient}
          open={!!activateClient}
          onOpenChange={(open) => { if (!open) setActivateClient(null); }}
          onUpdated={loadClients}
        />
      )}
      {overrideClient && (
        <CEOStatusOverrideDialog
          client={overrideClient}
          currentUser={currentUser}
          open={!!overrideClient}
          onOpenChange={(open) => { if (!open) setOverrideClient(null); }}
          onUpdated={loadClients}
        />
      )}
      {resellerTopupClient && (
        <ResellerTopupDialog
          client={resellerTopupClient}
          me={currentUser}
          open={!!resellerTopupClient}
          onOpenChange={(open) => { if (!open) setResellerTopupClient(null); }}
          onSubmitted={loadClients}
        />
      )}
      <Dialog open={!!deleteClient} onOpenChange={(open) => !open && setDeleteClient(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Client Account</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              This action is permanent and cannot be undone. All data associated with {deleteClient?.company_name} will be deleted.
              <br/><br/>
              To confirm, type <strong>DELETE</strong> below.
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="DELETE"
              className="border-red-300 focus-visible:ring-red-500"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteClient(null)}>Cancel</Button>
            <Button 
              className="bg-red-600 hover:bg-red-700 text-white" 
              onClick={confirmDelete} 
              disabled={deleteConfirmText !== 'DELETE'}
            >
              Confirm Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!roleClient} onOpenChange={(open) => !open && setRoleClient(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage Role: {roleClient?.company_name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <Label>Select Role</Label>
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="master_admin">Master Admin</SelectItem>
                  <SelectItem value="reseller">Reseller</SelectItem>
                  <SelectItem value="master_reseller">Master Reseller</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleClient(null)}>Cancel</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={saveRole}>
              Save Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}