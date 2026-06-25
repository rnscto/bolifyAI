import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { BarChart3 } from 'lucide-react';

const CATEGORY_COLORS = {
  family: '#22c55e',
  business: '#3b82f6',
  promotional: '#eab308',
  spam: '#ef4444',
  unknown: '#9ca3af'
};

function classifyCall(call) {
  const s = (call.conversation_summary || '').toLowerCase();
  if (s.includes('spam') || s.includes('telemarketing') || s.includes('fraud')) return 'spam';
  if (s.includes('promotional') || s.includes('offer') || s.includes('discount')) return 'promotional';
  if (s.includes('family') || s.includes('personal') || s.includes('friend')) return 'family';
  if (s.includes('business') || s.includes('meeting') || s.includes('work') || s.includes('office')) return 'business';
  return 'unknown';
}

export default function PersonalAnalytics({ calls }) {
  const { dailyData, categoryData } = useMemo(() => {
    // Last 7 days call volume
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const label = d.toLocaleDateString('en-IN', { weekday: 'short' });
      const dayCalls = calls.filter(c => c.created_at?.startsWith(key));
      const daySpam = dayCalls.filter(c => classifyCall(c) === 'spam').length;
      days.push({ day: label, total: dayCalls.length, spam: daySpam, legit: dayCalls.length - daySpam });
    }

    // Category distribution
    const cats = { family: 0, business: 0, promotional: 0, spam: 0, unknown: 0 };
    calls.forEach(c => { cats[classifyCall(c)]++; });
    const catArr = Object.entries(cats)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value, fill: CATEGORY_COLORS[name] }));

    return { dailyData: days, categoryData: catArr };
  }, [calls]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Calls This Week
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dailyData.every(d => d.total === 0) ? (
            <div className="text-center py-8 text-gray-400 text-sm">No call data yet this week</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dailyData}>
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="legit" stackId="a" fill="#3b82f6" name="Legitimate" radius={[0, 0, 0, 0]} />
                <Bar dataKey="spam" stackId="a" fill="#ef4444" name="Spam" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Call Categories</CardTitle>
        </CardHeader>
        <CardContent>
          {categoryData.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">No categorized calls yet</div>
          ) : (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width={140} height={140}>
                <PieChart>
                  <Pie data={categoryData} dataKey="value" cx="50%" cy="50%" outerRadius={60} innerRadius={35}>
                    {categoryData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2">
                {categoryData.map((cat) => (
                  <div key={cat.name} className="flex items-center gap-2 text-sm">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: cat.fill }} />
                    <span className="text-gray-700">{cat.name}</span>
                    <span className="text-gray-400 ml-auto">{cat.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}