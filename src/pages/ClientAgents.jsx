import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { Badge } from '@/components/ui/badge';
import { Plus, Edit, Trash2, Play, Pause } from 'lucide-react';
import { toast } from 'sonner';

export default function ClientAgents() {
  const [agents, setAgents] = useState([]);
  const [dids, setDids] = useState([]);
  const [knowledgeBases, setKnowledgeBases] = useState([]);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    voice_type: 'female',
    tone: 'professional',
    language: 'en-US',
    system_prompt: '',
    assigned_did: '',
    knowledge_base_ids: []
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const [agentsData, didsData, kbData] = await Promise.all([
          base44.entities.Agent.filter({ client_id: clientData.id }),
          base44.entities.DID.filter({ client_id: clientData.id }),
          base44.entities.KnowledgeBase.filter({ client_id: clientData.id })
        ]);

        setAgents(agentsData);
        setDids(didsData);
        setKnowledgeBases(kbData);
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
    try {
      const agentData = {
        name: formData.name,
        client_id: client.id,
        persona: {
          voice_type: formData.voice_type,
          tone: formData.tone,
          language: formData.language
        },
        system_prompt: formData.system_prompt,
        knowledge_base_ids: formData.knowledge_base_ids,
        assigned_did: formData.assigned_did,
        wss_url: `wss://your-websocket-url/${client.id}`,
        status: 'inactive'
      };

      if (editingAgent) {
        await base44.entities.Agent.update(editingAgent.id, agentData);
        toast.success('Agent updated successfully');
      } else {
        await base44.entities.Agent.create(agentData);
        toast.success('Agent created successfully');
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
      voice_type: 'female',
      tone: 'professional',
      language: 'en-US',
      system_prompt: '',
      assigned_did: '',
      knowledge_base_ids: []
    });
  };

  const handleEdit = (agent) => {
    setEditingAgent(agent);
    setFormData({
      name: agent.name,
      voice_type: agent.persona?.voice_type || 'female',
      tone: agent.persona?.tone || 'professional',
      language: agent.persona?.language || 'en-US',
      system_prompt: agent.system_prompt || '',
      assigned_did: agent.assigned_did || '',
      knowledge_base_ids: agent.knowledge_base_ids || []
    });
    setDialogOpen(true);
  };

  const toggleStatus = async (agent) => {
    try {
      const newStatus = agent.status === 'active' ? 'inactive' : 'active';
      await base44.entities.Agent.update(agent.id, { status: newStatus });
      toast.success(`Agent ${newStatus === 'active' ? 'activated' : 'deactivated'}`);
      loadData();
    } catch (error) {
      console.error('Error updating agent status:', error);
      toast.error('Failed to update agent status');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this agent?')) return;
    
    try {
      await base44.entities.Agent.delete(id);
      toast.success('Agent deleted');
      loadData();
    } catch (error) {
      console.error('Error deleting agent:', error);
      toast.error('Failed to delete agent');
    }
  };

  const statusColors = {
    active: 'bg-green-100 text-green-800',
    inactive: 'bg-gray-100 text-gray-800',
    training: 'bg-yellow-100 text-yellow-800'
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
          <p className="text-gray-600 mt-1">Configure and manage your voice AI agents</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Create Agent
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingAgent ? 'Edit Agent' : 'Create New Agent'}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="name">Agent Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Sales Agent"
                  required
                />
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
                      <SelectItem value="en-IN">English (India)</SelectItem>
                      <SelectItem value="hi-IN">Hindi</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="assigned_did">Assigned Phone Number</Label>
                <Select
                  value={formData.assigned_did}
                  onValueChange={(value) => setFormData({ ...formData, assigned_did: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select DID" />
                  </SelectTrigger>
                  <SelectContent>
                    {dids.map((did) => (
                      <SelectItem key={did.id} value={did.number}>
                        {did.number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="system_prompt">System Prompt / Instructions</Label>
                <Textarea
                  id="system_prompt"
                  value={formData.system_prompt}
                  onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                  placeholder="You are a professional sales agent. Your goal is to..."
                  rows={5}
                  required
                />
              </div>

              <div className="flex gap-3 justify-end">
                <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                  {editingAgent ? 'Update Agent' : 'Create Agent'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-gray-500 mb-4">No agents created yet</p>
            <Button onClick={() => setDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Create Your First Agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents.map((agent) => (
            <Card key={agent.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-lg">{agent.name}</CardTitle>
                    <p className="text-sm text-gray-500 mt-1">
                      {agent.persona?.voice_type} • {agent.persona?.tone}
                    </p>
                  </div>
                  <Badge className={statusColors[agent.status]}>
                    {agent.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm">
                  <p className="text-gray-600">Phone: {agent.assigned_did || 'Not assigned'}</p>
                  <p className="text-gray-600">Language: {agent.persona?.language}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggleStatus(agent)}
                    className="flex-1"
                  >
                    {agent.status === 'active' ? (
                      <>
                        <Pause className="w-4 h-4 mr-1" />
                        Deactivate
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 mr-1" />
                        Activate
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleEdit(agent)}
                  >
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDelete(agent.id)}
                  >
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}