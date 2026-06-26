import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, FileText, Printer, Eye, Search, Download } from 'lucide-react';
import moment from 'moment';

export default function AdminSignedAgreements() {
  const [agreements, setAgreements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [viewHtml, setViewHtml] = useState(null);
  const [viewTitle, setViewTitle] = useState('');

  useEffect(() => { loadAgreements(); }, []);

  const loadAgreements = async () => {
    const [clientAgrs, partnerAgrs] = await Promise.all([
      apiClient.ClientAgreement.list('-created_at'),
      apiClient.PartnerAgreement.list('-created_at'),
    ]);

    const all = [
      ...clientAgrs.map(a => ({ ...a, _type: 'Client' })),
      ...partnerAgrs.map(a => ({ ...a, _type: 'Partner' })),
    ].sort((a, b) => new Date(b.signed_date || b.created_at) - new Date(a.signed_date || a.created_at));

    setAgreements(all);
    setLoading(false);
  };

  const handlePrint = (agr) => {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>${agr.agreement_number}</title><style>body{margin:0}@media print{body{-webkit-print-color-adjust:exact}}</style></head><body>${agr.rendered_html}</body></html>`);
    w.document.close();
    w.print();
  };

  const filtered = agreements.filter(a => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (a.agreement_number || '').toLowerCase().includes(s) ||
      (a.client_name || a.partner_name || '').toLowerCase().includes(s) ||
      (a.signatory_name || a.signature_name || '').toLowerCase().includes(s) ||
      (a.signatory_email || a.partner_email || '').toLowerCase().includes(s) ||
      (a._type || '').toLowerCase().includes(s)
    );
  });

  const statusColors = {
    signed: 'bg-green-100 text-green-800',
    pending_signature: 'bg-yellow-100 text-yellow-800',
    expired: 'bg-red-100 text-red-800',
    revoked: 'bg-gray-100 text-gray-600',
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h3 className="font-semibold text-lg">All Signed Agreements ({filtered.length})</h3>
        <div className="relative w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input placeholder="Search by name, number..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agreement #</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Signed By</TableHead>
                <TableHead>Signed Date</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-gray-400 py-8">No agreements found</TableCell></TableRow>
              ) : filtered.map(agr => (
                <TableRow key={agr.id}>
                  <TableCell className="font-mono text-xs font-medium">{agr.agreement_number}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={agr._type === 'Client' ? 'border-blue-300 text-blue-700' : 'border-purple-300 text-purple-700'}>
                      {agr._type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{agr.client_name || agr.partner_name || agr.partner_company || '-'}</TableCell>
                  <TableCell>
                    <div className="text-sm">{agr.signatory_name || agr.signature_name || '-'}</div>
                    <div className="text-xs text-gray-400">{agr.signatory_email || agr.partner_email || ''}</div>
                  </TableCell>
                  <TableCell className="text-sm">{agr.signed_date ? moment(agr.signed_date).format('DD MMM YYYY, h:mm A') : '-'}</TableCell>
                  <TableCell className="text-sm">{agr.expiry_date || '-'}</TableCell>
                  <TableCell><Badge className={statusColors[agr.status] || 'bg-gray-100'}>{agr.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center gap-1 justify-end">
                      {agr.rendered_html && (
                        <>
                          <Button size="sm" variant="ghost" title="View" onClick={() => { setViewHtml(agr.rendered_html); setViewTitle(agr.agreement_number); }}>
                            <Eye className="w-4 h-4" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Print / Save as PDF" onClick={() => handlePrint(agr)}>
                            <Printer className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!viewHtml} onOpenChange={() => setViewHtml(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>{viewTitle}</span>
              <Button size="sm" variant="outline" onClick={() => { const w = window.open('', '_blank'); w.document.write(`<html><head><title>${viewTitle}</title><style>body{margin:0}@media print{body{-webkit-print-color-adjust:exact}}</style></head><body>${viewHtml}</body></html>`); w.document.close(); w.print(); }}>
                <Printer className="w-4 h-4 mr-1" /> Print
              </Button>
            </DialogTitle>
          </DialogHeader>
          <div dangerouslySetInnerHTML={{ __html: viewHtml }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}