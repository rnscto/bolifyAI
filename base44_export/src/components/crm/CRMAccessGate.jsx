import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Database, Clock, CheckCircle2, XCircle, Ban } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Gates the CRM Integration API section behind admin approval.
 * - not_requested → shows "Request Access" button
 * - requested → shows "Pending approval"
 * - rejected / revoked → shows admin note and re-request option
 * - active → renders children (the rest of the CRM page)
 */
export default function CRMAccessGate({ client, onChange, children }) {
  const [requesting, setRequesting] = useState(false);
  const status = client?.crm_api_access_status || 'not_requested';

  const handleRequest = async () => {
    if (!client) return;
    setRequesting(true);
    try {
      await base44.entities.Client.update(client.id, {
        crm_api_access_status: 'requested',
        crm_api_access_requested_at: new Date().toISOString()
      });
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
                <p className="font-semibold text-green-900">CRM Integration Access — Active</p>
                <p className="text-xs text-green-700">
                  Activated {client.crm_api_access_activated_at ? new Date(client.crm_api_access_activated_at).toLocaleDateString() : ''}
                  {client.crm_api_access_fee != null && <> · One-time fee: ₹{Number(client.crm_api_access_fee).toLocaleString()}</>}
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

  // Locked states
  return (
    <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50">
      <CardContent className="p-8">
        <div className="flex items-start gap-4 max-w-2xl">
          <div className="shrink-0 w-12 h-12 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Database className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-gray-900">CRM Integration API Access</h2>
            <p className="text-sm text-gray-700 mt-1">
              Push leads, fetch call logs, and receive real-time webhooks from Bolify AI into your CRM via secure REST APIs.
              This is a chargeable add-on activated by the admin with a one-time fee.
            </p>

            {status === 'not_requested' && (
              <div className="mt-5 space-y-3">
                <ul className="text-sm text-gray-700 space-y-1.5 list-disc ml-5">
                  <li>POST leads, deals, activities into Bolify (crmInbound)</li>
                  <li>Pull call logs, transcripts, lead scores (crmFetchData)</li>
                  <li>Receive real-time call_completed & lead_updated webhooks</li>
                  <li>Includes a unique platform authorization key</li>
                </ul>
                <Button
                  onClick={handleRequest}
                  disabled={requesting}
                  className="bg-indigo-600 hover:bg-indigo-700"
                >
                  {requesting ? 'Submitting…' : 'Request CRM Integration Access'}
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
                    Submitted on {client.crm_api_access_requested_at ? new Date(client.crm_api_access_requested_at).toLocaleString() : '—'}.
                    Admin will activate your access shortly and confirm the one-time fee.
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
                    {client.crm_api_access_notes && (
                      <p className="text-xs text-red-800 mt-1"><strong>Admin note:</strong> {client.crm_api_access_notes}</p>
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