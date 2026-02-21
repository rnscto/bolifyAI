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
import {
  Loader2, Search, Check, X, Eye, IndianRupee, Users, TrendingUp, FileText, Plus
} from 'lucide-react';
import { toast } from 'sonner';
import moment from 'moment';

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
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showPayoutDialog, setShowPayoutDialog] = useState(false);
  const [payoutForm, setPayoutForm] = useState({ amount: 0, period_start: '', period_end: '', payment_method: 'bank_transfer', notes: '', tds_amount: 0 });
  const [saving, setSaving] = useState(false);

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

  const handleApprove = async (partner) => {
    await base44.entities.Partner.update(partner.id, { status: 'approved' });

    // Invite partner as user
    try {
      await base44.users.inviteUser(partner.email, 'user');
    } catch (e) { console.log('User may already exist'); }

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

  const handleCreatePayout = async () => {
    if (!selectedPartner || payoutForm.amount <= 0) return;
    setSaving(true);

    const invoiceNum = `VAANI-INV-${new Date().getFullYear()}-${String(payouts.length + 1).padStart(3, '0')}`;
    const netAmount = payoutForm.amount - (payoutForm.tds_amount || 0);

    await base44.entities.PartnerPayout.create({
      partner_id: selectedPartner.id,
      partner_name: selectedPartner.name,
      amount: payoutForm.amount,
      period_start: payoutForm.period_start,
      period_end: payoutForm.period_end,
      payment_method: payoutForm.payment_method,
      notes: payoutForm.notes,
      tds_amount: payoutForm.tds_amount || 0,
      net_amount: netAmount,
      invoice_number: invoiceNum,
      status: 'pending',
    });

    toast.success(`Payout of ₹${netAmount.toLocaleString('en-IN')} created for ${selectedPartner.name}`);
    setShowPayoutDialog(false);
    setPayoutForm({ amount: 0, period_start: '', period_end: '', payment_method: 'bank_transfer', notes: '', tds_amount: 0 });
    setSaving(false);
    loadData();
  };

  const handleMarkPaid = async (payout) => {
    await base44.entities.PartnerPayout.update(payout.id, {
      status: 'paid',
      paid_date: new Date().toISOString()
    });

    // Update partner totals
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

  const filteredPartners = partners.filter(p =>
    !search || p.name?.toLowerCase().includes(search.toLowerCase()) ||
    p.email?.toLowerCase().includes(search.toLowerCase()) ||
    p.referral_code?.toLowerCase().includes(search.toLowerCase())
  );

  const pendingCount = partners.filter(p => p.status === 'pending').length;
  const approvedCount = partners.filter(p => p.status === 'approved').length;
  const totalEarned = partners.reduce((sum, p) => sum + (p.total_earned || 0), 0);
  const totalPaid = partners.reduce((sum, p) => sum + (p.total_paid || 0), 0);

  if (loading) {
    return <div className="flex items-center justify-center min-h-[400px]"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Partner Management</h1>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold">{partners.length}</p>
          <p className="text-xs text-gray-500">Total Partners</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-yellow-600">{pendingCount}</p>
          <p className="text-xs text-gray-500">Pending Approval</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-green-600">{approvedCount}</p>
          <p className="text-xs text-gray-500">Active Partners</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-orange-600">₹{totalEarned.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500">Total Commission</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-2xl font-bold text-purple-600">₹{totalPaid.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500">Total Paid</p>
        </CardContent></Card>
      </div>

      <Tabs defaultValue="partners">
        <TabsList>
          <TabsTrigger value="partners">Partners ({partners.length})</TabsTrigger>
          <TabsTrigger value="referrals">All Referrals ({referrals.length})</TabsTrigger>
          <TabsTrigger value="payouts">All Payouts ({payouts.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="partners">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <Input placeholder="Search partners..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Partner</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>Status</TableHead>
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
                          <p className="font-medium">{p.name}</p>
                          <p className="text-xs text-gray-500">{p.email}</p>
                          {p.company_name && <p className="text-xs text-gray-400">{p.company_name}</p>}
                        </TableCell>
                        <TableCell className="font-mono text-sm">{p.referral_code}</TableCell>
                        <TableCell>
                          <Badge className={STATUS_COLORS[p.status]}>{p.status}</Badge>
                        </TableCell>
                        <TableCell>{p.total_referrals || 0}</TableCell>
                        <TableCell className="text-green-700 font-medium">₹{(p.total_earned || 0).toLocaleString('en-IN')}</TableCell>
                        <TableCell className="text-orange-600">₹{(p.pending_payout || 0).toLocaleString('en-IN')}</TableCell>
                        <TableCell className="text-sm text-gray-500">{moment(p.created_date).format('DD MMM YY')}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {p.status === 'pending' && (
                              <>
                                <Button size="sm" variant="ghost" className="text-green-600 h-8" onClick={() => handleApprove(p)}>
                                  <Check className="w-4 h-4" />
                                </Button>
                                <Button size="sm" variant="ghost" className="text-red-600 h-8" onClick={() => handleReject(p)}>
                                  <X className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {p.status === 'approved' && (
                              <>
                                <Button size="sm" variant="ghost" className="h-8" onClick={() => { setSelectedPartner(p); setShowPayoutDialog(true); }}>
                                  <IndianRupee className="w-4 h-4" />
                                </Button>
                                <Button size="sm" variant="ghost" className="text-red-600 h-8" onClick={() => handleSuspend(p)}>
                                  <X className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            <Button size="sm" variant="ghost" className="h-8" onClick={() => { setSelectedPartner(p); setShowDetail(true); }}>
                              <Eye className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

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

      {/* Partner Detail Dialog */}
      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Partner Details</DialogTitle>
          </DialogHeader>
          {selectedPartner && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-gray-500">Name:</span> <strong>{selectedPartner.name}</strong></div>
                <div><span className="text-gray-500">Email:</span> {selectedPartner.email}</div>
                <div><span className="text-gray-500">Phone:</span> {selectedPartner.phone}</div>
                <div><span className="text-gray-500">Company:</span> {selectedPartner.company_name || '-'}</div>
                <div><span className="text-gray-500">City:</span> {selectedPartner.city || '-'}</div>
                <div><span className="text-gray-500">State:</span> {selectedPartner.state || '-'}</div>
                <div><span className="text-gray-500">GST:</span> {selectedPartner.gst_number || '-'}</div>
                <div><span className="text-gray-500">PAN:</span> {selectedPartner.pan_number || '-'}</div>
                <div><span className="text-gray-500">Bank:</span> {selectedPartner.bank_name || '-'}</div>
                <div><span className="text-gray-500">A/C:</span> {selectedPartner.bank_account_number || '-'}</div>
                <div><span className="text-gray-500">IFSC:</span> {selectedPartner.bank_ifsc || '-'}</div>
                <div><span className="text-gray-500">UPI:</span> {selectedPartner.upi_id || '-'}</div>
              </div>
              <div className="border-t pt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><span className="text-gray-500">Referral Code:</span> <strong className="font-mono">{selectedPartner.referral_code}</strong></div>
                  <div><span className="text-gray-500">Commission:</span> {selectedPartner.commission_rate}%</div>
                  <div><span className="text-gray-500">Total Referrals:</span> {selectedPartner.total_referrals || 0}</div>
                  <div><span className="text-gray-500">Active:</span> {selectedPartner.active_referrals || 0}</div>
                  <div><span className="text-gray-500">Earned:</span> ₹{(selectedPartner.total_earned || 0).toLocaleString('en-IN')}</div>
                  <div><span className="text-gray-500">Paid:</span> ₹{(selectedPartner.total_paid || 0).toLocaleString('en-IN')}</div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Payout Dialog */}
      <Dialog open={showPayoutDialog} onOpenChange={setShowPayoutDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Payout — {selectedPartner?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Amount (₹)</Label>
                <Input type="number" value={payoutForm.amount} onChange={e => setPayoutForm({...payoutForm, amount: Number(e.target.value)})} />
              </div>
              <div>
                <Label>TDS (₹)</Label>
                <Input type="number" value={payoutForm.tds_amount} onChange={e => setPayoutForm({...payoutForm, tds_amount: Number(e.target.value)})} />
              </div>
              <div>
                <Label>Period Start</Label>
                <Input type="date" value={payoutForm.period_start} onChange={e => setPayoutForm({...payoutForm, period_start: e.target.value})} />
              </div>
              <div>
                <Label>Period End</Label>
                <Input type="date" value={payoutForm.period_end} onChange={e => setPayoutForm({...payoutForm, period_end: e.target.value})} />
              </div>
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
            <div>
              <Label>Notes</Label>
              <Input value={payoutForm.notes} onChange={e => setPayoutForm({...payoutForm, notes: e.target.value})} placeholder="Optional notes" />
            </div>
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