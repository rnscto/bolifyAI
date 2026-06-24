import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, UserCircle } from 'lucide-react';

/**
 * One-time prompt asking the user to set their display name.
 * Shown automatically when display_name is empty (e.g. users who signed up via Google
 * and got an auto-generated full_name like the email's first part).
 */
export default function SetDisplayNameDialog({ open, onClose, defaultValue = '' }) {
  const [name, setName] = useState(defaultValue);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await base44.auth.updateMe({ display_name: trimmed });
      onClose(trimmed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => { /* block manual close — user must set a name */ }}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="mx-auto w-12 h-12 rounded-full bg-cyan-50 flex items-center justify-center mb-2">
            <UserCircle className="w-7 h-7 text-cyan-600" />
          </div>
          <DialogTitle className="text-center">What should we call you?</DialogTitle>
          <DialogDescription className="text-center">
            Please set the name you'd like to be displayed across your dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Label htmlFor="display_name">Your Name</Label>
          <Input
            id="display_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Neeraj Sharma"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          />
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={saving || !name.trim()} className="w-full bg-cyan-600 hover:bg-cyan-700">
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Save & Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}