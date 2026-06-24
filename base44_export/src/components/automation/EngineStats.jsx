import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Phone, Mail, AlertTriangle, Clock, CheckCircle2, XCircle } from 'lucide-react';

export default function EngineStats({ activities }) {
  const scheduled = activities.filter(a => a.status === 'scheduled');
  const completed = activities.filter(a => a.status === 'completed');
  const overdue = activities.filter(a => a.status === 'overdue');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dueToday = scheduled.filter(a => {
    const d = new Date(a.scheduled_date);
    return d >= today && d < tomorrow;
  });

  const callsToday = completed.filter(a => {
    const d = new Date(a.completed_date || a.updated_date);
    return d >= today && (a.type === 'call' || a.type === 'followup');
  });

  const emailsToday = completed.filter(a => {
    const d = new Date(a.completed_date || a.updated_date);
    return d >= today && a.type === 'email';
  });

  const humanActions = scheduled.filter(a =>
    ['appointment', 'demo', 'visit', 'meeting', 'booking', 'task'].includes(a.type)
  );

  const stats = [
    { label: 'Due Today', value: dueToday.length, icon: Clock, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'Calls Made Today', value: callsToday.length, icon: Phone, color: 'text-green-600', bg: 'bg-green-50' },
    { label: 'Emails Sent Today', value: emailsToday.length, icon: Mail, color: 'text-purple-600', bg: 'bg-purple-50' },
    { label: 'Human Action Needed', value: humanActions.length, icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-50' },
    { label: 'Overdue', value: overdue.length, icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
    { label: 'Completed', value: completed.length, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {stats.map((s, i) => {
        const Icon = s.icon;
        return (
          <Card key={i} className="border-0 shadow-sm">
            <CardContent className="p-4 flex flex-col items-center text-center gap-2">
              <div className={`w-10 h-10 rounded-lg ${s.bg} flex items-center justify-center`}>
                <Icon className={`w-5 h-5 ${s.color}`} />
              </div>
              <div className="text-2xl font-bold text-gray-900">{s.value}</div>
              <div className="text-xs text-gray-500">{s.label}</div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}