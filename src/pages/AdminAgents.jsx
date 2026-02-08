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
  DialogDescription,
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
import { Plus, Edit, Trash2, Bot } from 'lucide-react';
import { toast } from 'sonner';

export default function AdminAgents() {
  const [agents, setAgents] = useState([]);
  const [clients, setClients] = useState([]);
  const [dids, setDids] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    client_id: '',
    voice_type: 'neutral',
    tone: 'professional',
    language: 'en-US',
    system_prompt: '',
    assigned_did: '',
    wss_url: '',
    status: 'inactive'
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [agentsData, clientsData, didsData] = await Promise.all([
        base44.entities.Agent.list('-created_date'),
        base44.entities.Client.list(),
        base44.entities.DID.list()
      ]);

      setAgents(agentsData);
      setClients(clientsData);
      setDids(didsData);
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
      const agentData = {
        name: formData.name,
        client_id: formData.client_id,
        persona: {
          voice_type: formData.voice_type,
          tone: formData.tone,
          language: formData.language
        },
        system_prompt: formData.system_prompt,
        assigned_did: formData.assigned_did,
        wss_url: formData.wss_url,
        status: formData.status,
        knowledge_base_ids: []
      };

      if (editingAgent) {
        await base44.entities.Agent.update(editingAgent.id, agentData);
        toast.success('Agent updated');
      } else {
        await base44.entities.Agent.create(agentData);
        toast.success('Agent created');
      }

      setDialogOpen(false);
      resetForm();
      loadData();
    } catch (error) {
      console.error('Error saving agent:', error);
      toast.error('Failed to save agent');
    }
  };

  const resetForm = () => {
    setEditingAgent(null);
    setFormData({
      name: '',
      client_id: '',
      voice_type: 'neutral',
      tone: 'professional',
      language: 'en-US',
      system_prompt: '',
      assigned_did: '',
      wss_url: '',
      status: 'inactive'
    });
  };

  const handleEdit = (agent) => {
    setEditingAgent(agent);
    setFormData({
      name: agent.name,
      client_id: agent.client_id,
      voice_type: agent.persona?.voice_type || 'neutral',
      tone: agent.persona?.tone || 'professional',
      language: agent.persona?.language || 'en-US',
      system_prompt: agent.system_prompt || '',
      assigned_did: agent.assigned_did || '',
      wss_url: agent.wss_url || '',
      status: agent.status || 'inactive'
    });
    setDialogOpen(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this agent?')) return;
    
    try {
      await base44.entities.Agent.delete(id);
      toast.success('Agent deleted');
      loadData();
    } catch (error) {
      console.error('Error deleting agent:', error);
      toast.error('Failed to delete agent');
    }
  };

  const getClientName = (clientId) => {
    const client = clients.find(c => c.id === clientId);
    return client?.company_name || 'Unassigned';
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
          <h1 className="text-3xl font-bold text-gray-900">AI Agents</h1>
          <p className="text-gray-600 mt-1">Create and manage AI calling agents</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={resetForm}>
              <Plus className="w-4 h-4 mr-2" />
              Create Agent
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editingAgent ? 'Edit Agent' : 'Create New Agent'}
              </DialogTitle>
              <DialogDescription>
                Configure the AI agent and assign it to a client
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Agent Name</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="client_id">Assign to Client</Label>
                  <Select 
                    value={formData.client_id}
                    onValueChange={(value) => setFormData({ ...formData, client_id: value })}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select client" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map((client) => (
                        <SelectItem key={client.id} value={client.id}>
                          {client.company_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="voice_type">Voice Type</Label>
                  <Select 
                    value={formData.voice_type}
                    onValueChange={(value) => setFormData({ ...formData, voice_type: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="neutral">Neutral</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="tone">Tone</Label>
                  <Select 
                    value={formData.tone}
                    onValueChange={(value) => setFormData({ ...formData, tone: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="formal">Formal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="language">Language</Label>
                  <Select 
                    value={formData.language}
                    onValueChange={(value) => setFormData({ ...formData, language: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en-US">English (US)</SelectItem>
                      <SelectItem value="en-GB">English (UK)</SelectItem>
                      <SelectItem value="es-ES">Spanish</SelectItem>
                      <SelectItem value="fr-FR">French</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="system_prompt">System Prompt</Label>
                <textarea
                  id="system_prompt"
                  value={formData.system_prompt}
                  onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                  className="w-full min-h-[100px] px-3 py-2 border rounded-md"
                  placeholder="Enter system instructions for the AI agent..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="assigned_did">Assigned DID</Label>
                  <Select 
                    value={formData.assigned_did}
                    onValueChange={(value) => setFormData({ ...formData, assigned_did: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select DID (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      {dids.filter(d => d.status === 'available' || d.number === formData.assigned_did).map((did) => (
                        <SelectItem key={did.id} value={did.number}>
                          {did.number}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="status">Status</Label>
                  <Select 
                    value={formData.status}
                    onValueChange={(value) => setFormData({ ...formData, status: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="wss_url">WebSocket URL</Label>
                <Input
                  id="wss_url"
                  value={formData.wss_url}
                  onChange={(e) => setFormData({ ...formData, wss_url: e.target.value })}
                  placeholder="wss://..."
                />
              </div>

              <div className="flex gap-3 justify-end">
                <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                  {editingAgent ? 'Update' : 'Create'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Agents ({agents.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Voice/Tone</TableHead>
                <TableHead>DID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No agents found. Create your first agent to get started.
                  </TableCell>
                </TableRow>
              ) : (
                agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell>{getClientName(agent.client_id)}</TableCell>
                    <TableCell className="text-sm">
                      {agent.persona?.voice_type || 'neutral'} / {agent.persona?.tone || 'professional'}
                    </TableCell>
                    <TableCell>{agent.assigned_did || '-'}</TableCell>
                    <TableCell>
                      <Badge className={agent.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}>
                        {agent.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEdit(agent)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(agent.id)}
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
    </div>
  );
}