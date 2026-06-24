import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Users } from 'lucide-react';
import moment from 'moment';

const STATUS_COLORS = {
  signed_up: 'bg-blue-100 text-blue-800',
  trial: 'bg-yellow-100 text-yellow-800',
  converted: 'bg-green-100 text-green-800',
  churned: 'bg-red-100 text-red-800',
};

export default function ReferralsList({ referrals }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2"><Users className="w-5 h-5" /> Your Referrals</CardTitle>
      </CardHeader>
      <CardContent>
        {referrals.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Users className="w-10 h-10 mx-auto mb-2 text-gray-300" />
            <p className="font-medium">No referrals yet</p>
            <p className="text-sm">Share your referral code or link to start earning!</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Plan Amount</TableHead>
                  <TableHead>Commission Earned</TableHead>
                  <TableHead>Signup Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrals.map(r => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <p className="font-medium">{r.client_name || r.client_email}</p>
                      <p className="text-xs text-gray-500">{r.client_email}</p>
                    </TableCell>
                    <TableCell>
                      <Badge className={STATUS_COLORS[r.status] || 'bg-gray-100 text-gray-800'}>{r.status}</Badge>
                    </TableCell>
                    <TableCell>₹{(r.client_plan_amount || 0).toLocaleString('en-IN')}/mo</TableCell>
                    <TableCell className="font-medium text-green-700">₹{(r.total_commission_earned || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-sm text-gray-500">{r.signup_date ? moment(r.signup_date).format('DD MMM YYYY') : '-'}</TableCell>
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