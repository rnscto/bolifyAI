import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { IndianRupee, Users, TrendingUp, Wallet } from 'lucide-react';

export default function PartnerStats({ partner }) {
  const stats = [
    { label: 'Total Referrals', value: partner?.total_referrals || 0, icon: Users, color: 'text-blue-600 bg-blue-50' },
    { label: 'Active Clients', value: partner?.active_referrals || 0, icon: TrendingUp, color: 'text-green-600 bg-green-50' },
    { label: 'Total Earned', value: `₹${(partner?.total_earned || 0).toLocaleString('en-IN')}`, icon: IndianRupee, color: 'text-orange-600 bg-orange-50' },
    { label: 'Pending Payout', value: `₹${(partner?.pending_payout || 0).toLocaleString('en-IN')}`, icon: Wallet, color: 'text-purple-600 bg-purple-50' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((s, i) => (
        <Card key={i}>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className={`p-2.5 rounded-lg ${s.color}`}>
                <s.icon className="w-5 h-5" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}