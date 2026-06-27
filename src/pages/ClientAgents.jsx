import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bot, Phone as PhoneIcon, Pencil, BookOpen, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import FeatureGate from '../components/FeatureGate';
import DIDManager from '../components/agents/DIDManager';
import AgentSettingsCard from '../components/agents/AgentSettingsCard';
import AgentEditDialog from '../components/agents/AgentEditDialog';
import AgentToolsBuilder from '../components/agents/AgentToolsBuilder';

export default function ClientAgents() {
  const [agents, setAgents] = useState([]);
  const [client, setClient] = useState(null);
  const [knowledgeBases, setKnowledgeBases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await apiClient.auth.me();
      const clients = await apiClient.Client.filter({ user_id: user.id });

      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const [agentsData, kbData] = await Promise.all([
          apiClient.Agent.filter({ client_id: clientData.id }),
          apiClient.KnowledgeBase.filter({ client_id: clientData.id })
        ]);

        setAgents(agentsData);
        setKnowledgeBases(kbData);
        // Auto-expand the first agent if only one
        if (agentsData.length === 1) setExpandedId(agentsData[0].id);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <FeatureGate client={client} featureName="AI Agents">
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">My AI Agents</h1>
        <p className="text-gray-600 mt-1">
          {agents.length > 0 ? `You have ${agents.length} agent${agents.length > 1 ? 's' : ''} assigned` : 'View agent details and manage knowledge base'}
        </p>
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Bot className="w-16 h-16 text-gray-500 mb-4" />
            <p className="text-gray-500">No agent assigned yet</p>
            <p className="text-sm text-gray-500 mt-2">Contact admin to get an agent assigned</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {agents.map((agent) => {
            const isExpanded = expandedId === agent.id;
            return (
              <Card key={agent.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <div className="p-3 bg-blue-100 rounded-lg">
                        <Bot className="w-6 h-6 text-blue-600" />
                      </div>
                      <div className="flex-1">
                        <CardTitle className="text-xl flex items-center gap-2">
                          {agent.name}
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditingAgent(agent)}>
                            <Pencil className="w-4 h-4 text-gray-500" />
                          </Button>
                        </CardTitle>
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <Badge className={agent.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}>
                            {agent.status}
                          </Badge>
                          {(agent.assigned_dids || (agent.assigned_did ? [agent.assigned_did] : [])).map((did, i) => (
                            <Badge key={did} variant="outline" className="flex items-center gap-1">
                              <PhoneIcon className="w-3 h-3" />
                              {did}
                              {i === 0 && <span className="text-xs text-blue-600 ml-1">primary</span>}
                            </Badge>
                          ))}
                          {(agent.knowledge_base_ids?.length || 0) > 0 ? (
                            <Badge className="bg-green-100 text-green-800 flex items-center gap-1">
                              <BookOpen className="w-3 h-3" />
                              KB Linked ({agent.knowledge_base_ids.length})
                            </Badge>
                          ) : (
                            <Badge className="bg-amber-100 text-amber-800 flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" />
                              No KB Linked
                            </Badge>
                          )}
                          {agent.industry && (
                            <Badge variant="outline" className="text-xs">{agent.industry}</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedId(isExpanded ? null : agent.id)}
                      className="ml-2"
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      <span className="ml-1 text-xs">{isExpanded ? 'Collapse' : 'Manage'}</span>
                    </Button>
                  </div>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="space-y-6 border-t pt-6">
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <h4 className="text-sm font-medium text-gray-700 mb-2">Persona</h4>
                        <div className="space-y-1 text-sm">
                          <p><span className="text-gray-500">Voice:</span> {agent.persona?.voice_type || 'Not set'}</p>
                          <p><span className="text-gray-500">Tone:</span> {agent.persona?.tone || 'Not set'}</p>
                          <p><span className="text-gray-500">Language:</span> {agent.persona?.language || 'Not set'}</p>
                        </div>
                      </div>
                      <div>
                        <h4 className="text-sm font-medium text-gray-700 mb-2">Configuration</h4>
                        <div className="space-y-1 text-sm">
                          <p><span className="text-gray-500">Industry:</span> {agent.industry || 'Not specified'}</p>
                          <p><span className="text-gray-500">Knowledge Base:</span> {agent.knowledge_base_ids?.length || 0} documents</p>
                        </div>
                      </div>
                    </div>
                    {agent.system_prompt && (
                      <div className="pt-4 border-t">
                        <h4 className="text-sm font-medium text-gray-700 mb-2">System Prompt</h4>
                        <p className="text-sm text-gray-600 whitespace-pre-wrap">{agent.system_prompt}</p>
                      </div>
                    )}

                    <AgentSettingsCard agent={agent} onUpdate={loadData} />
                    <AgentToolsBuilder agent={agent} client={client} />
                    <DIDManager agent={agent} client={client} onUpdate={loadData} />

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">Assigned Knowledge Base</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {knowledgeBases.filter(kb => (agent.knowledge_base_ids || []).includes(kb.id)).length === 0 ? (
                          <p className="text-sm text-gray-500">No documents assigned to this agent yet</p>
                        ) : (
                          <div className="space-y-2">
                            {knowledgeBases.filter(kb => (agent.knowledge_base_ids || []).includes(kb.id)).map((kb) => (
                              <div key={kb.id} className="flex items-center gap-3 p-3 border rounded-lg bg-gray-50">
                                <div className="flex-1">
                                  <p className="text-sm font-medium">{kb.title}</p>
                                  <p className="text-xs text-gray-500">{kb.category || 'Uncategorized'} • {kb.file_type?.toUpperCase()}</p>
                                </div>
                                <Badge className={kb.status === 'ready' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}>
                                  {kb.status}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <AgentEditDialog
        agent={editingAgent}
        open={!!editingAgent}
        onOpenChange={(open) => { if (!open) setEditingAgent(null); }}
        onSaved={loadData}
        clientId={client?.id}
      />
    </div>
    </FeatureGate>
  );
}