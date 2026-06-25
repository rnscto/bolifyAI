import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Shield, FileText, Trash2, CheckCircle2, Loader2 } from 'lucide-react';
import moment from 'moment';

export default function PartnerComplianceTab({ partner, referrals }) {
  const [consentLogs, setConsentLogs] = useState([]);
  const [erasureRequests, setErasureRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (referrals?.length > 0) loadData();
    else setLoading(false);
  }, [referrals]);

  const loadData = async () => {
    // Get compliance data for all referred clients
    const clientIds = referrals.map(r => r.client_id).filter(Boolean);
    if (clientIds.length === 0) { setLoading(false); return; }

    const [allConsents, allErasures] = await Promise.all([
      base44.entities.ConsentLog.list('-created_at', 100),
      base44.entities.DataErasureRequest.list('-created_at', 50),
    ]);

    setConsentLogs(allConsents.filter(c => clientIds.includes(c.client_id)));
    setErasureRequests(allErasures.filter(e => clientIds.includes(e.client_id)));
    setLoading(false);
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>;
  }

  const clientIdToName = {};
  referrals.forEach(r => { if (r.client_id) clientIdToName[r.client_id] = r.client_name; });

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <CheckCircle2 className="w-6 h-6 text-green-600 mx-auto mb-1" />
            <p className="text-lg font-bold">{consentLogs.filter(c => c.consent_given).length}</p>
            <p className="text-xs text-gray-500">Active Consents</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <Trash2 className="w-6 h-6 text-orange-600 mx-auto mb-1" />
            <p className="text-lg font-bold">{erasureRequests.filter(e => e.status === 'pending').length}</p>
            <p className="text-xs text-gray-500">Pending Erasures</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <Shield className="w-6 h-6 text-blue-600 mx-auto mb-1" />
            <p className="text-lg font-bold">{referrals.length}</p>
            <p className="text-xs text-gray-500">Tracked Clients</p>
          </CardContent>
        </Card>
      </div>

      {/* Consent Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-5 h-5" /> Client Consent Logs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {consentLogs.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No consent logs for your referred clients</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Consent Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {consentLogs.slice(0, 20).map(c => (
                    <TableRow key={c.id}>
                      <TableCell className="text-sm">{clientIdToName[c.client_id] || c.client_id}</TableCell>
                      <TableCell className="capitalize text-sm">{c.consent_type?.replace(/_/g, ' ')}</TableCell>
                      <TableCell>
                        <Badge className={c.consent_given ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}>
                          {c.consent_given ? 'Active' : 'Revoked'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-gray-500">{moment(c.created_at).format('DD MMM YY')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Erasure Requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Trash2 className="w-5 h-5" /> Client Erasure Requests
          </CardTitle>
        </CardHeader>
        <CardContent>
          {erasureRequests.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No erasure requests for your referred clients</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Data Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {erasureRequests.map(e => (
                    <TableRow key={e.id}>
                      <TableCell className="text-sm">{clientIdToName[e.client_id] || e.client_id}</TableCell>
                      <TableCell className="capitalize text-sm">{e.data_type?.replace(/_/g, ' ')}</TableCell>
                      <TableCell>
                        <Badge className={e.status === 'completed' ? 'bg-green-100 text-green-800' : e.status === 'pending' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100'}>
                          {e.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-gray-500">{moment(e.created_at).format('DD MMM YY')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* DPO */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-medium text-gray-900">Data Protection Officer</p>
              <p className="text-sm text-gray-600 mt-1">BolifyAI Sales Team — connect@bolify.ai</p>
              <p className="text-xs text-gray-400 mt-1">For compliance queries regarding your referred clients</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}