import React from 'react';
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';

export default function CalendarHeader({ currentDate, view, onViewChange, onNavigate }) {
  const monthYear = currentDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const weekStart = new Date(currentDate);
  weekStart.setDate(currentDate.getDate() - currentDate.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const weekLabel = `${weekStart.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <CalendarIcon className="w-5 h-5 text-blue-600" />
        <h2 className="text-lg font-semibold">{view === 'month' ? monthYear : weekLabel}</h2>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" onClick={() => onNavigate(-1)}><ChevronLeft className="w-4 h-4" /></Button>
          <Button size="sm" variant="outline" onClick={() => onNavigate(0)}>Today</Button>
          <Button size="icon" variant="ghost" onClick={() => onNavigate(1)}><ChevronRight className="w-4 h-4" /></Button>
        </div>
      </div>
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
        <Button size="sm" variant={view === 'week' ? 'default' : 'ghost'} onClick={() => onViewChange('week')}>Week</Button>
        <Button size="sm" variant={view === 'month' ? 'default' : 'ghost'} onClick={() => onViewChange('month')}>Month</Button>
      </div>
    </div>
  );
}