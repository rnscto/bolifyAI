import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldCheck, PhoneIncoming, PhoneOff, Phone } from 'lucide-react';

export default function CallSummaryCards({ calls }) {
  const today = new Date().toISOString().split('T')[0];
  const todayCalls = calls.filter(c => c.created_date?.startsWith(today));

  const totalScreened = calls.filter(c => c.direction === 'inbound').length;
  const spamBlocked = calls.filter(c => 
    c.conversation_summary?.toLowerCase().includes('spam') ||
    c.conversation_summary?.toLowerCase().includes('telemarketing')
  ).length;
  const answered = calls.filter(c => c.status === 'completed' && c.duration > 0).length;
  const todayCount = todayCalls.length;

  const cards = [
    {
      title: 'Total Screened',
      value: totalScreened,
      subtitle: 'All incoming calls',
      icon: ShieldCheck,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50'
    },
    {
      title: 'Spam Blocked',
      value: spamBlocked,
      subtitle: 'Spam & telemarketing',
      icon: PhoneOff,
      color: 'text-red-600',
      bgColor: 'bg-red-50'
    },
    {
      title: 'Answered',
      value: answered,
      subtitle: 'Connected calls',
      icon: PhoneIncoming,
      color: 'text-green-600',
      bgColor: 'bg-green-50'
    },
    {
      title: 'Today',
      value: todayCount,
      subtitle: 'Calls today',
      icon: Phone,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50'
    }
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">{card.title}</CardTitle>
              <div className={`p-2 rounded-lg ${card.bgColor}`}>
                <Icon className={`w-5 h-5 ${card.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-gray-900">{card.value}</div>
              <p className="text-xs text-gray-500 mt-1">{card.subtitle}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}