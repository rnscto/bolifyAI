import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Loader2, Plus, FileText, Eye, Pencil, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export default function ClientAgreementTemplateEditor() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editTemplate, setEditTemplate] = useState(null);
  const [showEditor, setShowEditor] = useState(false);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: '', version: '1.0', body_html: '',
    company_signatory_name: 'Guddu Kumar Yadav',
    company_signatory_designation: 'Director',
    status: 'draft'
  });

  useEffect(() => { loadTemplates(); }, []);

  const loadTemplates = async () => {
    const t = await base44.entities.ClientAgreementTemplate.list('-created_at');
    setTemplates(t);
    setLoading(false);
  };

  const handleSave = async () => {
    if (!form.title || !form.body_html) { toast.error('Title and body are required'); return; }
    setSaving(true);
    if (editTemplate) {
      await base44.entities.ClientAgreementTemplate.update(editTemplate.id, form);
      toast.success('Template updated');
    } else {
      await base44.entities.ClientAgreementTemplate.create(form);
      toast.success('Template created');
    }
    setShowEditor(false);
    setEditTemplate(null);
    setSaving(false);
    loadTemplates();
  };

  const handleSetActive = async (tmpl) => {
    for (const t of templates) {
      if (t.id !== tmpl.id && t.status === 'active') {
        await base44.entities.ClientAgreementTemplate.update(t.id, { status: 'archived', is_active: false });
      }
    }
    await base44.entities.ClientAgreementTemplate.update(tmpl.id, { status: 'active', is_active: true });
    toast.success('Template activated');
    loadTemplates();
  };

  const openEdit = (tmpl) => {
    setEditTemplate(tmpl);
    setForm({
      title: tmpl.title, version: tmpl.version, body_html: tmpl.body_html,
      company_signatory_name: tmpl.company_signatory_name || 'Guddu Kumar Yadav',
      company_signatory_designation: tmpl.company_signatory_designation || 'Director',
      status: tmpl.status
    });
    setShowEditor(true);
  };

  const openNew = () => {
    setEditTemplate(null);
    setForm({ title: '', version: '1.0', body_html: '', company_signatory_name: 'Guddu Kumar Yadav', company_signatory_designation: 'Director', status: 'draft' });
    setShowEditor(true);
  };

  const previewHtml = (tmpl) => {
    let html = tmpl.body_html.replace(/\{\{[^}]+\}\}/g, (match) => {
      const placeholders = {
        '{{agreement_number}}': 'VAANI-CSA-2026-001',
        '{{effective_date_formatted}}': '18th March, 2026',
        '{{client_name}}': 'Sample Company Pvt Ltd',
        '{{signatory_name}}': 'John Doe',
        '{{signatory_email}}': 'john@sample.com',
        '{{client_address}}': 'Mumbai, India',
        '{{company_signatory_name}}': tmpl.company_signatory_name,
        '{{company_signatory_designation}}': tmpl.company_signatory_designation,
        '{{signed_date_formatted}}': '18th March, 2026',
        '{{client_signature}}': '<em>Sample Signature</em>',
        '{{signed_timestamp}}': '18 March 2026, 3:00:00 pm IST',
        '{{signed_ip}}': '192.168.1.1'
      };
      return placeholders[match] || `<span style="background:#fef3c7;padding:2px 4px;">${match}</span>`;
    });
    setPreview(html);
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Client Agreement Templates</h3>
        <Button size="sm" onClick={openNew}><Plus className="w-4 h-4 mr-1" /> New Template</Button>
      </div>

      {templates.map(t => (
        <Card key={t.id}>
          <CardContent className="p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <FileText className="w-5 h-5 text-blue-600" />
              <div>
                <p className="font-medium text-sm">{t.title}</p>
                <p className="text-xs text-gray-400">v{t.version} • {t.company_signatory_name}, {t.company_signatory_designation}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={t.status === 'active' ? 'bg-green-100 text-green-800' : t.status === 'draft' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600'}>{t.status}</Badge>
              <Button size="sm" variant="ghost" onClick={() => previewHtml(t)}><Eye className="w-4 h-4" /></Button>
              <Button size="sm" variant="ghost" onClick={() => openEdit(t)}><Pencil className="w-4 h-4" /></Button>
              {t.status !== 'active' && (
                <Button size="sm" variant="outline" className="text-green-600 text-xs h-7" onClick={() => handleSetActive(t)}>
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Set Active
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}

      {templates.length === 0 && (
        <Card><CardContent className="py-8 text-center text-gray-400"><p>No client agreement templates yet. Create one to enable agreement signing during onboarding.</p></CardContent></Card>
      )}

      <Dialog open={showEditor} onOpenChange={setShowEditor}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editTemplate ? 'Edit Template' : 'New Client Agreement Template'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Title</Label><Input value={form.title} onChange={e => setForm({...form, title: e.target.value})} /></div>
              <div><Label>Version</Label><Input value={form.version} onChange={e => setForm({...form, version: e.target.value})} /></div>
              <div><Label>Company Signatory</Label><Input value={form.company_signatory_name} onChange={e => setForm({...form, company_signatory_name: e.target.value})} /></div>
              <div><Label>Designation</Label><Input value={form.company_signatory_designation} onChange={e => setForm({...form, company_signatory_designation: e.target.value})} /></div>
            </div>
            <div>
              <Label>Agreement Body (HTML)</Label>
              <p className="text-xs text-gray-400 mb-1">
                Placeholders: {'{{client_name}}, {{signatory_name}}, {{signatory_email}}, {{client_address}}, {{agreement_number}}, {{effective_date_formatted}}, {{company_signatory_name}}, {{company_signatory_designation}}, {{signed_date_formatted}}, {{client_signature}}, {{signed_timestamp}}, {{signed_ip}}'}
              </p>
              <textarea value={form.body_html} onChange={e => setForm({...form, body_html: e.target.value})} className="w-full h-80 border rounded-md p-3 text-xs font-mono" placeholder="Paste HTML template..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditor(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Template'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!preview} onOpenChange={() => setPreview(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Template Preview</DialogTitle></DialogHeader>
          <div dangerouslySetInnerHTML={{ __html: preview }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}