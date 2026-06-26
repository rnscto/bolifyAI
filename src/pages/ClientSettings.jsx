import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { User, Building, Save, Loader2, Shield, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';
import ClientComplianceTab from '../components/compliance/ClientComplianceTab';
import ClientAgreementViewer from '../components/client/ClientAgreementViewer';
import KYCUpload from '../components/client/KYCUpload';

export default function ClientSettings() {
  const { checkAppState } = useAuth();
  const [user, setUser] = useState(null);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    display_name: '',
    company_name: '',
    email: '',
    phone: '',
    registered_address: '',
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const currentUser = await apiClient.auth.me();
    setUser(currentUser);
    setFormData(prev => ({ ...prev, display_name: currentUser.display_name || currentUser.full_name || '' }));

    const clients = await apiClient.Client.filter({ user_id: currentUser.id });
    if (clients.length > 0) {
      const c = clients[0];
      setClient(c);
      setFormData({
        display_name: currentUser.display_name || currentUser.full_name || '',
        company_name: c.company_name || '',
        email: c.email || '',
        phone: c.phone || '',
        registered_address: c.registered_address || '',
      });
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiClient.auth.updateMe({ display_name: formData.display_name });
      if (client) {
        await apiClient.Client.update(client.id, {
          company_name: formData.company_name,
          phone: formData.phone,
          registered_address: formData.registered_address,
        });
      }
      toast.success('Settings saved');
      await loadData(); // Reload local state
      await checkAppState(); // Reload global AuthContext to update Header
    } catch (error) {
      toast.error('Failed to save settings');
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const accountColors = {
    active: 'bg-green-100 text-green-800',
    trial: 'bg-blue-100 text-blue-800',
    expired: 'bg-red-100 text-red-800',
    onboarding: 'bg-yellow-100 text-yellow-800',
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600 mt-1">Manage your profile, account, and compliance</p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList className="mb-4">
          <TabsTrigger value="profile">Profile & Account</TabsTrigger>
          <TabsTrigger value="kyc"><Shield className="w-4 h-4 mr-1" /> KYC</TabsTrigger>
          <TabsTrigger value="agreement"><FileText className="w-4 h-4 mr-1" /> Agreement</TabsTrigger>
          <TabsTrigger value="compliance"><Shield className="w-4 h-4 mr-1" /> Compliance</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
        <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><User className="w-5 h-5" /> Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="display_name">Display Name</Label>
            <Input id="display_name" value={formData.display_name} onChange={(e) => setFormData({ ...formData, display_name: e.target.value })} placeholder="The name shown across your dashboard" />
            <p className="text-xs text-gray-400 mt-1">This is the name shown in the sidebar and across the dashboard.</p>
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={user?.email || ''} disabled className="bg-gray-50" />
            <p className="text-xs text-gray-400 mt-1">Email cannot be changed</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Building className="w-5 h-5" /> Company</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="company_name">Company Name</Label>
            <Input id="company_name" value={formData.company_name} onChange={(e) => setFormData({ ...formData, company_name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="phone">Phone</Label>
            <Input id="phone" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="registered_address">Registered Address</Label>
            <textarea
              id="registered_address"
              value={formData.registered_address}
              onChange={(e) => setFormData({ ...formData, registered_address: e.target.value })}
              placeholder="Registered business address"
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[70px]"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Shield className="w-5 h-5" /> Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Account Status</span>
            <Badge className={accountColors[client?.account_status] || 'bg-gray-100'}>
              {client?.account_status || 'unknown'}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Role</span>
            <span className="text-sm font-medium capitalize">{user?.role}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Industry</span>
            <span className="text-sm font-medium">{client?.industry || 'Not set'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Joined</span>
            <span className="text-sm font-medium">
              {user?.created_at ? new Date(user.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'}
            </span>
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSave} disabled={saving} className="w-full bg-blue-600 hover:bg-blue-700 h-11">
        {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
        Save Changes
      </Button>
      </div>
        </TabsContent>

        <TabsContent value="kyc">
          {client && <KYCUpload client={client} />}
        </TabsContent>

        <TabsContent value="agreement">
          {client && <ClientAgreementViewer clientId={client.id} />}
        </TabsContent>

        <TabsContent value="compliance">
          {client && <ClientComplianceTab client={client} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}