import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, Plus, X, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

export default function DIDManager({ agent, client, onUpdate }) {
  const [availableDIDs, setAvailableDIDs] = useState([]);
  const [assignedDIDs, setAssignedDIDs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadDIDs();
  }, [agent, client]);

  const loadDIDs = async () => {
    if (!client) return;
    try {
      const allDIDs = await base44.entities.DID.filter({ client_id: client.id });
      
      // Current assigned DIDs from agent
      const currentDIDs = agent?.assigned_dids || (agent?.assigned_did ? [agent.assigned_did] : []);
      setAssignedDIDs(currentDIDs);

      // Available = DIDs assigned to this client but not yet assigned to this agent
      setAvailableDIDs(allDIDs.filter(d => d.status === 'assigned' && !currentDIDs.includes(d.number)));
    } catch (error) {
      console.error('Error loading DIDs:', error);
    } finally {
      setLoading(false);
    }
  };

  const addDID = async (didNumber) => {
    const maxAllowed = client.total_channels || 1;
    if (assignedDIDs.length >= maxAllowed) {
      toast.error(`You can only assign up to ${maxAllowed} DID(s) based on your subscription`);
      return;
    }

    setSaving(true);
    const newDIDs = [...assignedDIDs, didNumber];
    try {
      await base44.entities.Agent.update(agent.id, {
        assigned_dids: newDIDs,
        assigned_did: newDIDs[0] // keep primary for backward compatibility
      });
      setAssignedDIDs(newDIDs);
      setAvailableDIDs(prev => prev.filter(d => d.number !== didNumber));
      toast.success('DID added to agent');
      onUpdate?.();
    } catch (error) {
      toast.error('Failed to add DID');
    } finally {
      setSaving(false);
    }
  };

  const removeDID = async (didNumber) => {
    setSaving(true);
    const newDIDs = assignedDIDs.filter(d => d !== didNumber);
    try {
      await base44.entities.Agent.update(agent.id, {
        assigned_dids: newDIDs,
        assigned_did: newDIDs[0] || ''
      });
      setAssignedDIDs(newDIDs);
      // Re-add to available list
      setAvailableDIDs(prev => [...prev, { number: didNumber, status: 'assigned' }]);
      toast.success('DID removed from agent');
      onUpdate?.();
    } catch (error) {
      toast.error('Failed to remove DID');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  const maxChannels = client?.total_channels || 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Phone className="w-5 h-5" />
              Assigned Phone Numbers (DIDs)
            </CardTitle>
            <p className="text-sm text-gray-500 mt-1">
              Assign multiple DIDs to enable concurrent calling. 
              <span className="font-medium"> {assignedDIDs.length}/{maxChannels} channels used.</span>
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Assigned DIDs */}
        {assignedDIDs.length === 0 ? (
          <div className="flex items-center gap-2 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
            <AlertCircle className="w-4 h-4 shrink-0" />
            No DIDs assigned. Your agent cannot make calls without a phone number.
          </div>
        ) : (
          <div className="space-y-2">
            {assignedDIDs.map((did, idx) => (
              <div key={did} className="flex items-center justify-between p-3 bg-gray-50 border rounded-lg">
                <div className="flex items-center gap-3">
                  <Phone className="w-4 h-4 text-blue-600" />
                  <span className="font-mono text-sm font-medium">{did}</span>
                  {idx === 0 && (
                    <Badge className="bg-blue-100 text-blue-800 text-xs">Primary</Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeDID(did)}
                  disabled={saving}
                  className="text-red-500 hover:text-red-700 hover:bg-red-50"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Available DIDs to add */}
        {availableDIDs.length > 0 && assignedDIDs.length < maxChannels && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Available DIDs</p>
            <div className="space-y-2">
              {availableDIDs.map((did) => (
                <div key={did.number || did} className="flex items-center justify-between p-3 border border-dashed rounded-lg">
                  <div className="flex items-center gap-3">
                    <Phone className="w-4 h-4 text-gray-400" />
                    <span className="font-mono text-sm">{did.number || did}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => addDID(did.number || did)}
                    disabled={saving}
                  >
                    <Plus className="w-4 h-4 mr-1" /> Assign
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {assignedDIDs.length >= maxChannels && availableDIDs.length > 0 && (
          <p className="text-xs text-gray-500">
            Upgrade your subscription to add more channels.
          </p>
        )}
      </CardContent>
    </Card>
  );
}