import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wallet, Clock, TrendingDown, Zap } from 'lucide-react';

export default function WalletCard({ client }) {
  const balance = client?.wallet_balance || 0;
  const freeMinutes = client?.free_minutes_remaining || 0;
  const totalUsed = client?.total_minutes_used || 0;
  const totalSpent = client?.total_amount_spent || 0;
  const rate = client?.per_minute_rate || 4;
  const paidMinutesAvail = Math.floor(balance / rate);
  const isLow = balance < 100 && freeMinutes <= 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card className={isLow ? 'border-red-200 bg-red-50' : ''}>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isLow ? 'bg-red-100' : 'bg-green-50'}`}>
              <Wallet className={`w-6 h-6 ${isLow ? 'text-red-600' : 'text-green-600'}`} />
            </div>
            <div>
              <p className={`text-2xl font-bold ${isLow ? 'text-red-700' : ''}`}>₹{balance.toLocaleString()}</p>
              <p className="text-sm text-gray-600">Wallet Balance</p>
              {isLow && <Badge className="bg-red-100 text-red-700 text-[10px] mt-1">Low Balance</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50">
              <Zap className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{freeMinutes}</p>
              <p className="text-sm text-gray-600">Free Minutes</p>
              {freeMinutes > 0 && <p className="text-xs text-blue-500 mt-0.5">Trial bonus</p>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-50">
              <Clock className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{freeMinutes + paidMinutesAvail}</p>
              <p className="text-sm text-gray-600">Minutes Available</p>
              <p className="text-xs text-gray-400 mt-0.5">@ ₹{rate}/min</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-50">
              <TrendingDown className="w-6 h-6 text-orange-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalUsed}</p>
              <p className="text-sm text-gray-600">Total Minutes Used</p>
              <p className="text-xs text-gray-400 mt-0.5">₹{totalSpent.toLocaleString()} spent</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}