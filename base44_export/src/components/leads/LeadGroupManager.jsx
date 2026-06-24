import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Pencil, Trash2, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export default function LeadGroupManager({ open, onOpenChange, groups, clientId, onRefresh }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [editingGroup, setEditingGroup] = useState(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    if (editingGroup) {
      await base44.entities.LeadGroup.update(editingGroup.id, { name, description, color });
      toast.success('Group updated');
    } else {
      await base44.entities.LeadGroup.create({ client_id: clientId, name, description, color });
      toast.success('Group created');
    }
    setName(''); setDescription(''); setColor(COLORS[0]); setEditingGroup(null);
    onRefresh();
  };

  const handleEdit = (g) => {
    setEditingGroup(g);
    setName(g.name);
    setDescription(g.description || '');
    setColor(g.color || COLORS[0]);
  };

  const handleDelete = async (g) => {
    if (!confirm(`Delete group "${g.name}"? Leads in this group will be ungrouped.`)) return;
    await base44.entities.LeadGroup.delete(g.id);
    toast.success('Group deleted');
    onRefresh();
  };

  const cancelEdit = () => {
    setEditingGroup(null); setName(''); setDescription(''); setColor(COLORS[0]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5" /> Manage Lead Groups
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Existing groups */}
          {groups.length > 0 && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {groups.map(g => (
                <div key={g.id} className="flex items-center justify-between border rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: g.color || '#3b82f6' }} />
                    <div>
                      <p className="text-sm font-medium">{g.name}</p>
                      {g.description && <p className="text-xs text-gray-500">{g.description}</p>}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => handleEdit(g)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(g)}>
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Create / Edit form */}
          <div className="border-t pt-4 space-y-3">
            <p className="text-sm font-medium">{editingGroup ? 'Edit Group' : 'New Group'}</p>
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Tech Summit 2026" />
            </div>
            <div>
              <Label className="text-xs">Description (optional)</Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Leads from March event" />
            </div>
            <div>
              <Label className="text-xs">Color</Label>
              <div className="flex gap-2 mt-1">
                {COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full border-2 transition-all ${color === c ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              {editingGroup && (
                <Button size="sm" variant="outline" onClick={cancelEdit}>Cancel</Button>
              )}
              <Button size="sm" onClick={handleSave} disabled={!name.trim()} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-3.5 h-3.5 mr-1" /> {editingGroup ? 'Update' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}