import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import moment from 'moment';

export default function AdminPartnerRevenueChart({ referrals, partners }) {
  const chartData = useMemo(() => {
    // Group referrals by month
    const monthMap = {};
    const now = moment();
    // Last 6 months
    for (let i = 5; i >= 0; i--) {
      const key = now.clone().subtract(i, 'months').format('MMM YY');
      monthMap[key] = { month: key, signups: 0, revenue: 0, commission: 0 };
    }

    referrals.forEach(r => {
      const m = r.signup_date ? moment(r.signup_date).format('MMM YY') : null;
      if (m && monthMap[m]) {
        monthMap[m].signups += 1;
        monthMap[m].revenue += (r.client_plan_amount || 0);
        monthMap[m].commission += (r.total_commission_earned || 0);
      }
    });

    return Object.values(monthMap);
  }, [referrals]);

  const topPartners = useMemo(() => {
    return [...partners]
      .sort((a, b) => (b.total_earned || 0) - (a.total_earned || 0))
      .slice(0, 5);
  }, [partners]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-lg">Partner Revenue Attribution (6 Months)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip formatter={(v) => `₹${v.toLocaleString('en-IN')}`} />
              <Legend />
              <Bar dataKey="revenue" name="Revenue (₹)" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              <Bar dataKey="commission" name="Commission (₹)" fill="#f97316" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Top Partners</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {topPartners.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  <p className="text-xs text-gray-500">{p.total_referrals || 0} referrals</p>
                </div>
                <p className="text-sm font-semibold text-green-700">₹{(p.total_earned || 0).toLocaleString('en-IN')}</p>
              </div>
            ))}
            {topPartners.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No partner data yet</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}