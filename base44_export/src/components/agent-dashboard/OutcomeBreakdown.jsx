import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';

const OUTCOME_COLORS = {
  interested: '#22c55e',
  not_interested: '#ef4444',
  callback: '#f59e0b',
  no_answer: '#94a3b8',
  converted: '#8b5cf6',
  contacted: '#3b82f6',
  do_not_call: '#6b7280',
};

export default function OutcomeBreakdown({ campaignLeads }) {
  const outcomeCounts = {};
  campaignLeads.forEach(cl => {
    if (cl.outcome) {
      outcomeCounts[cl.outcome] = (outcomeCounts[cl.outcome] || 0) + 1;
    }
  });

  const data = Object.entries(outcomeCounts).map(([name, value]) => ({
    name: name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    value,
    fill: OUTCOME_COLORS[name] || '#94a3b8'
  }));

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Outcome Breakdown</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-center h-48 text-gray-400 text-sm">
          No outcomes recorded yet
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Outcome Breakdown</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40} paddingAngle={3}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            </Pie>
            <Tooltip />
            <Legend iconSize={10} wrapperStyle={{ fontSize: '12px' }} />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}