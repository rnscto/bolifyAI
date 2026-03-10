import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Phone, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';

export default function CallbackStats({ callbacks }) {
  const now = new Date();
  const overdue = callbacks.filter(c => {
    if (!c.extracted?.callback_datetime) return false;
    return new Date(c.extracted.callback_datetime) < now;
  }).length;

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const dueToday = callbacks.filter(c => {
    if (!c.extracted?.callback_datetime) return false;
    const d = new Date(c.extracted.callback_datetime);
    return d >= now && d <= todayEnd;
  }).length;

  const highUrgency = callbacks.filter(c => c.extracted?.urgency === 'high').length;
  const unscheduled = callbacks.filter(c => !c.extracted?.callback_datetime).length;

  const stats = [
    { label: 'Total Callbacks', value: callbacks.length, icon: Phone, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'Due Today', value: dueToday, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
    { label: 'Overdue', value: overdue, icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-50' },
    { label: 'Unscheduled', value: unscheduled, icon: CheckCircle2, color: 'text-gray-600', bg: 'bg-gray-50' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((s) => {
        const Icon = s.icon;
        return (
          <Card key={s.label}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`p-2.5 rounded-lg ${s.bg}`}>
                <Icon className={`w-5 h-5 ${s.color}`} />
              </div>
              <div>
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}