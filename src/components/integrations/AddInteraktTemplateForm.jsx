import React, { useState } from 'react';
import { apiClient } from '@/api/apiClient';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

// Interakt has no API to list templates, so clients register an approved template
// once by its "code name". It's saved as APPROVED and instantly becomes selectable.
export default function AddInteraktTemplateForm({ clientId, onAdded }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    const codeName = name.trim();
    if (!codeName) { toast.error('Enter the template code name'); return; }
    setSaving(true);
    try {
      // Avoid duplicates for the same name+language
      const existing = await apiClient.WhatsAppTemplate.filter({ client_id: clientId, name: codeName });
      const dup = existing.find(t => t.language === language.trim());
      if (dup) {
        toast.info('That template is already added');
      } else {
        const created = await apiClient.WhatsAppTemplate.create({
          client_id: clientId,
          vendor: 'interakt',
          name: codeName,
          language: language.trim() || 'en',
          category: 'UTILITY',
          status: 'APPROVED',
          linked_actions: []
        });
        toast.success(`Template "${codeName}" added`);
        onAdded && onAdded(created);
      }
      setName('');
      setOpen(false);
    } catch (e) {
      toast.error(e.message || 'Failed to add template');
    }
    setSaving(false);
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5 text-xs">
        <Plus className="w-3.5 h-3.5" /> Add Interakt Template
      </Button>
    );
  }

  return (
    <div className="border border-blue-100 bg-blue-50 rounded-md p-3 space-y-3">
      <p className="text-xs text-gray-600">
        Open your approved template at <b>app.interakt.ai → Templates</b>. The code name is the part of the
        URL between <code className="bg-white px-1 rounded">/template/</code> and <code className="bg-white px-1 rounded">/view</code>.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Label className="text-xs text-gray-500">Template code name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. welcome_message" />
        </div>
        <div>
          <Label className="text-xs text-gray-500">Language</Label>
          <Input value={language} onChange={e => setLanguage(e.target.value)} placeholder="en" />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={handleAdd} disabled={saving} className="gap-1.5 text-xs">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} className="text-xs">Cancel</Button>
      </div>
    </div>
  );
}