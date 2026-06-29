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
  DialogFooter
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, Phone, RefreshCw, Lock, Unlock, Share2, Wallet, Users } from 'lucide-react';
import { toast } from 'sonner';

export default function AdminDIDs() {
  const [dids, setDids] = useState([]);
  const [clients, setClients] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  
  const [formData, setFormData] = useState({
    number: '',
    country_code: '+91',
    client_id: '',
    monthly_cost: 6500,
    is_free: false
  });

  const [assignDialog, setAssignDialog] = useState({ 
    open: false, 
    didId: null, 
    mode: 'partner', 
    partnerId: 'unassigned', 
    clientId: '', 
    agentId: '', 
    isFree: false 
  });
  
  const [activeTab, setActiveTab] = useState('all');

  const [me, setMe] = useState(null);
  const [resellerWallet, setResellerWallet] = useState(0);

  useEffect(() => {
    apiClient.auth.me().then(user => {
      setMe(user);
      if (['reseller', 'master_reseller'].includes(user.role)) {
        apiClient.Client.get(user.client_id).then(c => setResellerWallet(Number(c.wallet_balance || 0))).catch(() => {});
      }
    }).catch(() => {});
    loadData();
  }, []);

  useEffect(() => {
    if (assignDialog.mode === 'agent' && assignDialog.clientId) {
      apiClient.Agent.filter({ client_id: assignDialog.clientId })
        .then(data => setAgents(data))
        .catch(() => setAgents([]));
    } else {
      setAgents([]);
    }
  }, [assignDialog.mode, assignDialog.clientId]);

  const loadData = async () => {
    try {
      const [didsData, clientsData] = await Promise.all([
        apiClient.DID.list('-created_at', 5000),
        apiClient.Client.list('', 1000)
      ]);
      setDids(didsData);
      setClients(clientsData);
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const didData = {
        number: formData.number,
        country_code: formData.country_code,
        status: formData.client_id ? 'assigned' : 'available',
        client_id: formData.client_id || null,
        monthly_cost: formData.monthly_cost,
        is_free: formData.is_free
      };

      await apiClient.DID.create(didData);
      toast.success('DID added successfully');
      setDialogOpen(false);
      setFormData({ number: '', country_code: '+91', client_id: '', monthly_cost: 6500, is_free: false });
      loadData();
    } catch (error) {
      console.error('Error creating DID:', error);
      toast.error('Failed to add DID');
    }
  };

  const submitAssign = async (e) => {
    e.preventDefault();
    try {
      const { didId, mode, partnerId, clientId, agentId, isFree } = assignDialog;
      const did = dids.find(d => d.id === didId);
      if (!did) return;

      let newClientId = null;
      let newAgentId = null;

      if (mode === 'partner') {
        newClientId = partnerId === 'unassigned' ? null : partnerId;
      } else {
        if (!clientId) throw new Error('Please select a client');
        if (!agentId) throw new Error('Please select an agent');
        newClientId = clientId;
        newAgentId = agentId;
      }

      await apiClient.DID.update(didId, {
        client_id: newClientId,
        agent_id: newAgentId,
        status: newClientId ? 'assigned' : 'available',
        is_free: isFree
      });

      // Assign DID to the new Agent if applicable
      if (newAgentId && did.number) {
        const agent = await apiClient.Agent.get(newAgentId);
        const agentDIDs = agent.assigned_dids || (agent.assigned_did ? [agent.assigned_did] : []);
        if (!agentDIDs.includes(did.number)) {
          const updatedDIDs = [...agentDIDs, did.number];
          await apiClient.Agent.update(newAgentId, {
            assigned_dids: updatedDIDs,
            assigned_did: updatedDIDs[0]
          });
        }
      }

      // Cleanup old Agent if DID was moved away from them
      if (did.agent_id && did.agent_id !== newAgentId && did.number) {
        try {
          const oldAgent = await apiClient.Agent.get(did.agent_id);
          const oldDIDs = oldAgent.assigned_dids || (oldAgent.assigned_did ? [oldAgent.assigned_did] : []);
          if (oldDIDs.includes(did.number)) {
            const newDIDs = oldDIDs.filter(d => d !== did.number);
            await apiClient.Agent.update(oldAgent.id, {
              assigned_dids: newDIDs,
              assigned_did: newDIDs[0] || ''
            });
          }
        } catch (err) {
          console.error('Failed to cleanup old agent DID', err);
        }
      }

      toast.success('DID assignment updated successfully');
      setAssignDialog({ ...assignDialog, open: false });
      loadData();
    } catch (error) {
      console.error('Error assigning DID:', error);
      toast.error(error.message || 'Failed to assign DID');
    }
  };

  const handlePurchaseDID = async () => {
    if (!confirm('Are you sure you want to purchase a new DID for ₹300? This will be deducted from your wallet.')) return;
    try {
      setLoading(true);
      const res = await apiFetch('/reseller/purchase-did', {
        method: 'POST'
      });
      if (res.error) throw new Error(res.error);
      
      toast.success('DID purchased successfully! It has been added to your pool.');
      loadData();
    } catch (error) {
      console.error('Error purchasing DID:', error);
      toast.error(error.message || 'Failed to purchase DID');
      setLoading(false);
    }
  };

  const handleSyncSmartflo = async () => {
    setSyncing(true);
    try {
      const response = await apiClient.post('/v1/integrations/smartflo/fetch-dids', {});
      if (response.success) {
        toast.success(response.message || `Successfully synced DIDs. Added: ${response.new_dids_added}`);
        loadData();
      } else {
        toast.error(response.error || 'Failed to sync DIDs');
      }
    } catch (error) {
      console.error('Error syncing DIDs:', error);
      toast.error('Failed to sync DIDs from Smartflo');
    } finally {
      setSyncing(false);
    }
  };

  const handleReserve = async (didId, markAsDemo = false) => {
    const did = dids.find(d => d.id === didId);
    if (!did) return;
    const isReserved = did.status === 'reserved';
    try {
      if (isReserved) {
        // Unreserve → make available
        await apiClient.DID.update(didId, {
          status: 'available',
          reserved_note: '',
          is_demo: false
        });
        toast.success('DID unreserved');
      } else {
        const note = markAsDemo ? 'Shared Demo Pool DID' : (prompt('Reserve note (optional):') || '');
        await apiClient.DID.update(didId, {
          status: 'reserved',
          client_id: null,
          agent_id: null,
          reserved_note: note,
          is_demo: markAsDemo
        });
        // Remove from any agent
        if (did.client_id && did.number) {
          const agents = await apiClient.Agent.filter({ client_id: did.client_id });
          for (const agent of agents) {
            const agentDIDs = agent.assigned_dids || (agent.assigned_did ? [agent.assigned_did] : []);
            if (agentDIDs.includes(did.number)) {
              const newDIDs = agentDIDs.filter(d => d !== did.number);
              await apiClient.Agent.update(agent.id, {
                assigned_dids: newDIDs,
                assigned_did: newDIDs[0] || ''
              });
            }
          }
        }
        toast.success(markAsDemo ? 'DID added to Demo Pool' : 'DID reserved');
      }
      loadData();
    } catch (error) {
      toast.error('Failed to update DID');
    }
  };

  const statusColors = {
    available: 'bg-green-100 text-green-800',
    assigned: 'bg-blue-100 text-blue-800',
    reserved: 'bg-amber-100 text-amber-800',
    inactive: 'bg-gray-100 text-gray-800'
  };

  const getClientName = (clientId) => {
    const client = clients.find(c => c.id === clientId);
    return client?.company_name || '-';
  };

  const openAssignDialog = (did) => {
    setAssignDialog({
      open: true,
      didId: did.id,
      mode: 'partner',
      partnerId: did.client_id || 'unassigned',
      clientId: '',
      agentId: did.agent_id || '',
      isFree: did.is_free || false
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const displayedDids = dids.filter(did => {
    if (activeTab === 'free') return did.is_free === true;
    if (activeTab === 'paid') return did.is_free !== true;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">DID Bank & Manager</h1>
          <p className="text-gray-600 mt-1">Manage your DID pool, allocate to partners, or assign to agents</p>
        </div>
        <div className="flex gap-3">
          {me?.role === 'admin' || me?.role === 'master_admin' ? (
            <Button 
              onClick={handleSyncSmartflo} 
              disabled={syncing}
              variant="outline"
              className="border-blue-600 text-blue-600 hover:bg-blue-50"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync from Smartflo'}
            </Button>
          ) : (
            <Button 
              onClick={() => handlePurchaseDID()} 
              variant="outline"
              className="border-indigo-600 text-indigo-700 hover:bg-indigo-50"
            >
              <Wallet className="w-4 h-4 mr-2" />
              Buy DID (₹300)
            </Button>
          )}
          
          {(me?.role === 'admin' || me?.role === 'master_admin') && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-2" />
                  Add DID
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New DID</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="number">Phone Number</Label>
                  <Input
                    id="number"
                    value={formData.number}
                    onChange={(e) => setFormData({ ...formData, number: e.target.value })}
                    placeholder="911234567890"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="country_code">Country Code</Label>
                  <Input
                    id="country_code"
                    value={formData.country_code}
                    onChange={(e) => setFormData({ ...formData, country_code: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="client_id">Assign to Client (Optional)</Label>
                  <Select
                    value={formData.client_id || 'unassigned'}
                    onValueChange={(value) => setFormData({ ...formData, client_id: value === 'unassigned' ? '' : value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select client" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                      {clients.map((client) => (
                        <SelectItem key={client.id} value={client.id}>
                          {client.company_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="monthly_cost">Monthly Cost (₹)</Label>
                  <Input
                    id="monthly_cost"
                    type="number"
                    value={formData.monthly_cost}
                    onChange={(e) => setFormData({ ...formData, monthly_cost: parseInt(e.target.value) })}
                    required
                  />
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox 
                    id="is_free" 
                    checked={formData.is_free} 
                    onCheckedChange={(checked) => setFormData({ ...formData, is_free: checked })}
                  />
                  <Label htmlFor="is_free">Mark as Free DID</Label>
                </div>
                <div className="flex gap-3 justify-end">
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                    Add DID
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-green-50 rounded-lg">
                <Phone className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {dids.filter(d => d.status === 'available').length}
                </p>
                <p className="text-sm text-gray-600">Available DIDs</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-50 rounded-lg">
                <Phone className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {dids.filter(d => d.status === 'assigned').length}
                </p>
                <p className="text-sm text-gray-600">Assigned DIDs</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-emerald-50 rounded-lg">
                <Users className="w-6 h-6 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {dids.filter(d => d.is_free).length}
                </p>
                <p className="text-sm text-gray-600">Free Pool DIDs</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-gray-50 rounded-lg">
                <Phone className="w-6 h-6 text-gray-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{dids.length}</p>
                <p className="text-sm text-gray-600">Total DIDs</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>DID Bank</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="mb-4">
            <TabsList>
              <TabsTrigger value="all">All DIDs</TabsTrigger>
              <TabsTrigger value="free">Free DID Pool</TabsTrigger>
              <TabsTrigger value="paid">Paid DID Pool</TabsTrigger>
            </TabsList>
          </Tabs>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pool Type</TableHead>
                <TableHead>Assigned Partner/Client</TableHead>
                <TableHead>Assigned Agent</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayedDids.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No DIDs found in this pool.
                  </TableCell>
                </TableRow>
              ) : (
                displayedDids.map((did) => (
                  <TableRow key={did.id}>
                    <TableCell className="font-medium">{did.number}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge className={statusColors[did.status]}>
                          {did.status}
                        </Badge>
                        {did.is_demo && (
                          <Badge className="bg-amber-100 text-amber-800">
                            <Share2 className="w-3 h-3 mr-1" />Demo Pool
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {did.is_free ? (
                        <Badge variant="outline" className="text-emerald-600 border-emerald-600 bg-emerald-50">Free Pool</Badge>
                      ) : (
                        <Badge variant="outline" className="text-indigo-600 border-indigo-600 bg-indigo-50">Paid Pool (₹{did.monthly_cost})</Badge>
                      )}
                    </TableCell>
                    <TableCell>{getClientName(did.client_id)}</TableCell>
                    <TableCell>
                      {did.agent_id ? <span className="text-blue-600 font-medium">Assigned</span> : <span className="text-gray-400">Not assigned</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => openAssignDialog(did)}
                          disabled={did.status === 'reserved'}
                        >
                          Manage Assignment
                        </Button>
                        
                        {did.status === 'reserved' ? (
                          <Button
                            size="sm"
                            variant="default"
                            className="bg-amber-500 hover:bg-amber-600 text-white"
                            onClick={() => handleReserve(did.id)}
                            title={`Reserved: ${did.reserved_note || 'No note'}. Click to unreserve.`}
                          >
                            <Unlock className="w-4 h-4" />
                          </Button>
                        ) : (
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleReserve(did.id, true)}
                              title="Add to shared Demo Pool (trial/demo agents will use this)"
                              className="text-amber-600 border-amber-300 hover:bg-amber-50"
                            >
                              <Share2 className="w-4 h-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleReserve(did.id, false)}
                              title="Reserve this DID (not for demo)"
                            >
                              <Lock className="w-4 h-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Assignment Dialog */}
      <Dialog open={assignDialog.open} onOpenChange={(open) => setAssignDialog({...assignDialog, open})}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Manage DID Assignment</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitAssign} className="space-y-4 pt-4">
            
            <div className="space-y-2">
              <Label>Assignment Mode</Label>
              <Select 
                value={assignDialog.mode} 
                onValueChange={(val) => setAssignDialog({...assignDialog, mode: val})}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="partner">Transfer to Partner/Reseller Pool</SelectItem>
                  <SelectItem value="agent">Assign directly to Client's Agent</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {assignDialog.mode === 'partner' ? (
              <>
                <div className="space-y-2">
                  <Label>Select Partner / Pool</Label>
                  <Select 
                    value={assignDialog.partnerId} 
                    onValueChange={(val) => setAssignDialog({...assignDialog, partnerId: val})}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select partner" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">Unassigned (Global Pool)</SelectItem>
                      {clients.map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-2 pt-2">
                  <Checkbox 
                    id="assign_is_free" 
                    checked={assignDialog.isFree} 
                    onCheckedChange={(checked) => setAssignDialog({...assignDialog, isFree: checked})}
                  />
                  <Label htmlFor="assign_is_free" className="font-normal cursor-pointer">
                    Transfer as <b>Free DID</b> (Does not consume paid quotas)
                  </Label>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>1. Select Client</Label>
                  <Select 
                    value={assignDialog.clientId} 
                    onValueChange={(val) => setAssignDialog({...assignDialog, clientId: val, agentId: ''})}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select client" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="space-y-2">
                  <Label>2. Select Agent</Label>
                  <Select 
                    value={assignDialog.agentId} 
                    onValueChange={(val) => setAssignDialog({...assignDialog, agentId: val})}
                    disabled={!assignDialog.clientId || agents.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={agents.length === 0 ? (assignDialog.clientId ? "No agents found" : "Select client first") : "Select agent"} />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map(a => (
                        <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setAssignDialog({...assignDialog, open: false})}>Cancel</Button>
              <Button type="submit" className="bg-blue-600 hover:bg-blue-700">Save Assignment</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}