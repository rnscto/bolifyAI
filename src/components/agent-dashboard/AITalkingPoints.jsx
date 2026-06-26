import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Loader2, RefreshCw, MessageSquare } from 'lucide-react';
import { apiClient } from '@/api/apiClient';
import ReactMarkdown from 'react-markdown';

export default function AITalkingPoints({ activeCalls, agent, leads }) {
  const [talkingPoints, setTalkingPoints] = useState({});
  const [loadingId, setLoadingId] = useState(null);

  const leadsMap = {};
  leads.forEach(l => { leadsMap[l.id] = l; });

  // Active calls = initiated, ringing, or answered
  const liveCalls = activeCalls.filter(c => ['initiated', 'ringing', 'answered'].includes(c.status));

  const generatePoints = async (call) => {
    setLoadingId(call.id);
    const lead = leadsMap[call.lead_id];
    const prompt = `You are an AI sales coach. Generate 4-5 concise talking points for a live call.

AGENT: ${agent?.name || 'AI Agent'}
INDUSTRY: ${agent?.industry || 'General'}
LEAD: ${lead?.name || 'Unknown'} (${lead?.company || 'N/A'})
LEAD STATUS: ${lead?.status || 'new'}
LEAD SCORE: ${lead?.score || 'N/A'}/100
SENTIMENT: ${lead?.sentiment || 'unknown'}
INTENT SIGNALS: ${(lead?.intent_signals || []).join(', ') || 'none'}
PREVIOUS NOTES: ${lead?.notes || 'none'}

Generate SHORT, actionable bullet points the agent should use during THIS call. Include:
- Personalized opener based on lead data
- Key value proposition to highlight
- Objection handling tip
- Closing technique suggestion
- Follow-up hook`;

    const result = await apiClient.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: {
          talking_points: { type: "array", items: { type: "string" } },
          recommended_tone: { type: "string" },
          key_objective: { type: "string" }
        }
      }
    });

    setTalkingPoints(prev => ({ ...prev, [call.id]: result }));
    setLoadingId(null);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-500" />
          <CardTitle className="text-base">AI Talking Points</CardTitle>
        </div>
        <p className="text-xs text-gray-500 mt-1">Generate real-time coaching for active calls</p>
      </CardHeader>
      <CardContent>
        {liveCalls.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400">
            <MessageSquare className="w-8 h-8 mb-2" />
            <p className="text-sm">No active calls right now</p>
            <p className="text-xs mt-1">Talking points will appear when calls are in progress</p>
          </div>
        ) : (
          <div className="space-y-4">
            {liveCalls.map(call => {
              const lead = leadsMap[call.lead_id];
              const points = talkingPoints[call.id];
              const isLoading = loadingId === call.id;

              return (
                <div key={call.id} className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{lead?.name || 'Unknown Lead'}</p>
                      <p className="text-xs text-gray-500">{call.callee_number}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className="bg-green-100 text-green-700 animate-pulse text-xs">{call.status}</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => generatePoints(call)}
                        disabled={isLoading}
                        className="text-xs"
                      >
                        {isLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                        {points ? 'Refresh' : 'Generate'}
                      </Button>
                    </div>
                  </div>

                  {points && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge className="bg-amber-100 text-amber-800 text-[10px]">Tone: {points.recommended_tone}</Badge>
                        <Badge variant="outline" className="text-[10px]">Goal: {points.key_objective}</Badge>
                      </div>
                      <ul className="space-y-1.5">
                        {points.talking_points?.map((pt, i) => (
                          <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                            <span className="text-amber-500 font-bold mt-0.5">•</span>
                            <span>{pt}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}