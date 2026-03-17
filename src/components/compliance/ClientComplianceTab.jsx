import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Shield, FileText, Trash2, CheckCircle2, Clock, AlertTriangle, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import moment from 'moment';

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  partially_completed: 'bg-orange-100 text-orange-800',
};

export default function ClientComplianceTab({ client }) {
  const [consents, setConsents] = useState([]);
  const [erasureRequests, setErasureRequests] = useState([]);
  const [complaints, setComplaints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showErasureDialog, setShowErasureDialog] = useState(false);
  const [erasureForm, setErasureForm] = useState({ data_type: 'call_recordings', description: '' });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (client?.id) loadData();
  }, [client?.id]);

  const loadData = async () => {
    const [c, e, comp] = await Promise.all([
      base44.entities.ConsentLog.filter({ client_id: client.id }, '-created_date'),
      base44.entities.DataErasureRequest.filter({ client_id: client.id }, '-created_date'),
      base44.entities.ComplaintLog.filter({ client_id: client.id }, '-created_date'),
    ]);
    setConsents(c);
    setErasureRequests(e);
    setComplaints(comp);
    setLoading(false);
  };

  const handleErasureRequest = async () => {
    setSubmitting(true);
    const user = await base44.auth.me();
    await base44.entities.DataErasureRequest.create({
      client_id: client.id,
      requester_email: user.email,
      requester_name: user.full_name,
      data_type: erasureForm.data_type,
      description: erasureForm.description,
      status: 'pending',
    });
    await base44.entities.AuditLog.create({
      client_id: client.id,
      action_type: 'data_erasure',
      actor_email: user.email,
      details: `Data erasure requested: ${erasureForm.data_type}`,
    });
    toast.success('Erasure request submitted. Our DPO will process it within 72 hours.');
    setShowErasureDialog(false);
    setErasureForm({ data_type: 'call_recordings', description: '' });
    setSubmitting(false);
    loadData();
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <CheckCircle2 className="w-6 h-6 text-green-600 mx-auto mb-1" />
            <p className="text-lg font-bold">{client.dpdp_consent_given ? 'Yes' : 'No'}</p>
            <p className="text-xs text-gray-500">DPDP Consent</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <Shield className="w-6 h-6 text-blue-600 mx-auto mb-1" />
            <p className="text-lg font-bold">{client.dlt_registered ? 'Registered' : 'Pending'}</p>
            <p className="text-xs text-gray-500">DLT Status</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <Clock className="w-6 h-6 text-orange-600 mx-auto mb-1" />
            <p className="text-lg font-bold">{client.data_retention_days || 30} days</p>
            <p className="text-xs text-gray-500">Retention Period</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <AlertTriangle className="w-6 h-6 text-red-600 mx-auto mb-1" />
            <p className="text-lg font-bold">{complaints.filter(c => c.status === 'open').length}</p>
            <p className="text-xs text-gray-500">Open Complaints</p>
          </CardContent>
        </Card>
      </div>

      {/* Consent Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-5 h-5" /> Consent Logs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {consents.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No consent logs recorded</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Consent Type</TableHead>
                    <TableHead>Given By</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {consents.map(c => (
                    <TableRow key={c.id}>
                      <TableCell className="capitalize text-sm">{c.consent_type?.replace(/_/g, ' ')}</TableCell>
                      <TableCell className="text-sm">{c.given_by_email || '-'}</TableCell>
                      <TableCell className="text-sm">v{c.consent_version || '2.1'}</TableCell>
                      <TableCell>
                        <Badge className={c.consent_given ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}>
                          {c.consent_given ? 'Active' : 'Revoked'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-gray-500">{moment(c.created_date).format('DD MMM YY HH:mm')}</TableCell>
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
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Trash2 className="w-5 h-5" /> Data Erasure Requests
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowErasureDialog(true)}>
            Request Erasure
          </Button>
        </CardHeader>
        <CardContent>
          {erasureRequests.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No erasure requests</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data Type</TableHead>
                    <TableHead>Requester</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Records Deleted</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {erasureRequests.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="capitalize text-sm">{r.data_type?.replace(/_/g, ' ')}</TableCell>
                      <TableCell className="text-sm">{r.requester_email}</TableCell>
                      <TableCell><Badge className={STATUS_COLORS[r.status] || 'bg-gray-100'}>{r.status}</Badge></TableCell>
                      <TableCell className="text-sm">{r.records_deleted || 0}</TableCell>
                      <TableCell className="text-sm text-gray-500">{moment(r.created_date).format('DD MMM YY')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* DPO Info */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-medium text-gray-900">Data Protection Officer</p>
              <p className="text-sm text-gray-600 mt-1">Nand K. Yadav — nand@brainbucks.in — +91-7020609101</p>
              <p className="text-xs text-gray-400 mt-1">Contact for data access, correction, or erasure requests</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Erasure Dialog */}
      <Dialog open={showErasureDialog} onOpenChange={setShowErasureDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Request Data Erasure</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Data Type</Label>
              <Select value={erasureForm.data_type} onValueChange={v => setErasureForm({ ...erasureForm, data_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="call_recordings">Call Recordings</SelectItem>
                  <SelectItem value="transcripts">Transcripts</SelectItem>
                  <SelectItem value="lead_data">Lead Data</SelectItem>
                  <SelectItem value="all_personal_data">All Personal Data</SelectItem>
                  <SelectItem value="specific_records">Specific Records</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description</Label>
              <Input value={erasureForm.description} onChange={e => setErasureForm({ ...erasureForm, description: e.target.value })} placeholder="Describe what data should be erased..." />
            </div>
            <p className="text-xs text-gray-500">The DPO will process your request within 72 hours as per DPDP Act requirements.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowErasureDialog(false)}>Cancel</Button>
            <Button onClick={handleErasureRequest} disabled={submitting} className="bg-red-600 hover:bg-red-700">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit Request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}