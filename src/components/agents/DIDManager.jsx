import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, Plus, X, AlertCircle, Crown, Share2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';

export default function DIDManager({ agent, client, onUpdate }) {
  const [availableDIDs, setAvailableDIDs] = useState([]);
  const [demoDIDs, setDemoDIDs] = useState([]);
  const [assignedDIDs, setAssignedDIDs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);
  const [newDIDNumber, setNewDIDNumber] = useState('');

  useEffect(() => {
    loadDIDs();
  }, [agent, client]);

  const isDemo = client.account_status === 'trial' || client.account_status === 'onboarding';

  const loadDIDs = async () => {
    if (!client) return;
    try {
      // Current assigned DIDs from agent
      const currentDIDs = agent?.assigned_dids || (agent?.assigned_did ? [agent.assigned_did] : []);
      setAssignedDIDs(currentDIDs);

      if (isDemo) {
        // For demo/trial: load shared demo pool DIDs
        const allDIDs = await base44.entities.DID.filter({ is_demo: true });
        setDemoDIDs(allDIDs);
        setAvailableDIDs(allDIDs.filter(d => !currentDIDs.includes(d.number)));
      } else {
        // For paid: load client-owned DIDs
        const allDIDs = await base44.entities.DID.filter({ client_id: client.id });
        setAvailableDIDs(allDIDs.filter(d => d.status === 'assigned' && !currentDIDs.includes(d.number)));
      }
    } catch (error) {
      console.error('Error loading DIDs:', error);
    } finally {
      setLoading(false);
    }
  };

  const isTrial = isDemo;
  const trialMaxDIDs = 1; // Demo agents get 1 DID each (round-robin from pool)

  const addDID = async (didNumber) => {
    if (isDemo) {
      // Demo agents: 1 DID from shared pool, no ownership check
      if (assignedDIDs.length >= trialMaxDIDs) {
        toast.error('Demo agents can only use 1 DID at a time. Remove the current one first.');
        return;
      }
    } else {
      // Paid clients: respect subscription limits
      const maxAllowed = client.total_channels || 1;
      if (assignedDIDs.length >= maxAllowed) {
        toast.error(`You can only assign up to ${maxAllowed} DID(s) based on your subscription`);
        return;
      }
    }

    setSaving(true);
    const newDIDs = [...assignedDIDs, didNumber];
    try {
      await base44.entities.Agent.update(agent.id, {
        assigned_dids: newDIDs,
        assigned_did: newDIDs[0]
      });
      setAssignedDIDs(newDIDs);
      setAvailableDIDs(prev => prev.filter(d => (d.number || d) !== didNumber));
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

  const maxChannels = isTrial ? trialMaxDIDs : (client?.total_channels || 1);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Phone className="w-5 h-5" />
              Assigned Phone Numbers (DIDs)
              {isDemo && (
                <Badge className="bg-amber-100 text-amber-800 text-xs">
                  <Share2 className="w-3 h-3 mr-1" />Demo Pool
                </Badge>
              )}
            </CardTitle>
            <p className="text-sm text-gray-500 mt-1">
              {isDemo 
                ? 'Demo accounts use shared DIDs. Each agent can use 1 DID for concurrent calling.'
                : 'Assign multiple DIDs to enable concurrent calling.'}
              <span className="font-medium"> {assignedDIDs.length}/{maxChannels} used.</span>
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Auto-assign demo DID prompt */}
        {isDemo && assignedDIDs.length === 0 && demoDIDs.length > 0 && (
          <div className="flex items-center justify-between p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center gap-2 text-sm text-amber-800">
              <Share2 className="w-4 h-4 shrink-0" />
              <span>Auto-assign a shared demo DID to start making calls</span>
            </div>
            <Button
              size="sm"
              className="bg-amber-500 hover:bg-amber-600 text-white"
              disabled={saving}
              onClick={() => {
                // Round-robin: pick based on agent creation order
                const idx = Math.floor(Math.random() * demoDIDs.length);
                addDID(demoDIDs[idx].number);
              }}
            >
              <Plus className="w-4 h-4 mr-1" /> Auto-Assign
            </Button>
          </div>
        )}

        {/* Assigned DIDs */}
        {assignedDIDs.length === 0 ? (
          <div className="flex items-center gap-2 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {isDemo && demoDIDs.length === 0 
              ? 'No demo DIDs available. Contact admin to set up the demo pool.'
              : 'No DIDs assigned. Your agent cannot make calls without a phone number.'}
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
                  {isDemo && (
                    <Badge className="bg-amber-100 text-amber-700 text-xs">Shared</Badge>
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

        {/* Upgrade prompt for trial users */}
        {showUpgradePrompt && isTrial && (
          <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg">
            <div className="flex items-start gap-3">
              <Crown className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <h4 className="text-sm font-semibold text-gray-900">Upgrade to Add More DIDs</h4>
                <p className="text-sm text-gray-600 mt-1">
                  Trial accounts are limited to 1 DID. Subscribe to a plan to assign multiple DIDs and enable concurrent calling.
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  Each additional DID costs <span className="font-semibold">₹6,500/month</span>. Select the number of channels you need in the subscription page.
                </p>
                <div className="flex gap-2 mt-3">
                  <Link to={createPageUrl('ClientSubscription')}>
                    <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                      <Crown className="w-4 h-4 mr-1" /> Subscribe Now
                    </Button>
                  </Link>
                  <Button size="sm" variant="ghost" onClick={() => setShowUpgradePrompt(false)}>
                    Maybe Later
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {assignedDIDs.length >= maxChannels && !isTrial && availableDIDs.length > 0 && (
          <p className="text-xs text-gray-500">
            Upgrade your subscription to add more channels.
          </p>
        )}
      </CardContent>
    </Card>
  );
}