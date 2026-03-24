import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bot, Phone as PhoneIcon } from 'lucide-react';
import { toast } from 'sonner';
import FeatureGate from '../components/FeatureGate';
import DIDManager from '../components/agents/DIDManager';
import AgentSettingsCard from '../components/agents/AgentSettingsCard';

export default function ClientAgents() {
  const [agent, setAgent] = useState(null);
  const [client, setClient] = useState(null);
  const [knowledgeBases, setKnowledgeBases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedKnowledgeBases, setSelectedKnowledgeBases] = useState([]);

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

        const [agentsData, kbData] = await Promise.all([
          base44.entities.Agent.filter({ client_id: clientData.id }),
          base44.entities.KnowledgeBase.filter({ client_id: clientData.id })
        ]);

        if (agentsData.length > 0) {
          setAgent(agentsData[0]);
          setSelectedKnowledgeBases(agentsData[0].knowledge_base_ids || []);
        }
        setKnowledgeBases(kbData);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateKnowledgeBase = async () => {
    if (!agent) return;
    
    try {
      await base44.entities.Agent.update(agent.id, {
        knowledge_base_ids: selectedKnowledgeBases
      });
      toast.success('Knowledge base updated');
      loadData();
    } catch (error) {
      console.error('Error updating knowledge base:', error);
      toast.error('Failed to update knowledge base');
    }
  };

  const toggleKnowledgeBase = (kbId) => {
    setSelectedKnowledgeBases(prev => 
      prev.includes(kbId) 
        ? prev.filter(id => id !== kbId)
        : [...prev, kbId]
    );
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
        <h1 className="text-3xl font-bold text-gray-900">My AI Agent</h1>
        <p className="text-gray-600 mt-1">View agent details and manage knowledge base</p>
      </div>

      {!agent ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Bot className="w-16 h-16 text-gray-400 mb-4" />
            <p className="text-gray-500">No agent assigned yet</p>
            <p className="text-sm text-gray-400 mt-2">Contact admin to get an agent assigned</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-blue-100 rounded-lg">
                    <Bot className="w-6 h-6 text-blue-600" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">{agent.name}</CardTitle>
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
                    </div>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
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
                <div className="mt-4 pt-4 border-t">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">System Prompt</h4>
                  <p className="text-sm text-gray-600">{agent.system_prompt}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <DIDManager agent={agent} client={client} onUpdate={loadData} />

          <Card>
            <CardHeader>
              <CardTitle>Assigned Knowledge Base</CardTitle>
              <p className="text-sm text-gray-500 mt-1">Documents are automatically synced when uploaded in Knowledge Base section</p>
            </CardHeader>
            <CardContent>
              {knowledgeBases.length === 0 ? (
                <p className="text-sm text-gray-500">No knowledge base documents available. Upload documents in the Knowledge Base section.</p>
              ) : (
                <div className="space-y-2">
                  {knowledgeBases.filter(kb => selectedKnowledgeBases.includes(kb.id)).map((kb) => (
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
                  {knowledgeBases.filter(kb => selectedKnowledgeBases.includes(kb.id)).length === 0 && (
                    <p className="text-sm text-gray-500">No documents assigned to this agent yet</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
    </FeatureGate>
  );
}