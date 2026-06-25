import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Megaphone, Plus, Trash2, Pencil, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import AnnouncementMarquee from '../components/AnnouncementMarquee';

const EMPTY = {
  message: '',
  severity: 'info',
  audience: 'all',
  is_active: true,
  link_url: '',
  starts_at: '',
  ends_at: '',
};

export default function AdminAnnouncements() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    setLoading(true);
    try {
      const list = await base44.entities.PlatformAnnouncement.list('-created_at', 100);
      setItems(list || []);
    } catch (e) {
      toast.error('Failed to load announcements');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openNew = () => { setEditing(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (item) => {
    setEditing(item);
    setForm({
      message: item.message || '',
      severity: item.severity || 'info',
      audience: item.audience || 'all',
      is_active: item.is_active !== false,
      link_url: item.link_url || '',
      starts_at: item.starts_at ? item.starts_at.slice(0, 16) : '',
      ends_at: item.ends_at ? item.ends_at.slice(0, 16) : '',
    });
    setDialogOpen(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.message.trim()) { toast.error('Message is required'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : undefined,
        ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : undefined,
      };
      if (editing) {
        await base44.entities.PlatformAnnouncement.update(editing.id, payload);
        toast.success('Announcement updated');
      } else {
        await base44.entities.PlatformAnnouncement.create(payload);
        toast.success('Announcement published');
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error('Failed to save: ' + (e.message || 'unknown'));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (item) => {
    try {
      await base44.entities.PlatformAnnouncement.update(item.id, { is_active: !item.is_active });
      load();
    } catch { toast.error('Failed to toggle'); }
  };

  const remove = async (item) => {
    if (!confirm('Delete this announcement?')) return;
    try {
      await base44.entities.PlatformAnnouncement.delete(item.id);
      toast.success('Deleted');
      load();
    } catch { toast.error('Failed to delete'); }
  };

  const sevColors = {
    info: 'bg-blue-100 text-blue-800',
    warning: 'bg-amber-100 text-amber-800',
    critical: 'bg-red-100 text-red-800',
    success: 'bg-emerald-100 text-emerald-800',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <Megaphone className="w-7 h-7 text-blue-600" /> Announcements
          </h1>
          <p className="text-gray-600 mt-1">Post downtime, maintenance windows, and platform updates as a running marquee.</p>
        </div>
        <Button onClick={openNew} className="bg-blue-600 hover:bg-blue-700">
          <Plus className="w-4 h-4 mr-2" /> New Announcement
        </Button>
      </div>

      {/* Live preview */}
      <Card>
        <CardHeader><CardTitle className="text-base">Live Preview (what users see)</CardTitle></CardHeader>
        <CardContent className="p-0 border-t">
          <AnnouncementMarquee audience="clients" />
          {items.filter(i => i.is_active).length === 0 && (
            <p className="px-4 py-3 text-sm text-gray-500">No active announcements right now.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">All Announcements</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
          ) : items.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">No announcements yet. Click "New Announcement" to add one.</p>
          ) : (
            <div className="space-y-2">
              {items.map(item => (
                <div key={item.id} className="flex items-start gap-3 p-3 border rounded-lg hover:bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <Badge className={sevColors[item.severity] || sevColors.info}>{item.severity || 'info'}</Badge>
                      <Badge variant="outline">{item.audience || 'all'}</Badge>
                      {!item.is_active && <Badge className="bg-gray-200 text-gray-700">paused</Badge>}
                      {item.starts_at && <span className="text-xs text-gray-500">from {new Date(item.starts_at).toLocaleString()}</span>}
                      {item.ends_at && <span className="text-xs text-gray-500">until {new Date(item.ends_at).toLocaleString()}</span>}
                    </div>
                    <p className="text-sm text-gray-900 break-words">{item.message}</p>
                    {item.link_url && <a href={item.link_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">{item.link_url}</a>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={!!item.is_active} onCheckedChange={() => toggleActive(item)} />
                    <Button size="sm" variant="ghost" onClick={() => openEdit(item)}><Pencil className="w-4 h-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(item)}><Trash2 className="w-4 h-4 text-red-600" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Announcement' : 'New Announcement'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label>Message *</Label>
              <Textarea
                value={form.message}
                onChange={e => setForm({ ...form, message: e.target.value })}
                placeholder="e.g. Scheduled maintenance on May 12, 2026 from 11 PM to 1 AM IST."
                className="min-h-[80px]"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Severity</Label>
                <Select value={form.severity} onValueChange={v => setForm({ ...form, severity: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">Info (blue)</SelectItem>
                    <SelectItem value="success">Success (green)</SelectItem>
                    <SelectItem value="warning">Warning (amber)</SelectItem>
                    <SelectItem value="critical">Critical (red)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Audience</Label>
                <Select value={form.audience} onValueChange={v => setForm({ ...form, audience: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Everyone</SelectItem>
                    <SelectItem value="clients">Clients only</SelectItem>
                    <SelectItem value="admins">Admins only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Link (optional)</Label>
              <Input value={form.link_url} onChange={e => setForm({ ...form, link_url: e.target.value })} placeholder="https://..." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Start (optional)</Label>
                <Input type="datetime-local" value={form.starts_at} onChange={e => setForm({ ...form, starts_at: e.target.value })} />
              </div>
              <div>
                <Label>End (optional)</Label>
                <Input type="datetime-local" value={form.ends_at} onChange={e => setForm({ ...form, ends_at: e.target.value })} />
              </div>
            </div>
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-gray-500">Inactive announcements are hidden from users.</p>
              </div>
              <Switch checked={form.is_active} onCheckedChange={v => setForm({ ...form, is_active: v })} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving} className="bg-blue-600 hover:bg-blue-700">
                {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</> : (editing ? 'Update' : 'Publish')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}