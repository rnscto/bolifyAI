import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Clock, CheckCircle2, XCircle, Ban, Lock } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Generic gate for admin-activated add-ons (Social Media, CRM Integration, etc.)
 *
 * Props:
 *   client                 — Client record
 *   onChange()             — Reload callback after a request is submitted
 *   featureName            — Display name (e.g. "Social Media Content")
 *   featureIcon            — JSX icon node
 *   statusField            — Client field for status (e.g. "social_media_access_status")
 *   requestedAtField       — Client field for requested_at timestamp
 *   activatedAtField       — Client field for activated_at timestamp
 *   feeField               — Client field that stores the activation fee
 *   notesField             — Client field that stores admin notes
 *   description            — Short paragraph shown on the locked card
 *   bullets                — Array of strings (what's included)
 *   children               — The actual feature UI (rendered only when active)
 */
export default function AddOnAccessGate({
  client, onChange, featureName, featureIcon,
  statusField, requestedAtField, activatedAtField, feeField, notesField,
  description, bullets = [], children
}) {
  const [requesting, setRequesting] = useState(false);
  const status = client?.[statusField] || 'not_requested';

  const handleRequest = async () => {
    if (!client) return;
    setRequesting(true);
    try {
      const patch = {
        [statusField]: 'requested',
        [requestedAtField]: new Date().toISOString()
      };
      await base44.entities.Client.update(client.id, patch);
      toast.success('Request submitted. Admin will review shortly.');
      onChange && onChange();
    } catch (e) {
      toast.error(e.message || 'Failed to submit request');
    } finally {
      setRequesting(false);
    }
  };

  if (status === 'active') {
    return (
      <>
        <Card className="border-green-200 bg-green-50">
          <CardContent className="p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-green-700" />
              <div>
                <p className="font-semibold text-green-900">{featureName} — Active</p>
                <p className="text-xs text-green-700">
                  Activated {client[activatedAtField] ? new Date(client[activatedAtField]).toLocaleDateString() : ''}
                  {client[feeField] != null && <> · One-time fee: ₹{Number(client[feeField]).toLocaleString()}</>}
                </p>
              </div>
            </div>
            <Badge className="bg-green-600 text-white">ACTIVE</Badge>
          </CardContent>
        </Card>
        {children}
      </>
    );
  }

  return (
    <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50">
      <CardContent className="p-8">
        <div className="flex items-start gap-4 max-w-2xl">
          <div className="shrink-0 w-12 h-12 rounded-lg bg-indigo-600 flex items-center justify-center text-white">
            {featureIcon || <Lock className="w-6 h-6" />}
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-gray-900">{featureName}</h2>
            {description && <p className="text-sm text-gray-700 mt-1">{description}</p>}

            {status === 'not_requested' && (
              <div className="mt-5 space-y-3">
                {bullets.length > 0 && (
                  <ul className="text-sm text-gray-700 space-y-1.5 list-disc ml-5">
                    {bullets.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                )}
                <Button onClick={handleRequest} disabled={requesting} className="bg-indigo-600 hover:bg-indigo-700">
                  {requesting ? 'Submitting…' : `Request ${featureName} Access`}
                </Button>
                <p className="text-xs text-gray-500">Admin will review your request and confirm the one-time activation fee.</p>
              </div>
            )}

            {status === 'requested' && (
              <div className="mt-5 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded">
                <Clock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-amber-900 text-sm">Request Pending Admin Approval</p>
                  <p className="text-xs text-amber-800 mt-1">
                    Submitted on {client[requestedAtField] ? new Date(client[requestedAtField]).toLocaleString() : '—'}.
                  </p>
                </div>
              </div>
            )}

            {(status === 'rejected' || status === 'revoked') && (
              <div className="mt-5 space-y-3">
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded">
                  {status === 'rejected' ? <XCircle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" /> : <Ban className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />}
                  <div>
                    <p className="font-semibold text-red-900 text-sm">
                      {status === 'rejected' ? 'Request Rejected' : 'Access Revoked'}
                    </p>
                    {client[notesField] && (
                      <p className="text-xs text-red-800 mt-1"><strong>Admin note:</strong> {client[notesField]}</p>
                    )}
                  </div>
                </div>
                <Button onClick={handleRequest} disabled={requesting} variant="outline">
                  {requesting ? 'Submitting…' : 'Request Again'}
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}