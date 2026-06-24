import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, Phone, Clock, AlertTriangle } from 'lucide-react';
import moment from 'moment';

const tierColors = {
  hot: 'bg-red-500',
  warm: 'bg-orange-500',
  nurture: 'bg-blue-500',
  cold: 'bg-gray-400',
};

export default function CallbackCalendar({ callbacks, onCall }) {
  const [currentDate, setCurrentDate] = useState(moment());

  const startOfMonth = currentDate.clone().startOf('month');
  const endOfMonth = currentDate.clone().endOf('month');
  const startOfCalendar = startOfMonth.clone().startOf('week');
  const endOfCalendar = endOfMonth.clone().endOf('week');

  // Build weeks
  const weeks = [];
  const day = startOfCalendar.clone();
  while (day.isSameOrBefore(endOfCalendar)) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(day.clone());
      day.add(1, 'day');
    }
    weeks.push(week);
  }

  // Group callbacks by date
  const callbacksByDate = {};
  callbacks.forEach(cb => {
    const dt = cb.extracted?.callback_datetime;
    if (!dt) return;
    const key = moment(dt).format('YYYY-MM-DD');
    if (!callbacksByDate[key]) callbacksByDate[key] = [];
    callbacksByDate[key].push(cb);
  });

  const today = moment();

  return (
    <Card>
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="icon" onClick={() => setCurrentDate(prev => prev.clone().subtract(1, 'month'))}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <h3 className="font-semibold text-lg">{currentDate.format('MMMM YYYY')}</h3>
          <Button variant="ghost" size="icon" onClick={() => setCurrentDate(prev => prev.clone().add(1, 'month'))}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
            <div key={d} className="text-center text-xs font-medium text-gray-500 py-1">{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {weeks.flat().map((d, idx) => {
            const dateKey = d.format('YYYY-MM-DD');
            const dayCallbacks = callbacksByDate[dateKey] || [];
            const isCurrentMonth = d.month() === currentDate.month();
            const isToday = d.isSame(today, 'day');
            const isPast = d.isBefore(today, 'day');
            const hasOverdue = isPast && dayCallbacks.length > 0;

            return (
              <div
                key={idx}
                className={`min-h-[72px] rounded-lg border p-1 text-xs transition-colors ${
                  !isCurrentMonth ? 'bg-gray-50 text-gray-300 border-gray-100' :
                  isToday ? 'bg-blue-50 border-blue-300' :
                  hasOverdue ? 'bg-red-50 border-red-200' :
                  dayCallbacks.length > 0 ? 'bg-green-50 border-green-200' :
                  'border-gray-100'
                }`}
              >
                <div className={`font-medium mb-0.5 ${isToday ? 'text-blue-700' : isCurrentMonth ? 'text-gray-700' : ''}`}>
                  {d.date()}
                </div>
                {dayCallbacks.slice(0, 3).map((cb, i) => (
                  <button
                    key={i}
                    onClick={() => onCall(cb)}
                    className={`w-full text-left truncate rounded px-1 py-0.5 mb-0.5 text-[10px] leading-tight hover:opacity-80 transition-opacity ${
                      hasOverdue ? 'bg-red-200 text-red-800' : 'bg-blue-100 text-blue-800'
                    }`}
                    title={`${cb.lead_name} — ${cb.extracted?.reason || ''}`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-0.5 ${tierColors[cb.qualification_tier] || 'bg-gray-400'}`} />
                    {cb.lead_name}
                  </button>
                ))}
                {dayCallbacks.length > 3 && (
                  <div className="text-[10px] text-gray-500 px-1">+{dayCallbacks.length - 3} more</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Unscheduled callbacks notice */}
        {callbacks.filter(c => !c.extracted?.callback_datetime).length > 0 && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2 text-xs text-amber-700">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              <strong>{callbacks.filter(c => !c.extracted?.callback_datetime).length}</strong> callbacks have no scheduled date — check the list view to handle them.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}