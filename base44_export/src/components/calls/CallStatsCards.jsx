import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { PhoneCall, PhoneIncoming, PhoneOutgoing } from 'lucide-react';

export default function CallStatsCards({ calls }) {
  const outbound = calls.filter(c => c.direction === 'outbound').length;
  const inbound = calls.filter(c => c.direction === 'inbound').length;
  const completed = calls.filter(c => c.status === 'completed').length;

  const cards = [
    { label: 'Total Calls', value: calls.length, icon: PhoneCall, color: 'text-blue-600' },
    { label: 'Outbound', value: outbound, icon: PhoneOutgoing, color: 'text-green-600' },
    { label: 'Inbound', value: inbound, icon: PhoneIncoming, color: 'text-purple-600' },
    { label: 'Completed', value: completed, icon: PhoneCall, color: 'text-orange-600' },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <Card key={c.label}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Icon className={`w-8 h-8 ${c.color}`} />
                <div>
                  <p className="text-2xl font-bold">{c.value}</p>
                  <p className="text-sm text-gray-600">{c.label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}