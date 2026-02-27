import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Plus, FileText, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import RCSTemplateEditor from '../components/integrations/RCSTemplateEditor';
import RCSTemplateList from '../components/integrations/RCSTemplateList';
import RCSTemplateSender from '../components/integrations/RCSTemplateSender';

export default function ClientRCSTemplates() {
  const [client, setClient] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [sendingTemplate, setSendingTemplate] = useState(null);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length > 0) {
      setClient(clients[0]);
      const tpls = await base44.entities.RCSTemplate.filter({ client_id: clients[0].id }, '-created_date');
      setTemplates(tpls);
    }
    setLoading(false);
  };

  const handleSave = async (data) => {
    if (editingTemplate?.id) {
      await base44.entities.RCSTemplate.update(editingTemplate.id, data);
      toast.success('Template updated');
    } else {
      await base44.entities.RCSTemplate.create({ ...data, client_id: client.id });
      toast.success('Template created');
    }
    setShowEditor(false);
    setEditingTemplate(null);
    loadData();
  };

  const handleEdit = (t) => { setEditingTemplate(t); setShowEditor(true); };

  const handleDelete = async (t) => {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    await base44.entities.RCSTemplate.delete(t.id);
    toast.success('Template deleted');
    loadData();
  };

  const handleDuplicate = async (t) => {
    await base44.entities.RCSTemplate.create({
      client_id: client.id,
      name: t.name + ' (Copy)',
      category: t.category,
      body: t.body,
      variables: t.variables,
      status: 'draft',
      usage_count: 0,
    });
    toast.success('Template duplicated');
    loadData();
  };

  const handleUse = (t) => { setSendingTemplate(t); };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <FileText className="w-8 h-8 text-purple-600" /> RCS Templates
          </h1>
          <p className="text-gray-500 mt-1">Create reusable message templates with dynamic variables</p>
        </div>
        <Button onClick={() => { setEditingTemplate(null); setShowEditor(true); }} className="gap-2">
          <Plus className="w-4 h-4" /> New Template
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{templates.length}</p>
            <p className="text-xs text-gray-500">Total Templates</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">{templates.filter(t => t.status === 'active').length}</p>
            <p className="text-xs text-gray-500">Active</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-purple-600">{templates.reduce((sum, t) => sum + (t.usage_count || 0), 0)}</p>
            <p className="text-xs text-gray-500">Total Sends</p>
          </CardContent>
        </Card>
      </div>

      {/* Editor Dialog */}
      <Dialog open={showEditor} onOpenChange={(open) => { if (!open) { setShowEditor(false); setEditingTemplate(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTemplate?.id ? 'Edit Template' : 'Create New Template'}</DialogTitle>
          </DialogHeader>
          <RCSTemplateEditor
            template={editingTemplate}
            onSave={handleSave}
            onCancel={() => { setShowEditor(false); setEditingTemplate(null); }}
          />
        </DialogContent>
      </Dialog>

      {/* Send Dialog */}
      <Dialog open={!!sendingTemplate} onOpenChange={(open) => { if (!open) setSendingTemplate(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-purple-600" /> Send RCS Message
            </DialogTitle>
          </DialogHeader>
          {sendingTemplate && (
            <RCSTemplateSender
              template={sendingTemplate}
              clientId={client?.id}
              onClose={() => { setSendingTemplate(null); loadData(); }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Template List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Your Templates</CardTitle>
        </CardHeader>
        <CardContent>
          <RCSTemplateList
            templates={templates}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            onUse={handleUse}
          />
        </CardContent>
      </Card>
    </div>
  );
}