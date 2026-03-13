import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

const COLORS = {
  neutral: '#3b82f6',
  interested: '#22c55e',
  not_interested: '#ef4444',
  not_answered: '#9ca3af',
  callback: '#eab308',
};

const LABELS = {
  neutral: 'Neutral',
  interested: 'Interested (Meeting/Demo)',
  not_interested: 'Not Interested',
  not_answered: 'Not Answered',
  callback: 'Callback',
};

export default function CampaignOutcomeChart({ outcomes }) {
  const data = Object.entries(outcomes || {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ name: LABELS[k] || k.replace('_', ' '), value: v, key: k }));

  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-gray-500 text-sm">
          No outcomes yet
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Outcomes</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
              {data.map(entry => (
                <Cell key={entry.key} fill={COLORS[entry.key] || '#6b7280'} />
              ))}
            </Pie>
            <Tooltip formatter={(v, name) => [`${v} leads`, name]} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}