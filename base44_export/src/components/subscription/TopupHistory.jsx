import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wallet, ArrowUpCircle } from 'lucide-react';
import InvoiceButton from './InvoiceButton';

const statusColors = {
  paid: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  failed: 'bg-red-100 text-red-800',
  refunded: 'bg-gray-100 text-gray-800',
};

// Parse the description JSON stored by createTopupOrder
const parseTopupMeta = (desc) => {
  if (!desc) return null;
  try {
    const meta = JSON.parse(desc);
    if (meta?.type === 'wallet_topup') return meta;
  } catch (_) {}
  return null;
};

export default function TopupHistory({ payments, rate = 4 }) {
  // Filter only wallet top-up payments
  const topups = (payments || [])
    .map(p => ({ ...p, meta: parseTopupMeta(p.description) }))
    .filter(p => p.meta !== null);

  const totalToppedUp = topups
    .filter(p => p.status === 'paid')
    .reduce((sum, p) => sum + (p.meta?.amount || 0), 0);

  const totalMinutes = Math.floor(totalToppedUp / rate);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-emerald-100 rounded-lg">
              <Wallet className="w-5 h-5 text-emerald-700" />
            </div>
            <div>
              <CardTitle className="text-lg">Top-Up History & Billing</CardTitle>
              <p className="text-sm text-gray-500 mt-0.5">Minutes purchased & GST invoices</p>
            </div>
          </div>
          {topups.length > 0 && (
            <div className="text-right">
              <p className="text-xs text-gray-500">Total Topped Up</p>
              <p className="text-lg font-bold text-emerald-700">
                ₹{totalToppedUp.toLocaleString()} <span className="text-xs font-medium text-gray-500">({totalMinutes} min)</span>
              </p>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {topups.length === 0 ? (
          <div className="text-center py-8">
            <ArrowUpCircle className="w-10 h-10 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No top-ups yet</p>
            <p className="text-xs text-gray-400 mt-1">Your top-up transactions will appear here</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 border-b">
                <tr>
                  <th className="text-left py-2 font-medium">Date</th>
                  <th className="text-right py-2 font-medium">Base</th>
                  <th className="text-right py-2 font-medium">GST (18%)</th>
                  <th className="text-right py-2 font-medium">Total Paid</th>
                  <th className="text-right py-2 font-medium">Minutes</th>
                  <th className="text-center py-2 font-medium">Status</th>
                  <th className="text-right py-2 font-medium">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {topups.map((p) => {
                  const base = p.meta?.amount || 0;
                  const gst = p.meta?.gst || 0;
                  const total = p.meta?.total || p.amount || 0;
                  const minutes = Math.floor(base / rate);
                  const dateStr = p.paid_at || p.created_date;
                  return (
                    <tr key={p.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="py-3">
                        {new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                        <p className="text-xs text-gray-400">
                          {new Date(dateStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </td>
                      <td className="text-right">₹{base.toLocaleString()}</td>
                      <td className="text-right text-gray-600">₹{gst.toLocaleString()}</td>
                      <td className="text-right font-semibold">₹{total.toLocaleString()}</td>
                      <td className="text-right">
                        <span className="text-emerald-700 font-medium">{minutes}</span>
                        <span className="text-xs text-gray-400 ml-1">min</span>
                      </td>
                      <td className="text-center">
                        <Badge className={statusColors[p.status] || 'bg-gray-100 text-gray-800'}>
                          {p.status}
                        </Badge>
                      </td>
                      <td className="text-right">
                        {p.status === 'paid' && <InvoiceButton paymentId={p.id} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}