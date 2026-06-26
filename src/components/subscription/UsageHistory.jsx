import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowDownLeft, ArrowUpRight, Phone, Plus, Gift, RotateCcw } from 'lucide-react';
import moment from 'moment';

const typeConfig = {
  call_charge: { icon: Phone, color: 'text-red-600', bg: 'bg-red-50', label: 'Call Charge' },
  topup: { icon: Plus, color: 'text-green-600', bg: 'bg-green-50', label: 'Top-up' },
  free_minutes: { icon: Gift, color: 'text-blue-600', bg: 'bg-blue-50', label: 'Free Minutes' },
  refund: { icon: RotateCcw, color: 'text-purple-600', bg: 'bg-purple-50', label: 'Refund' },
  trial_credit: { icon: Gift, color: 'text-cyan-600', bg: 'bg-cyan-50', label: 'Trial Credit' },
};

export default function UsageHistory({ clientId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (clientId) {
      apiClient.UsageLog.filter({ client_id: clientId }, '-created_at', 50)
        .then(setLogs)
        .finally(() => setLoading(false));
    }
  }, [clientId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 flex justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage & Recharge History</CardTitle>
      </CardHeader>
      <CardContent>
        {logs.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">No transactions yet</p>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => {
              const config = typeConfig[log.type] || typeConfig.call_charge;
              const Icon = config.icon;
              const isCredit = log.direction === 'credit';

              return (
                <div key={log.id} className="flex items-center justify-between py-3 px-3 rounded-lg hover:bg-gray-50 border-b last:border-0">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${config.bg}`}>
                      <Icon className={`w-4 h-4 ${config.color}`} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{log.description || config.label}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-500">
                          {moment(log.created_at).format('DD MMM, hh:mm A')}
                        </span>
                        {log.billable_minutes > 0 && (
                          <Badge variant="outline" className="text-[10px]">
                            {log.billable_minutes} min
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <p className={`text-sm font-semibold ${isCredit ? 'text-green-600' : 'text-red-600'}`}>
                        {isCredit ? '+' : ''}₹{Math.abs(log.amount).toLocaleString()}
                      </p>
                      {log.balance_after !== undefined && (
                        <p className="text-[10px] text-gray-400">Bal: ₹{log.balance_after.toLocaleString()}</p>
                      )}
                    </div>
                    {isCredit ? (
                      <ArrowDownLeft className="w-4 h-4 text-green-500" />
                    ) : (
                      <ArrowUpRight className="w-4 h-4 text-red-400" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}