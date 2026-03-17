import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Loader2, Search, Check, X, Eye, IndianRupee, Users, TrendingUp, FileText, Plus,
  Pencil, RefreshCw, BarChart3
} from 'lucide-react';
import { toast } from 'sonner';
import moment from 'moment';

import AdminPartnerEditDialog from '../components/admin/AdminPartnerEditDialog';
import AdminPartnerDetailDialog from '../components/admin/AdminPartnerDetailDialog';
import AdminPartnerRevenueChart from '../components/admin/AdminPartnerRevenueChart';
import AdminPartnerExport from '../components/admin/AdminPartnerExport';

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  suspended: 'bg-red-100 text-red-800',
  rejected: 'bg-gray-100 text-gray-800',
};

export default function AdminPartners() {
  const [partners, setPartners] = useState([]);
  const [referrals, setReferrals] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showPayoutDialog, setShowPayoutDialog] = useState(false);
  const [payoutForm, setPayoutForm] = useState({ amount: 0, period_start: '', period_end: '', payment_method: 'bank_transfer', notes: '', tds_amount: 0 });
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const [p, r, pay] = await Promise.all([
      base44.entities.Partner.list('-created_date'),
      base44.entities.Referral.list('-created_date'),
      base44.entities.PartnerPayout.list('-created_date'),
    ]);
    setPartners(p);
    setReferrals(r);
    setPayouts(pay);
    setLoading(false);
  };

  // ─── Actions ───
  const handleApprove = async (partner) => {
    await base44.entities.Partner.update(partner.id, { status: 'approved' });
    try { await base44.users.inviteUser(partner.email, 'user'); } catch (e) {}
    toast.success(`${partner.name} approved!`);
    loadData();
  };

  const handleReject = async (partner) => {
    await base44.entities.Partner.update(partner.id, { status: 'rejected' });
    toast.success(`${partner.name} rejected`);
    loadData();
  };

  const handleSuspend = async (partner) => {
    await base44.entities.Partner.update(partner.id, { status: 'suspended' });
    toast.success(`${partner.name} suspended`);
    loadData();
  };

  const handleReactivate = async (partner) => {
    await base44.entities.Partner.update(partner.id, { status: 'approved' });
    toast.success(`${partner.name} reactivated!`);
    loadData();
  };

  // ─── Bulk Actions ───
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPartners.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredPartners.map(p => p.id)));
    }
  };

  const handleBulkApprove = async () => {
    setBulkAction(true);
    for (const id of selectedIds) {
      const p = partners.find(x => x.id === id);
      if (p?.status === 'pending') {
        await base44.entities.Partner.update(id, { status: 'approved' });
        try { await base44.users.inviteUser(p.email, 'user'); } catch (e) {}
      }
    }
    toast.success(`${selectedIds.size} partner(s) approved`);
    setSelectedIds(new Set());
    setBulkAction(false);
    loadData();
  };

  const handleBulkReject = async () => {
    setBulkAction(true);
    for (const id of selectedIds) {
      const p = partners.find(x => x.id === id);
      if (p?.status === 'pending') {
        await base44.entities.Partner.update(id, { status: 'rejected' });
      }
    }
    toast.success(`${selectedIds.size} partner(s) rejected`);
    setSelectedIds(new Set());
    setBulkAction(false);
    loadData();
  };

  // ─── Payout ───
  const handleCreatePayout = async () => {
    if (!selectedPartner || payoutForm.amount <= 0) return;
    setSaving(true);
    const invoiceNum = `VAANI-INV-${new Date().getFullYear()}-${String(payouts.length + 1).padStart(3, '0')}`;
    const netAmount = payoutForm.amount - (payoutForm.tds_amount || 0);
    await base44.entities.PartnerPayout.create({
      partner_id: selectedPartner.id, partner_name: selectedPartner.name,
      amount: payoutForm.amount, period_start: payoutForm.period_start,
      period_end: payoutForm.period_end, payment_method: payoutForm.payment_method,
      notes: payoutForm.notes, tds_amount: payoutForm.tds_amount || 0,
      net_amount: netAmount, invoice_number: invoiceNum, status: 'pending',
    });
    toast.success(`Payout of ₹${netAmount.toLocaleString('en-IN')} created`);
    setShowPayoutDialog(false);
    setPayoutForm({ amount: 0, period_start: '', period_end: '', payment_method: 'bank_transfer', notes: '', tds_amount: 0 });
    setSaving(false);
    loadData();
  };

  const handleMarkPaid = async (payout) => {
    await base44.entities.PartnerPayout.update(payout.id, { status: 'paid', paid_date: new Date().toISOString() });
    const partner = partners.find(p => p.id === payout.partner_id);
    if (partner) {
      await base44.entities.Partner.update(partner.id, {
        total_paid: (partner.total_paid || 0) + (payout.net_amount || payout.amount),
        pending_payout: Math.max(0, (partner.pending_payout || 0) - (payout.net_amount || payout.amount))
      });
    }
    toast.success('Payout marked as paid');
    loadData();
  };

  // ─── Filters ───
  const filteredPartners = partners.filter(p => {
    const matchesSearch = !search || p.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.email?.toLowerCase().includes(search.toLowerCase()) ||
      p.referral_code?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const pendingCount = partners.filter(p => p.status === 'pending').length;
  const approvedCount = partners.filter(p => p.status === 'approved').length;
  const suspendedCount = partners.filter(p => p.status === 'suspended').length;
  const totalEarned = partners.reduce((sum, p) => sum + (p.total_earned || 0), 0);
  const totalPaid = partners.reduce((sum, p) => sum + (p.total_paid || 0), 0);
  const selectedPendingCount = [...selectedIds].filter(id => partners.find(p => p.id === id)?.status === 'pending').length;

  if (loading) {
    return <div className="flex items-center justify-center min-h-[400px]"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Partner Management</h1>
        <AdminPartnerExport partners={partners} referrals={referrals} payouts={payouts} />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold">{partners.length}</p>
          <p className="text-xs text-gray-500">Total</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-yellow-600">{pendingCount}</p>
          <p className="text-xs text-gray-500">Pending</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-green-600">{approvedCount}</p>
          <p className="text-xs text-gray-500">Active</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-red-600">{suspendedCount}</p>
          <p className="text-xs text-gray-500">Suspended</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-orange-600">₹{totalEarned.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500">Commission</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-purple-600">₹{totalPaid.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500">Paid Out</p>
        </CardContent></Card>
      </div>

      <Tabs defaultValue="partners">
        <TabsList>
          <TabsTrigger value="partners">Partners ({partners.length})</TabsTrigger>
          <TabsTrigger value="analytics"><BarChart3 className="w-4 h-4 mr-1" /> Analytics</TabsTrigger>
          <TabsTrigger value="referrals">Referrals ({referrals.length})</TabsTrigger>
          <TabsTrigger value="payouts">Payouts ({payouts.length})</TabsTrigger>
        </TabsList>

        {/* ─── Partners Tab ─── */}
        <TabsContent value="partners">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col md:flex-row items-start md:items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <Input placeholder="Search partners..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Bulk Actions Bar */}
              {selectedIds.size > 0 && (
                <div className="flex items-center gap-2 mt-3 p-2 bg-blue-50 rounded-lg">
                  <span className="text-sm font-medium text-blue-800">{selectedIds.size} selected</span>
                  {selectedPendingCount > 0 && (
                    <>
                      <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700" onClick={handleBulkApprove} disabled={bulkAction}>
                        {bulkAction ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Check className="w-3 h-3 mr-1" /> Approve All</>}
                      </Button>
                      <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={handleBulkReject} disabled={bulkAction}>
                        <X className="w-3 h-3 mr-1" /> Reject All
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedIds(new Set())}>Clear</Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={selectedIds.size === filteredPartners.length && filteredPartners.length > 0}
                          onCheckedChange={toggleSelectAll}
                        />
                      </TableHead>
                      <TableHead>Partner</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Rate</TableHead>
                      <TableHead>Referrals</TableHead>
                      <TableHead>Earned</TableHead>
                      <TableHead>Pending</TableHead>
                      <TableHead>Joined</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPartners.map(p => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.has(p.id)}
                            onCheckedChange={() => toggleSelect(p.id)}
                          />
                        </TableCell>
                        <TableCell>
                          <p className="font-medium">{p.name}</p>
                          <p className="text-xs text-gray-500">{p.email}</p>
                          {p.company_name && <p className="text-xs text-gray-400">{p.company_name}</p>}
                        </TableCell>
                        <TableCell className="font-mono text-sm">{p.referral_code}</TableCell>
                        <TableCell><Badge className={STATUS_COLORS[p.status]}>{p.status}</Badge></TableCell>
                        <TableCell className="text-sm">{p.commission_rate ?? 20}%</TableCell>
                        <TableCell>{p.total_referrals || 0}</TableCell>
                        <TableCell className="text-green-700 font-medium">₹{(p.total_earned || 0).toLocaleString('en-IN')}</TableCell>
                        <TableCell className="text-orange-600">₹{(p.pending_payout || 0).toLocaleString('en-IN')}</TableCell>
                        <TableCell className="text-sm text-gray-500">{moment(p.created_date).format('DD MMM YY')}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {p.status === 'pending' && (
                              <>
                                <Button size="sm" variant="ghost" className="text-green-600 h-8" title="Approve" onClick={() => handleApprove(p)}>
                                  <Check className="w-4 h-4" />
                                </Button>
                                <Button size="sm" variant="ghost" className="text-red-600 h-8" title="Reject" onClick={() => handleReject(p)}>
                                  <X className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {p.status === 'approved' && (
                              <>
                                <Button size="sm" variant="ghost" className="h-8" title="Create Payout" onClick={() => { setSelectedPartner(p); setShowPayoutDialog(true); }}>
                                  <IndianRupee className="w-4 h-4" />
                                </Button>
                                <Button size="sm" variant="ghost" className="text-red-600 h-8" title="Suspend" onClick={() => handleSuspend(p)}>
                                  <X className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {(p.status === 'suspended' || p.status === 'rejected') && (
                              <Button size="sm" variant="ghost" className="text-green-600 h-8" title="Reactivate" onClick={() => handleReactivate(p)}>
                                <RefreshCw className="w-4 h-4" />
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" className="h-8" title="Edit" onClick={() => { setSelectedPartner(p); setShowEdit(true); }}>
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8" title="Details" onClick={() => { setSelectedPartner(p); setShowDetail(true); }}>
                              <Eye className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredPartners.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center text-gray-400 py-8">No partners found</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Analytics Tab ─── */}
        <TabsContent value="analytics">
          <AdminPartnerRevenueChart referrals={referrals} partners={partners} />
        </TabsContent>

        {/* ─── Referrals Tab ─── */}
        <TabsContent value="referrals">
          <Card>
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Partner</TableHead>
                      <TableHead>Code Used</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Plan Amount</TableHead>
                      <TableHead>Commission</TableHead>
                      <TableHead>Signup</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {referrals.map(r => {
                      const partner = partners.find(p => p.id === r.partner_id);
                      return (
                        <TableRow key={r.id}>
                          <TableCell>
                            <p className="font-medium">{r.client_name || '-'}</p>
                            <p className="text-xs text-gray-500">{r.client_email}</p>
                          </TableCell>
                          <TableCell className="text-sm">{partner?.name || '-'}</TableCell>
                          <TableCell className="font-mono text-sm">{r.referral_code_used}</TableCell>
                          <TableCell><Badge className={STATUS_COLORS[r.status] || 'bg-gray-100'}>{r.status}</Badge></TableCell>
                          <TableCell>₹{(r.client_plan_amount || 0).toLocaleString('en-IN')}/mo</TableCell>
                          <TableCell className="text-green-700">₹{(r.total_commission_earned || 0).toLocaleString('en-IN')}</TableCell>
                          <TableCell className="text-sm text-gray-500">{r.signup_date ? moment(r.signup_date).format('DD MMM YY') : '-'}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Payouts Tab ─── */}
        <TabsContent value="payouts">
          <Card>
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Partner</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>TDS</TableHead>
                      <TableHead>Net</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payouts.map(p => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-sm">{p.invoice_number || '-'}</TableCell>
                        <TableCell>{p.partner_name}</TableCell>
                        <TableCell>₹{(p.amount || 0).toLocaleString('en-IN')}</TableCell>
                        <TableCell className="text-gray-500">₹{(p.tds_amount || 0).toLocaleString('en-IN')}</TableCell>
                        <TableCell className="font-medium text-green-700">₹{(p.net_amount || 0).toLocaleString('en-IN')}</TableCell>
                        <TableCell><Badge className={STATUS_COLORS[p.status] || 'bg-gray-100'}>{p.status}</Badge></TableCell>
                        <TableCell className="text-sm">{p.payment_method || '-'}</TableCell>
                        <TableCell>
                          {(p.status === 'pending' || p.status === 'approved') && (
                            <Button size="sm" onClick={() => handleMarkPaid(p)} className="h-7 text-xs bg-green-600 hover:bg-green-700">
                              Mark Paid
                            </Button>
                          )}
                          {p.status === 'paid' && <span className="text-xs text-gray-400">{moment(p.paid_date).format('DD MMM YY')}</span>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <AdminPartnerDetailDialog partner={selectedPartner} open={showDetail} onOpenChange={setShowDetail} />
      <AdminPartnerEditDialog partner={selectedPartner} open={showEdit} onOpenChange={setShowEdit} onSaved={loadData} />

      {/* Create Payout Dialog */}
      <Dialog open={showPayoutDialog} onOpenChange={setShowPayoutDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Payout — {selectedPartner?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Amount (₹)</Label><Input type="number" value={payoutForm.amount} onChange={e => setPayoutForm({...payoutForm, amount: Number(e.target.value)})} /></div>
              <div><Label>TDS (₹)</Label><Input type="number" value={payoutForm.tds_amount} onChange={e => setPayoutForm({...payoutForm, tds_amount: Number(e.target.value)})} /></div>
              <div><Label>Period Start</Label><Input type="date" value={payoutForm.period_start} onChange={e => setPayoutForm({...payoutForm, period_start: e.target.value})} /></div>
              <div><Label>Period End</Label><Input type="date" value={payoutForm.period_end} onChange={e => setPayoutForm({...payoutForm, period_end: e.target.value})} /></div>
            </div>
            <div>
              <Label>Payment Method</Label>
              <Select value={payoutForm.payment_method} onValueChange={v => setPayoutForm({...payoutForm, payment_method: v})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                  <SelectItem value="upi">UPI</SelectItem>
                  <SelectItem value="cheque">Cheque</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Notes</Label><Input value={payoutForm.notes} onChange={e => setPayoutForm({...payoutForm, notes: e.target.value})} placeholder="Optional notes" /></div>
            {payoutForm.amount > 0 && (
              <div className="bg-green-50 rounded-lg p-3 text-sm">
                <p>Gross: ₹{payoutForm.amount.toLocaleString('en-IN')} | TDS: ₹{(payoutForm.tds_amount || 0).toLocaleString('en-IN')} | <strong>Net: ₹{(payoutForm.amount - (payoutForm.tds_amount || 0)).toLocaleString('en-IN')}</strong></p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPayoutDialog(false)}>Cancel</Button>
            <Button onClick={handleCreatePayout} disabled={saving || payoutForm.amount <= 0}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create Payout'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}