import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { IndianRupee, Download, FileText } from 'lucide-react';
import moment from 'moment';

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  paid: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
};

export default function PayoutHistory({ payouts }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2"><IndianRupee className="w-5 h-5" /> Payout History</CardTitle>
      </CardHeader>
      <CardContent>
        {payouts.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <FileText className="w-10 h-10 mx-auto mb-2 text-gray-600" />
            <p className="font-medium">No payouts yet</p>
            <p className="text-sm">Payouts will appear here once your referrals generate revenue.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>TDS</TableHead>
                  <TableHead>Net Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Paid Date</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.map(p => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-sm">{p.invoice_number || '-'}</TableCell>
                    <TableCell className="text-sm">
                      {p.period_start && p.period_end
                        ? `${moment(p.period_start).format('DD MMM')} - ${moment(p.period_end).format('DD MMM YYYY')}`
                        : '-'}
                    </TableCell>
                    <TableCell className="font-medium">₹{(p.amount || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-sm text-gray-500">₹{(p.tds_amount || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="font-medium text-green-700">₹{(p.net_amount || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell>
                      <Badge className={STATUS_COLORS[p.status] || 'bg-gray-100'}>{p.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">{p.paid_date ? moment(p.paid_date).format('DD MMM YYYY') : '-'}</TableCell>
                    <TableCell>
                      {p.invoice_url && (
                        <Button variant="ghost" size="icon" asChild>
                          <a href={p.invoice_url} target="_blank" rel="noopener noreferrer"><Download className="w-4 h-4" /></a>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}