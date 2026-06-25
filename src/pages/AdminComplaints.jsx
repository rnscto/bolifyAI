import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Plus, Phone, Search, Loader2, Shield, Ban, CheckCircle2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import moment from 'moment';

const STATUS_COLORS = {
  open: 'bg-red-100 text-red-800',
  investigating: 'bg-yellow-100 text-yellow-800',
  resolved: 'bg-green-100 text-green-800',
  cooling_off: 'bg-orange-100 text-orange-800',
  escalated: 'bg-purple-100 text-purple-800',
};

const TYPE_COLORS = {
  spam: 'bg-red-50 text-red-700',
  unsolicited: 'bg-orange-50 text-orange-700',
  harassment: 'bg-red-50 text-red-700',
  ai_non_disclosure: 'bg-blue-50 text-blue-700',
  privacy_violation: 'bg-purple-50 text-purple-700',
  other: 'bg-gray-50 text-gray-700',
};

export default function AdminComplaints() {
  const [complaints, setComplaints] = useState([]);
  const [clients, setClients] = useState([]);
  const [dids, setDids] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [selectedComplaint, setSelectedComplaint] = useState(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    did_number: '', client_id: '', complainant_number: '',
    complaint_type: 'spam', complaint_source: 'customer_support',
    description: '',
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const [c, cl, d] = await Promise.all([
      base44.entities.ComplaintLog.list('-created_at', 200),
      base44.entities.Client.list('-created_at'),
      base44.entities.DID.list(),
    ]);
    setComplaints(c);
    setClients(cl);
    setDids(d);
    setLoading(false);
  };

  const clientMap = {};
  clients.forEach(c => { clientMap[c.id] = c.company_name; });

  const handleCreate = async () => {
    setSaving(true);
    // Find client by DID if not set
    let clientId = form.client_id;
    if (!clientId && form.did_number) {
      const did = dids.find(d => d.number === form.did_number);
      if (did?.client_id) clientId = did.client_id;
    }

    await base44.entities.ComplaintLog.create({
      ...form,
      client_id: clientId,
      status: 'open',
    });

    // Audit log
    const user = await base44.auth.me();
    await base44.entities.AuditLog.create({
      client_id: clientId,
      action_type: 'consent_revoked',
      actor_email: user.email,
      actor_role: 'admin',
      details: `Complaint logged against DID ${form.did_number}: ${form.complaint_type}`,
    });

    toast.success('Complaint logged');
    setShowCreateDialog(false);
    setForm({ did_number: '', client_id: '', complainant_number: '', complaint_type: 'spam', complaint_source: 'customer_support', description: '' });
    setSaving(false);
    loadData();
  };

  const handleStatusUpdate = async (complaint, newStatus, resolution = '') => {
    setSaving(true);
    const updates = { status: newStatus };
    if (resolution) updates.resolution_notes = resolution;

    // If cooling_off — auto-suspend the DID
    if (newStatus === 'cooling_off') {
      const did = dids.find(d => d.number === complaint.did_number);
      if (did) {
        await base44.entities.DID.update(did.id, { status: 'inactive', reserved_note: `Cooling off — complaint ID ${complaint.id}` });
        updates.auto_action_taken = `DID ${complaint.did_number} suspended (cooling off)`;
        toast.info(`DID ${complaint.did_number} suspended for cooling off`);
      }
    }

    await base44.entities.ComplaintLog.update(complaint.id, updates);
    const user = await base44.auth.me();
    await base44.entities.AuditLog.create({
      client_id: complaint.client_id,
      action_type: 'emergency_takedown',
      actor_email: user.email,
      actor_role: 'admin',
      details: `Complaint ${complaint.id} status → ${newStatus}. DID: ${complaint.did_number}`,
    });

    toast.success(`Complaint updated to ${newStatus}`);
    setSaving(false);
    setShowDetailDialog(false);
    loadData();
  };

  // Count complaints per DID for auto-cooling-off badge
  const didComplaintCounts = {};
  complaints.forEach(c => {
    if (!didComplaintCounts[c.did_number]) didComplaintCounts[c.did_number] = new Set();
    if (c.complainant_number) didComplaintCounts[c.did_number].add(c.complainant_number);
  });

  const filtered = complaints.filter(c => {
    const matchSearch = !search || c.did_number?.includes(search) || c.complainant_number?.includes(search) || clientMap[c.client_id]?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  // Stats
  const openCount = complaints.filter(c => c.status === 'open').length;
  const coolingCount = complaints.filter(c => c.status === 'cooling_off').length;
  const resolvedCount = complaints.filter(c => c.status === 'resolved').length;
  const atRiskDids = Object.entries(didComplaintCounts).filter(([_, s]) => s.size >= 2).length;

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Complaint Management</h1>
          <p className="text-gray-600 mt-1">TRAI TCCCPR compliance — track, investigate, and resolve complaints</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="bg-red-600 hover:bg-red-700">
          <Plus className="w-4 h-4 mr-2" /> Log Complaint
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card><CardContent className="pt-4 pb-3 text-center">
          <AlertTriangle className="w-6 h-6 text-red-600 mx-auto mb-1" />
          <p className="text-2xl font-bold">{openCount}</p>
          <p className="text-xs text-gray-500">Open</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <Ban className="w-6 h-6 text-orange-600 mx-auto mb-1" />
          <p className="text-2xl font-bold">{coolingCount}</p>
          <p className="text-xs text-gray-500">Cooling Off</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <CheckCircle2 className="w-6 h-6 text-green-600 mx-auto mb-1" />
          <p className="text-2xl font-bold">{resolvedCount}</p>
          <p className="text-xs text-gray-500">Resolved</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <Shield className="w-6 h-6 text-purple-600 mx-auto mb-1" />
          <p className="text-2xl font-bold text-red-600">{atRiskDids}</p>
          <p className="text-xs text-gray-500">At-Risk DIDs (≥2)</p>
        </CardContent></Card>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
          <Input placeholder="Search DID, phone, or client..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="investigating">Investigating</SelectItem>
            <SelectItem value="cooling_off">Cooling Off</SelectItem>
            <SelectItem value="escalated">Escalated</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Complaints Table */}
      <Card>
        <CardHeader><CardTitle className="text-base">Complaints ({filtered.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>DID</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Complainant</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-gray-400 py-8">No complaints found</TableCell></TableRow>
                ) : filtered.map(c => (
                  <TableRow key={c.id} className="cursor-pointer hover:bg-gray-50" onClick={() => { setSelectedComplaint(c); setShowDetailDialog(true); }}>
                    <TableCell className="font-mono text-sm">
                      {c.did_number}
                      {didComplaintCounts[c.did_number]?.size >= 3 && <Badge className="ml-1 bg-red-600 text-white text-[10px]">3+ ⚠️</Badge>}
                    </TableCell>
                    <TableCell className="text-sm">{clientMap[c.client_id] || '-'}</TableCell>
                    <TableCell className="text-sm font-mono">{c.complainant_number || '-'}</TableCell>
                    <TableCell><Badge className={TYPE_COLORS[c.complaint_type] || 'bg-gray-100'}>{c.complaint_type?.replace(/_/g, ' ')}</Badge></TableCell>
                    <TableCell className="text-sm capitalize">{c.complaint_source?.replace(/_/g, ' ')}</TableCell>
                    <TableCell><Badge className={STATUS_COLORS[c.status]}>{c.status?.replace(/_/g, ' ')}</Badge></TableCell>
                    <TableCell className="text-sm text-gray-500">{moment(c.created_at).format('DD MMM YY HH:mm')}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); setSelectedComplaint(c); setShowDetailDialog(true); }}>View</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Log New Complaint</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>DID Number *</Label>
              <Select value={form.did_number} onValueChange={v => {
                const did = dids.find(d => d.number === v);
                setForm({ ...form, did_number: v, client_id: did?.client_id || '' });
              }}>
                <SelectTrigger><SelectValue placeholder="Select DID" /></SelectTrigger>
                <SelectContent>
                  {dids.filter(d => d.status === 'assigned').map(d => (
                    <SelectItem key={d.id} value={d.number}>{d.number} — {clientMap[d.client_id] || 'Unassigned'}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Complainant Phone</Label>
              <Input value={form.complainant_number} onChange={e => setForm({ ...form, complainant_number: e.target.value })} placeholder="+91..." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Type</Label>
                <Select value={form.complaint_type} onValueChange={v => setForm({ ...form, complaint_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="spam">Spam</SelectItem>
                    <SelectItem value="unsolicited">Unsolicited</SelectItem>
                    <SelectItem value="harassment">Harassment</SelectItem>
                    <SelectItem value="ai_non_disclosure">AI Non-Disclosure</SelectItem>
                    <SelectItem value="privacy_violation">Privacy Violation</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Source</Label>
                <Select value={form.complaint_source} onValueChange={v => setForm({ ...form, complaint_source: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trai_portal">TRAI Portal</SelectItem>
                    <SelectItem value="customer_support">Customer Support</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="legal_notice">Legal Notice</SelectItem>
                    <SelectItem value="internal">Internal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} placeholder="Details about the complaint..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving || !form.did_number} className="bg-red-600 hover:bg-red-700">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Log Complaint'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail / Action Dialog */}
      <ComplaintDetailDialog
        complaint={selectedComplaint}
        open={showDetailDialog}
        onOpenChange={setShowDetailDialog}
        clientMap={clientMap}
        didComplaintCount={selectedComplaint ? didComplaintCounts[selectedComplaint.did_number]?.size || 0 : 0}
        onStatusUpdate={handleStatusUpdate}
        saving={saving}
      />
    </div>
  );
}

function ComplaintDetailDialog({ complaint, open, onOpenChange, clientMap, didComplaintCount, onStatusUpdate, saving }) {
  const [resolution, setResolution] = useState('');

  if (!complaint) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Complaint Details</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-gray-500">DID:</span> <span className="font-mono font-medium">{complaint.did_number}</span></div>
            <div><span className="text-gray-500">Client:</span> {clientMap[complaint.client_id] || '-'}</div>
            <div><span className="text-gray-500">Complainant:</span> <span className="font-mono">{complaint.complainant_number || '-'}</span></div>
            <div><span className="text-gray-500">Source:</span> <span className="capitalize">{complaint.complaint_source?.replace(/_/g, ' ')}</span></div>
            <div><span className="text-gray-500">Type:</span> <Badge className={TYPE_COLORS[complaint.complaint_type]}>{complaint.complaint_type?.replace(/_/g, ' ')}</Badge></div>
            <div><span className="text-gray-500">Status:</span> <Badge className={STATUS_COLORS[complaint.status]}>{complaint.status?.replace(/_/g, ' ')}</Badge></div>
          </div>

          {complaint.description && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm">{complaint.description}</div>
          )}

          {complaint.auto_action_taken && (
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm text-orange-800">
              <strong>Auto Action:</strong> {complaint.auto_action_taken}
            </div>
          )}

          {complaint.resolution_notes && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
              <strong>Resolution:</strong> {complaint.resolution_notes}
            </div>
          )}

          {didComplaintCount >= 3 && complaint.status !== 'cooling_off' && (
            <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-800">
              ⚠️ This DID has <strong>{didComplaintCount} unique complaints</strong>. TRAI requires immediate cooling off!
            </div>
          )}

          {complaint.status !== 'resolved' && (
            <>
              <div>
                <Label>Resolution Notes</Label>
                <Textarea value={resolution} onChange={e => setResolution(e.target.value)} rows={2} placeholder="Add notes..." />
              </div>
              <div className="flex flex-wrap gap-2">
                {complaint.status === 'open' && (
                  <Button size="sm" variant="outline" onClick={() => onStatusUpdate(complaint, 'investigating', resolution)} disabled={saving}>
                    <Clock className="w-3 h-3 mr-1" /> Investigating
                  </Button>
                )}
                <Button size="sm" className="bg-orange-600 hover:bg-orange-700" onClick={() => onStatusUpdate(complaint, 'cooling_off', resolution)} disabled={saving}>
                  <Ban className="w-3 h-3 mr-1" /> Cooling Off (Suspend DID)
                </Button>
                <Button size="sm" className="bg-purple-600 hover:bg-purple-700" onClick={() => onStatusUpdate(complaint, 'escalated', resolution)} disabled={saving}>
                  <AlertTriangle className="w-3 h-3 mr-1" /> Escalate
                </Button>
                <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => onStatusUpdate(complaint, 'resolved', resolution)} disabled={saving}>
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Resolve
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}