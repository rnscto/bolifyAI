import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, Save, Loader2 } from 'lucide-react';

export default function ObjectionHandlers({ handlers = [], onSave, saving }) {
  const [items, setItems] = useState(
    handlers.length > 0 ? handlers : [
      { objection: 'Too expensive', response: 'One converted lead can pay for months of service. At ₹6,500/month, you need just one new customer to get ROI.' },
      { objection: 'Not sure about ROI', response: 'Your AI agent works 24/7 — qualifying leads, scheduling appointments, and following up automatically. Most clients see results in the first week.' },
      { objection: 'Need more time to decide', response: 'I understand. Your setup and data are preserved. Would you like me to extend your trial by a few days so you can see more results?' },
    ]
  );

  const addHandler = () => {
    setItems([...items, { objection: '', response: '' }]);
  };

  const removeHandler = (idx) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const updateHandler = (idx, field, value) => {
    const updated = [...items];
    updated[idx][field] = value;
    setItems(updated);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Objection Handlers</CardTitle>
        <Button variant="outline" size="sm" onClick={addHandler}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-500">
          Define how the AI agent should respond to common objections during retention calls.
        </p>
        {items.map((item, idx) => (
          <div key={idx} className="p-4 border rounded-lg space-y-3 bg-gray-50">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <Input
                  value={item.objection}
                  onChange={(e) => updateHandler(idx, 'objection', e.target.value)}
                  placeholder="Customer objection (e.g. 'Too expensive')"
                  className="bg-white font-medium"
                />
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeHandler(idx)}>
                <Trash2 className="w-4 h-4 text-red-500" />
              </Button>
            </div>
            <Textarea
              value={item.response}
              onChange={(e) => updateHandler(idx, 'response', e.target.value)}
              placeholder="How the AI agent should respond..."
              className="bg-white h-20"
            />
          </div>
        ))}

        <div className="flex justify-end pt-2">
          <Button onClick={() => onSave(items)} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Handlers
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}