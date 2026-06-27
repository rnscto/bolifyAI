import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Phone, TrendingUp, Users, Clock } from 'lucide-react';

export default function AgentPerformanceCards({ stats = {} }) {
  const {
    totalCalls = 0,
    completedCalls = 0,
    totalDuration = 0,
    totalLeads = 0,
    interestedLeads = 0,
    totalOutcomes = 0,
    avgLeadScore = 0
  } = stats;

  const avgDuration = completedCalls > 0 ? Math.round(totalDuration / completedCalls) : 0;
  const conversionRate = totalOutcomes > 0 ? Math.round((interestedLeads / totalOutcomes) * 100) : 0;

  const displayStats = [
    { label: 'Total Calls', value: totalCalls, sub: `${completedCalls} completed`, icon: Phone, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'Conversion Rate', value: `${conversionRate}%`, sub: `${interestedLeads} of ${totalOutcomes} leads`, icon: TrendingUp, color: 'text-green-600', bg: 'bg-green-50' },
    { label: 'Avg Lead Score', value: avgLeadScore, sub: `${totalLeads} total leads`, icon: Users, color: 'text-purple-600', bg: 'bg-purple-50' },
    { label: 'Avg Call Duration', value: `${Math.floor(avgDuration / 60)}m ${avgDuration % 60}s`, sub: `${completedCalls} calls`, icon: Clock, color: 'text-orange-600', bg: 'bg-orange-50' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {displayStats.map(s => {
        const Icon = s.icon;
        return (
          <Card key={s.label}>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{s.label}</p>
                <div className={`p-2 rounded-lg ${s.bg}`}>
                  <Icon className={`w-4 h-4 ${s.color}`} />
                </div>
              </div>
              <p className="text-2xl font-bold text-gray-900">{s.value}</p>
              <p className="text-xs text-gray-400 mt-1">{s.sub}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}