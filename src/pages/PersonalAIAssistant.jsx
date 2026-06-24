import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bot, Phone as PhoneIcon, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import AgentEditDialog from '../components/agents/AgentEditDialog';
import AgentSettingsCard from '../components/agents/AgentSettingsCard';

export default function PersonalAIAssistant() {
  const [agent, setAgent] = useState(null);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length > 0) {
      setClient(clients[0]);
      const agents = await base44.entities.Agent.filter({ client_id: clients[0].id });
      if (agents.length > 0) setAgent(agents[0]);
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-gray-900">My AI Assistant</h1>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Bot className="w-16 h-16 text-gray-400 mb-4" />
            <p className="text-gray-500">No AI assistant set up yet</p>
            <p className="text-sm text-gray-400 mt-2">Your assistant will be configured during onboarding</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const dids = agent.assigned_dids || (agent.assigned_did ? [agent.assigned_did] : []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">My AI Assistant</h1>
        <p className="text-gray-600 mt-1">Customize how your AI handles calls</p>
      </div>

      {/* Agent overview */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-purple-100 rounded-lg">
                <Bot className="w-6 h-6 text-purple-600" />
              </div>
              <div>
                <CardTitle className="text-xl flex items-center gap-2">
                  {agent.name}
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditOpen(true)}>
                    <Pencil className="w-4 h-4 text-gray-500" />
                  </Button>
                </CardTitle>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Badge className={agent.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}>
                    {agent.status}
                  </Badge>
                  {dids.map((did, i) => (
                    <Badge key={did} variant="outline" className="flex items-center gap-1">
                      <PhoneIcon className="w-3 h-3" />
                      {did}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            <Button onClick={() => setEditOpen(true)} className="bg-purple-600 hover:bg-purple-700">
              <Pencil className="w-4 h-4 mr-2" /> Edit Assistant
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Voice & Personality</h4>
              <div className="space-y-1.5 text-sm">
                <p><span className="text-gray-500">Voice:</span> {agent.persona?.voice_type || 'Default'}</p>
                <p><span className="text-gray-500">Tone:</span> <span className="capitalize">{agent.persona?.tone || 'Friendly'}</span></p>
                <p><span className="text-gray-500">Language:</span> {agent.persona?.language === 'hi-IN' ? 'Hindi' : agent.persona?.language === 'bilingual' ? 'Bilingual' : 'English'}</p>
                <p><span className="text-gray-500">Engine:</span> Gemini Multimodal Live (Flash 3.0)</p>
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Details</h4>
              <div className="space-y-1.5 text-sm">
                <p><span className="text-gray-500">Industry:</span> {agent.industry || 'General'}</p>
                <p><span className="text-gray-500">Knowledge Docs:</span> {agent.knowledge_base_ids?.length || 0}</p>
                <p><span className="text-gray-500">Auto Transfer:</span> {agent.enable_auto_transfer !== false ? 'Enabled' : 'Disabled'}</p>
              </div>
            </div>
          </div>

          {/* Greeting */}
          {agent.greeting_message && (
            <div className="mt-4 pt-4 border-t">
              <h4 className="text-sm font-medium text-gray-700 mb-1">Greeting Message</h4>
              <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3 italic">"{agent.greeting_message}"</p>
            </div>
          )}

          {/* System Prompt preview */}
          {agent.system_prompt && (
            <div className="mt-4 pt-4 border-t">
              <h4 className="text-sm font-medium text-gray-700 mb-1">Instructions</h4>
              <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
                {agent.system_prompt}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Call Settings */}
      <AgentSettingsCard agent={agent} onUpdate={loadData} />

      <AgentEditDialog agent={agent} open={editOpen} onOpenChange={setEditOpen} onSaved={loadData} />
    </div>
  );
}