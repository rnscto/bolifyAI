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
import { Plus, Edit, Trash2, Bot, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { REALTIME_VOICES, AZURE_SPEECH_VOICES } from '../components/agents/VoiceData';

const AGENT_TEMPLATES = {
  ecommerce_support: {
    name: 'E-Commerce Customer Support',
    industry: 'E-Commerce',
    greeting_message: 'Hello! Thank you for calling. I can help you with your order status, tracking, returns, and more. How can I assist you today?',
    system_prompt: `You are a customer support agent for an online e-commerce store.

ROLE: Inbound customer support specialist. Customers call YOU for help.

CAPABILITIES:
- Look up order status by order number, phone, or email (use the shopify_lookup tool when available)
- Check product availability and pricing
- Provide shipping and tracking information
- Handle return/exchange inquiries
- Resolve payment and refund questions

WORKFLOW:
1. Greet the customer warmly and ask how you can help
2. If they ask about an order:
   - Ask for their order number (e.g., #1234) or registered phone number or email
   - Use the shopify_lookup tool to fetch real-time order data
   - Share: order status, items ordered, tracking number, expected delivery date
3. If they ask about a product:
   - Use product_search to check availability and pricing
4. For returns/exchanges:
   - Collect order details, explain the return policy
   - Offer to create a callback for the support team
5. For refund inquiries:
   - Look up the refund status using the order ID
   - Share refund amount and timeline

IMPORTANT RULES:
- ALWAYS verify customer identity before sharing order details (ask for order # + name or phone)
- NEVER make up order statuses or tracking numbers — always use the tool
- If you can't find their order, ask for alternative info (try phone if order# fails, etc.)
- Be empathetic for complaints, offer solutions proactively
- Keep responses concise — this is a phone call, not an email

TONE: Friendly, patient, solution-oriented. Use natural conversational language.`
  },
  sales_outbound: {
    name: 'Sales Outbound Agent',
    industry: 'General Sales',
    greeting_message: '',
    system_prompt: `You are a professional sales agent making outbound calls to potential customers.

ROLE: Outbound sales representative.

WORKFLOW:
1. Introduce yourself and the company
2. Reference any previous interactions
3. Present the value proposition clearly
4. Handle objections professionally
5. Aim for a callback, demo, or appointment booking
6. Always confirm next steps before ending

TONE: Professional, confident, and not pushy.`
  },
  appointment_booking: {
    name: 'Appointment Booking Agent',
    industry: 'Healthcare / Services',
    greeting_message: 'Hello! Thank you for calling. I can help you schedule an appointment. How can I help?',
    system_prompt: `You are an appointment booking assistant.

ROLE: Help customers schedule, reschedule, or cancel appointments.

WORKFLOW:
1. Greet and ask what they need (new appointment, reschedule, cancel)
2. Collect: name, preferred date/time, service type
3. Confirm appointment details
4. Provide any preparation instructions

TONE: Warm, efficient, organized.`
  }
};

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
    voice_engine: 'realtime',
    voice_type: 'alloy',
    tone: 'professional',
    language: 'en-US',
    system_prompt: '',
    greeting_message: '',
    assigned_did: '',
    assigned_dids: [],
    status: 'inactive',
    industry: ''
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
          voice_engine: formData.voice_engine || 'realtime',
          voice_type: formData.voice_type || 'alloy',
          tone: formData.tone,
          language: formData.language
        },
        system_prompt: formData.system_prompt,
        greeting_message: formData.greeting_message || '',
        assigned_did: (formData.assigned_dids || [])[0] || '',
        assigned_dids: formData.assigned_dids || [],
        status: formData.status,
        industry: formData.industry,
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
      voice_engine: 'realtime',
      voice_type: 'alloy',
      tone: 'professional',
      language: 'en-US',
      system_prompt: '',
      greeting_message: '',
      assigned_did: '',
      assigned_dids: [],
      status: 'inactive',
      industry: ''
    });
  };

  const handleEdit = (agent) => {
    setEditingAgent(agent);
    const didsArray = agent.assigned_dids?.length > 0
      ? agent.assigned_dids
      : (agent.assigned_did ? [agent.assigned_did] : []);
    setFormData({
      name: agent.name,
      client_id: agent.client_id,
      voice_engine: agent.persona?.voice_engine || 'realtime',
      voice_type: agent.persona?.voice_type || 'alloy',
      tone: agent.persona?.tone || 'professional',
      language: agent.persona?.language || 'en-US',
      system_prompt: agent.system_prompt || '',
      greeting_message: agent.greeting_message || '',
      assigned_did: didsArray[0] || '',
      assigned_dids: didsArray,
      status: agent.status || 'inactive',
      industry: agent.industry || ''
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
              <div className="grid grid-cols-3 gap-4">
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
                <div>
                  <Label htmlFor="industry">Industry/Sector</Label>
                  <Input
                    id="industry"
                    value={formData.industry}
                    onChange={(e) => setFormData({ ...formData, industry: e.target.value })}
                    placeholder="e.g., Gym, Real Estate"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Voice Engine</Label>
                  <Select
                    value={formData.voice_engine}
                    onValueChange={(value) => {
                      const defaultVoice = value === 'realtime' ? 'alloy' : 'en-IN-NeerjaNeural';
                      setFormData({ ...formData, voice_engine: value, voice_type: defaultVoice });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="realtime">
                        <span className="flex items-center gap-2">
                          Realtime API
                          <span className="text-xs text-gray-400">Low latency, 10 voices</span>
                        </span>
                      </SelectItem>
                      <SelectItem value="azure_speech">
                        <span className="flex items-center gap-2">
                          GPT-5-nano + Azure TTS
                          <span className="text-xs text-gray-400">400+ voices, custom</span>
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Voice</Label>
                  <Select
                    value={formData.voice_type}
                    onValueChange={(value) => setFormData({ ...formData, voice_type: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select voice" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {(formData.voice_engine === 'azure_speech' ? AZURE_SPEECH_VOICES : REALTIME_VOICES).map((v) => (
                        <SelectItem key={v.name} value={v.name}>
                          <span className="flex items-center gap-2">
                            {v.name}
                            <span className="text-xs text-gray-400">
                              {v.gender} • {v.style}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
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
                      <SelectItem value="energetic">Energetic</SelectItem>
                      <SelectItem value="empathetic">Empathetic</SelectItem>
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
                      <SelectItem value="en-IN">English (India)</SelectItem>
                      <SelectItem value="hi-IN">Hindi</SelectItem>
                      <SelectItem value="bilingual">Bilingual (Hindi + English)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label>Quick Template</Label>
                <Select
                  value=""
                  onValueChange={(value) => {
                    if (AGENT_TEMPLATES[value]) {
                      const t = AGENT_TEMPLATES[value];
                      setFormData(prev => ({
                        ...prev,
                        system_prompt: t.system_prompt,
                        greeting_message: t.greeting_message,
                        industry: t.industry,
                      }));
                      toast.success(`Template "${t.name}" applied`);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Apply a template..." />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(AGENT_TEMPLATES).map(([key, t]) => (
                      <SelectItem key={key} value={key}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-400 mt-1">Fills in system prompt, greeting, and industry. You can customize after applying.</p>
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

              <div>
                <Label htmlFor="greeting_message">Voice Greeting Message</Label>
                <p className="text-xs text-gray-500 mb-1">The agent will speak this greeting immediately when the call connects (before the customer speaks). Leave empty for AI-generated greeting.</p>
                <textarea
                  id="greeting_message"
                  value={formData.greeting_message}
                  onChange={(e) => setFormData({ ...formData, greeting_message: e.target.value })}
                  className="w-full min-h-[60px] px-3 py-2 border rounded-md"
                  placeholder='e.g., "Hello! Thank you for calling. This is Vaani from ABC Company. How can I help you today?"'
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Assigned DIDs</Label>
                  <div className="space-y-2 mt-1">
                    {(formData.assigned_dids || []).map((did, i) => (
                      <div key={did} className="flex items-center gap-2 p-2 bg-gray-50 rounded border text-sm font-mono">
                        <Phone className="w-3 h-3 text-blue-600" />
                        {did}
                        {i === 0 && <Badge className="text-[10px] bg-blue-100 text-blue-700 py-0">Primary</Badge>}
                        <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 w-6 p-0 text-red-500"
                          onClick={() => {
                            const newDids = formData.assigned_dids.filter(d => d !== did);
                            setFormData({ ...formData, assigned_dids: newDids, assigned_did: newDids[0] || '' });
                          }}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <Select
                      value=""
                      onValueChange={(value) => {
                        if (value && !(formData.assigned_dids || []).includes(value)) {
                          const newDids = [...(formData.assigned_dids || []), value];
                          setFormData({ ...formData, assigned_dids: newDids, assigned_did: newDids[0] });
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="+ Add DID" />
                      </SelectTrigger>
                      <SelectContent>
                        {dids
                          .filter(d => (d.status === 'available' || (d.client_id === formData.client_id && d.status === 'assigned')) && !(formData.assigned_dids || []).includes(d.number))
                          .map((did) => (
                            <SelectItem key={did.id} value={did.number}>{did.number}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
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
                <TableHead>Industry</TableHead>
                <TableHead>Voice</TableHead>
                <TableHead>Tone/Language</TableHead>
                <TableHead>DID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-gray-500">
                    No agents found. Create your first agent to get started.
                  </TableCell>
                </TableRow>
              ) : (
                agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell>{getClientName(agent.client_id)}</TableCell>
                    <TableCell className="text-sm">{agent.industry || '-'}</TableCell>
                    <TableCell className="text-sm">
                      <Badge variant="outline" className={agent.persona?.voice_engine === 'azure_speech' ? 'border-purple-300 text-purple-700' : 'border-blue-300 text-blue-700'}>
                        {agent.persona?.voice_engine === 'azure_speech' ? 'GPT-5-nano' : 'Realtime'}
                      </Badge>
                      <span className="block text-xs text-gray-500 mt-1">{agent.persona?.voice_type || 'alloy'}</span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {agent.persona?.tone || 'professional'} / {agent.persona?.language || 'en-IN'}
                    </TableCell>
                    <TableCell>
                      {(agent.assigned_dids?.length > 0)
                        ? agent.assigned_dids.map((d, i) => (
                            <span key={d} className="block font-mono text-xs">
                              {d}{i === 0 && <Badge className="ml-1 bg-blue-100 text-blue-700 text-[10px] py-0">Primary</Badge>}
                            </span>
                          ))
                        : (agent.assigned_did || '-')}
                    </TableCell>
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