import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getOccasions, OCCASION_TYPES } from '@/lib/marketingCalendar';
import { CalendarDays, Check } from 'lucide-react';

export default function OccasionsTab({ form, setForm }) {
  const [filterType, setFilterType] = useState('all');
  const occasions = getOccasions();
  const enabled = form.enabled_occasions || [];

  const toggle = (id) => {
    if (enabled.includes(id)) {
      setForm(f => ({ ...f, enabled_occasions: enabled.filter(x => x !== id) }));
    } else {
      setForm(f => ({ ...f, enabled_occasions: [...enabled, id] }));
    }
  };

  const selectAll = () => {
    const filtered = filterType === 'all' ? occasions : occasions.filter(o => o.type === filterType);
    const allIds = filtered.map(o => o.id);
    const newEnabled = [...new Set([...enabled, ...allIds])];
    setForm(f => ({ ...f, enabled_occasions: newEnabled }));
  };

  const deselectAll = () => {
    const filtered = filterType === 'all' ? occasions : occasions.filter(o => o.type === filterType);
    const removeIds = new Set(filtered.map(o => o.id));
    setForm(f => ({ ...f, enabled_occasions: enabled.filter(x => !removeIds.has(x)) }));
  };

  const filtered = filterType === 'all' ? occasions : occasions.filter(o => o.type === filterType);

  // Group by month
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const grouped = {};
  filtered.forEach(o => {
    const m = parseInt(o.date.split('-')[0]) - 1;
    if (!grouped[m]) grouped[m] = [];
    grouped[m].push(o);
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><CalendarDays className="w-5 h-5 text-orange-600" /> Marketing Calendar</CardTitle>
          <CardDescription>Select festivals, national days & occasions — AI will auto-create themed posts for these dates</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Button size="sm" variant={filterType === 'all' ? 'default' : 'outline'} onClick={() => setFilterType('all')}>All</Button>
            {Object.entries(OCCASION_TYPES).map(([key, val]) => (
              <Button key={key} size="sm" variant={filterType === key ? 'default' : 'outline'} onClick={() => setFilterType(key)}>{val.label}</Button>
            ))}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={selectAll}>Select All</Button>
              <Button size="sm" variant="ghost" onClick={deselectAll}>Deselect All</Button>
            </div>
          </div>

          <div className="text-sm text-gray-500 mb-4">{enabled.length} occasions selected</div>

          {/* Month groups */}
          <div className="space-y-4">
            {Object.entries(grouped).sort(([a], [b]) => a - b).map(([monthIdx, items]) => (
              <div key={monthIdx}>
                <h4 className="font-semibold text-sm text-gray-700 mb-2 sticky top-0 bg-white py-1">{months[monthIdx]}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {items.map(o => {
                    const isEnabled = enabled.includes(o.id);
                    const typeInfo = OCCASION_TYPES[o.type] || {};
                    return (
                      <label key={o.id} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${isEnabled ? 'bg-blue-50 border-blue-300' : 'hover:bg-gray-50 border-gray-200'}`}>
                        <Checkbox checked={isEnabled} onCheckedChange={() => toggle(o.id)} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-base">{o.emoji}</span>
                            <span className="text-sm font-medium truncate">{o.name}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-gray-500">{o.date.split('-').reverse().join('/')}</span>
                            <Badge variant="outline" className={`text-xs py-0 ${typeInfo.color || ''}`}>{typeInfo.label}</Badge>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}