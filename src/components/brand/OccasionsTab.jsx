import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { getOccasions, OCCASION_TYPES } from '@/lib/marketingCalendar';
import { CalendarDays, Plus, X, Pencil } from 'lucide-react';

export default function OccasionsTab({ form, setForm }) {
  const [filterType, setFilterType] = useState('all');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newOccasion, setNewOccasion] = useState({ name: '', date: '', type: 'custom', emoji: '🎯' });

  const builtInOccasions = getOccasions();
  const customOccasions = (form.custom_occasions || []).map(o => ({ ...o, isCustom: true }));
  const allOccasions = [...builtInOccasions, ...customOccasions];
  const enabled = form.enabled_occasions || [];

  const toggle = (id) => {
    if (enabled.includes(id)) {
      setForm(f => ({ ...f, enabled_occasions: enabled.filter(x => x !== id) }));
    } else {
      setForm(f => ({ ...f, enabled_occasions: [...enabled, id] }));
    }
  };

  const selectAll = () => {
    const filtered = filterType === 'all' ? allOccasions : allOccasions.filter(o => o.type === filterType);
    const allIds = filtered.map(o => o.id);
    setForm(f => ({ ...f, enabled_occasions: [...new Set([...enabled, ...allIds])] }));
  };

  const deselectAll = () => {
    const filtered = filterType === 'all' ? allOccasions : allOccasions.filter(o => o.type === filterType);
    const removeIds = new Set(filtered.map(o => o.id));
    setForm(f => ({ ...f, enabled_occasions: enabled.filter(x => !removeIds.has(x)) }));
  };

  const addCustomOccasion = () => {
    if (!newOccasion.name || !newOccasion.date) return;
    const id = 'custom_' + newOccasion.name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
    // date comes as "2026-03-20" → store as "03-20"
    const mmdd = newOccasion.date.substring(5);
    const custom = { id, name: newOccasion.name, date: mmdd, type: newOccasion.type || 'custom', emoji: newOccasion.emoji || '🎯' };
    setForm(f => ({
      ...f,
      custom_occasions: [...(f.custom_occasions || []), custom],
      enabled_occasions: [...(f.enabled_occasions || []), id],
    }));
    setNewOccasion({ name: '', date: '', type: 'custom', emoji: '🎯' });
    setShowAddDialog(false);
  };

  const removeCustomOccasion = (id) => {
    setForm(f => ({
      ...f,
      custom_occasions: (f.custom_occasions || []).filter(o => o.id !== id),
      enabled_occasions: (f.enabled_occasions || []).filter(x => x !== id),
    }));
  };

  const filtered = filterType === 'all'
    ? allOccasions
    : allOccasions.filter(o => o.type === filterType);

  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const grouped = {};
  filtered.forEach(o => {
    const m = parseInt(o.date.split('-')[0]) - 1;
    if (!grouped[m]) grouped[m] = [];
    grouped[m].push(o);
  });

  const allTypes = { ...OCCASION_TYPES, custom: { label: 'Custom', color: 'bg-gray-100 text-gray-800 border-gray-200' } };

  const emojiOptions = ['🎯','🎉','🎊','🎁','💼','🏢','📣','🎂','🏆','⭐','🌟','💡','🔔','📅','🤝','🎈','🛍️','💰','🧧','🪅'];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-lg">
            <span className="flex items-center gap-2"><CalendarDays className="w-5 h-5 text-orange-600" /> Marketing Calendar</span>
            <Button size="sm" onClick={() => setShowAddDialog(true)} className="gap-1">
              <Plus className="w-4 h-4" /> Add Custom Day
            </Button>
          </CardTitle>
          <CardDescription>Select occasions for auto-posts. Missing a day? Add your own!</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Button size="sm" variant={filterType === 'all' ? 'default' : 'outline'} onClick={() => setFilterType('all')}>All</Button>
            {Object.entries(allTypes).map(([key, val]) => (
              <Button key={key} size="sm" variant={filterType === key ? 'default' : 'outline'} onClick={() => setFilterType(key)}>{val.label}</Button>
            ))}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={selectAll}>Select All</Button>
              <Button size="sm" variant="ghost" onClick={deselectAll}>Deselect All</Button>
            </div>
          </div>

          <div className="text-sm text-gray-500 mb-4">{enabled.length} occasions selected · {customOccasions.length} custom added</div>

          {/* Month groups */}
          <div className="space-y-4">
            {Object.entries(grouped).sort(([a], [b]) => a - b).map(([monthIdx, items]) => (
              <div key={monthIdx}>
                <h4 className="font-semibold text-sm text-gray-700 mb-2 sticky top-0 bg-white py-1">{months[monthIdx]}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {items.map(o => {
                    const isEnabled = enabled.includes(o.id);
                    const typeInfo = allTypes[o.type] || allTypes.custom;
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
                        {o.isCustom && (
                          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeCustomOccasion(o.id); }} className="text-gray-400 hover:text-red-500 p-1"><X className="w-3.5 h-3.5" /></button>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Add Custom Occasion Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Custom Occasion</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Occasion Name *</Label>
              <Input placeholder="e.g., Company Anniversary, Product Launch Day..." value={newOccasion.name} onChange={e => setNewOccasion(o => ({ ...o, name: e.target.value }))} />
            </div>
            <div>
              <Label>Date *</Label>
              <Input type="date" value={newOccasion.date} onChange={e => setNewOccasion(o => ({ ...o, date: e.target.value }))} />
            </div>
            <div>
              <Label>Category</Label>
              <Select value={newOccasion.type} onValueChange={v => setNewOccasion(o => ({ ...o, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">Custom</SelectItem>
                  <SelectItem value="indian_festival">Indian Festival</SelectItem>
                  <SelectItem value="national">National Day</SelectItem>
                  <SelectItem value="international">International</SelectItem>
                  <SelectItem value="awareness">Awareness Day</SelectItem>
                  <SelectItem value="shopping">Shopping Event</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Emoji</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {emojiOptions.map(e => (
                  <button key={e} onClick={() => setNewOccasion(o => ({ ...o, emoji: e }))} className={`text-xl p-1 rounded ${newOccasion.emoji === e ? 'bg-blue-100 ring-2 ring-blue-400' : 'hover:bg-gray-100'}`}>{e}</button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button onClick={addCustomOccasion} disabled={!newOccasion.name || !newOccasion.date}>Add Occasion</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}