import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Loader2, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { PLATFORM_ACTIONS } from './PLATFORM_ACTIONS';

export default function LinkActionsDialog({ template, open, onOpenChange, onSaved }) {
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) setSelected(template.linked_actions || []);
  }, [template]);

  if (!template) return null;

  // Group actions by category
  const grouped = PLATFORM_ACTIONS.reduce((acc, a) => {
    (acc[a.category] = acc[a.category] || []).push(a);
    return acc;
  }, {});

  const toggle = (val) => {
    setSelected(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await base44.entities.WhatsAppTemplate.update(template.id, { linked_actions: selected });
      toast.success('Use points updated');
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-cyan-600" /> Link Template to Platform Actions
          </DialogTitle>
          <DialogDescription>
            Select where this template should be sent automatically. When any selected event fires, this template will be sent to the recipient.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {Object.entries(grouped).map(([category, actions]) => (
            <div key={category}>
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">{category}</p>
              <div className="space-y-2">
                {actions.map(action => (
                  <label
                    key={action.value}
                    className="flex items-start gap-3 p-3 rounded-lg border hover:bg-gray-50 cursor-pointer"
                  >
                    <Checkbox
                      checked={selected.includes(action.value)}
                      onCheckedChange={() => toggle(action.value)}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">{action.label}</p>
                      <p className="text-xs text-gray-500">{action.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="flex justify-end gap-2 sticky bottom-0 bg-white py-3 border-t">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save Use Points
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}