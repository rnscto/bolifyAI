import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
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
import { Plus, Phone, RefreshCw, Lock, Unlock, Share2 } from 'lucide-react';
import { toast } from 'sonner';

export default function AdminDIDs() {
  const [dids, setDids] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    number: '',
    country_code: '+91',
    client_id: '',
    monthly_cost: 6500
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [didsData, clientsData] = await Promise.all([
        apiClient.DID.list('-created_at'),
        apiClient.Client.list()
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
        monthly_cost: formData.monthly_cost
      };

      await apiClient.DID.create(didData);
      toast.success('DID added successfully');
      setDialogOpen(false);
      setFormData({ number: '', country_code: '+91', client_id: '', monthly_cost: 6500 });
      loadData();
    } catch (error) {
      console.error('Error creating DID:', error);
      toast.error('Failed to add DID');
    }
  };

  const handleAssign = async (didId, clientId) => {
    try {
      const did = dids.find(d => d.id === didId);
      const oldClientId = did?.client_id;

      // Update DID entity
      await apiClient.DID.update(didId, {
        client_id: clientId || null,
        agent_id: clientId ? did?.agent_id : null,
        status: clientId ? 'assigned' : 'available'
      });

      // If unassigning from old client, remove DID from that client's agents
      if (oldClientId && oldClientId !== clientId && did?.number) {
        const oldAgents = await apiClient.Agent.filter({ client_id: oldClientId });
        for (const agent of oldAgents) {
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

      // If assigning to a new client, auto-assign to their first agent if they have one
      if (clientId && did?.number) {
        const newAgents = await apiClient.Agent.filter({ client_id: clientId });
        if (newAgents.length > 0) {
          const agent = newAgents[0];
          const agentDIDs = agent.assigned_dids || (agent.assigned_did ? [agent.assigned_did] : []);
          if (!agentDIDs.includes(did.number)) {
            const updatedDIDs = [...agentDIDs, did.number];
            await apiClient.Agent.update(agent.id, {
              assigned_dids: updatedDIDs,
              assigned_did: updatedDIDs[0]
            });
          }
          await apiClient.DID.update(didId, { agent_id: agent.id });
        }
      }

      toast.success('DID assignment updated');
      loadData();
    } catch (error) {
      console.error('Error updating DID:', error);
      toast.error('Failed to update DID');
    }
  };

  const handleSyncSmartflo = async () => {
    setSyncing(true);
    try {
      const response = await apiClient.functions.invoke('fetchSmartfloDIDs', {});
      if (response.data.success) {
        toast.success(response.data.message);
        loadData();
      } else {
        toast.error(response.data.error || 'Failed to sync DIDs');
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
          <h1 className="text-3xl font-bold text-gray-900">DID Management</h1>
          <p className="text-gray-600 mt-1">Manage phone numbers and assignments</p>
        </div>
        <div className="flex gap-3">
          <Button 
            onClick={handleSyncSmartflo} 
            disabled={syncing}
            variant="outline"
            className="border-blue-600 text-blue-600 hover:bg-blue-50"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync from Smartflo'}
          </Button>
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
                    value={formData.client_id}
                    onValueChange={(value) => setFormData({ ...formData, client_id: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select client" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>Unassigned</SelectItem>
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
        <Card className="border-amber-200 bg-amber-50/30">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-amber-50 rounded-lg">
                <Share2 className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {dids.filter(d => d.is_demo).length}
                </p>
                <p className="text-sm text-gray-600">Demo Pool DIDs</p>
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
          <CardTitle>All DIDs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Country Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned To</TableHead>
                <TableHead>Monthly Cost</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dids.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No DIDs found. Add your first DID to get started.
                  </TableCell>
                </TableRow>
              ) : (
                dids.map((did) => (
                  <TableRow key={did.id}>
                    <TableCell className="font-medium">{did.number}</TableCell>
                    <TableCell>{did.country_code}</TableCell>
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
                    <TableCell>{getClientName(did.client_id)}</TableCell>
                    <TableCell>₹{did.monthly_cost?.toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Select
                          value={did.client_id || ''}
                          onValueChange={(value) => handleAssign(did.id, value)}
                          disabled={did.status === 'reserved'}
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue placeholder="Assign" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={null}>Unassigned</SelectItem>
                            {clients.map((client) => (
                              <SelectItem key={client.id} value={client.id}>
                                {client.company_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
    </div>
  );
}