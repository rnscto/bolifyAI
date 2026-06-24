import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Wallet, Plus } from 'lucide-react';

const TOPUP_OPTIONS = [
  { amount: 500, label: '₹500', minutes: 125, popular: false },
  { amount: 1000, label: '₹1,000', minutes: 250, popular: true },
  { amount: 2000, label: '₹2,000', minutes: 500, popular: false },
  { amount: 5000, label: '₹5,000', minutes: 1250, popular: false },
];

export default function TopupSection({ onTopup, loading, rate = 4 }) {
  const [selectedAmount, setSelectedAmount] = useState(1000);
  const [customAmount, setCustomAmount] = useState('');

  const activeAmount = customAmount ? parseInt(customAmount) : selectedAmount;
  const gstRate = 0.18;
  const gstAmount = isNaN(activeAmount) ? 0 : Math.round(activeAmount * gstRate);
  const totalPayable = activeAmount + gstAmount;
  const minutesForAmount = Math.floor(activeAmount / rate);
  const isValid = activeAmount >= 500;

  return (
    <Card className="border-2 border-green-200 bg-gradient-to-br from-green-50 to-white">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="p-2 bg-green-100 rounded-lg">
            <Plus className="w-5 h-5 text-green-700" />
          </div>
          <div>
            <CardTitle className="text-lg">Top Up Wallet</CardTitle>
            <p className="text-sm text-gray-500 mt-0.5">Minimum ₹500 • ₹{rate}/min calling rate</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick amount buttons */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {TOPUP_OPTIONS.map((opt) => (
            <button
              key={opt.amount}
              onClick={() => { setSelectedAmount(opt.amount); setCustomAmount(''); }}
              className={`relative p-3 rounded-xl border-2 text-center transition-all ${
                !customAmount && selectedAmount === opt.amount
                  ? 'border-green-500 bg-green-50 ring-2 ring-green-200'
                  : 'border-gray-200 hover:border-green-300'
              }`}
            >
              {opt.popular && (
                <Badge className="absolute -top-2 left-1/2 -translate-x-1/2 bg-green-600 text-white text-[9px]">
                  Popular
                </Badge>
              )}
              <p className="font-bold text-lg">{opt.label}</p>
              <p className="text-xs text-gray-500">{opt.minutes} minutes</p>
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">Or enter custom:</span>
          <div className="relative flex-1 max-w-[200px]">
            <span className="absolute left-3 top-2.5 text-gray-400 text-sm">₹</span>
            <input
              type="number"
              placeholder="500"
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              min={500}
              step={100}
              className="w-full pl-7 pr-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-green-300 focus:border-green-400 outline-none"
            />
          </div>
          {customAmount && !isValid && (
            <span className="text-xs text-red-500">Min ₹500</span>
          )}
        </div>

        {/* Summary & Pay */}
        <div className="bg-green-100/60 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-700">
                <span className="font-semibold">₹{isValid ? activeAmount.toLocaleString() : '—'}</span>
                {' → '}
                <span className="font-semibold text-green-700">{isValid ? minutesForAmount : 0} minutes</span>
              </p>
              <p className="text-xs text-gray-500 mt-0.5">@ ₹{rate} per minute</p>
            </div>
            <Button
              onClick={() => onTopup(activeAmount)}
              disabled={!isValid || loading}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              <Wallet className="w-4 h-4 mr-1" />
              {loading ? 'Processing...' : `Pay ₹${isValid ? totalPayable.toLocaleString() : '—'}`}
            </Button>
          </div>
          {isValid && (
            <div className="text-xs text-gray-600 border-t border-green-200 pt-2 flex justify-between">
              <span>Base: ₹{activeAmount.toLocaleString()} + GST (18%): ₹{gstAmount.toLocaleString()}</span>
              <span className="font-semibold">Total: ₹{totalPayable.toLocaleString()}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}