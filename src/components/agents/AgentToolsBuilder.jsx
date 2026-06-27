import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Plus, Trash2, Webhook, Save } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/api/apiClient';

export default function AgentToolsBuilder({ agent, client }) {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    method: 'GET',
    url: '',
    headers: '{}',
    parameters_schema: '{}'
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (agent?.id) {
      loadTools();
    }
  }, [agent?.id]);

  const loadTools = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/v1/agents/${agent.id}/tools`, {
        headers: {
          'Authorization': `Bearer ${apiClient.auth.getToken()}`
        }
      });
      const data = await res.json();
      if (data.success) {
        setTools(data.tools);
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to load tools');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    try {
      if (!form.name || !form.url) {
        return toast.error('Name and URL are required');
      }

      let parsedHeaders = {};
      let parsedSchema = {};
      try {
        parsedHeaders = JSON.parse(form.headers || '{}');
      } catch(e) {
        return toast.error('Headers must be valid JSON');
      }
      try {
        parsedSchema = JSON.parse(form.parameters_schema || '{}');
      } catch(e) {
        return toast.error('Parameters schema must be valid JSON');
      }

      setSaving(true);
      const res = await fetch(`/api/v1/agents/${agent.id}/tools`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiClient.auth.getToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: client?.id || agent.client_id,
          name: form.name,
          description: form.description,
          method: form.method,
          url: form.url,
          headers: parsedHeaders,
          parameters_schema: parsedSchema
        })
      });
      
      const data = await res.json();
      if (data.success) {
        toast.success('Tool added successfully');
        setShowAdd(false);
        setForm({
          name: '', description: '', method: 'GET', url: '', headers: '{}', parameters_schema: '{}'
        });
        loadTools();
      } else {
        toast.error(data.error || 'Failed to add tool');
      }
    } catch (e) {
      console.error(e);
      toast.error('Error adding tool');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this tool?')) return;
    try {
      const res = await fetch(`/api/v1/agents/tools/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${apiClient.auth.getToken()}`
        }
      });
      const data = await res.json();
      if (data.success) {
        toast.success('Tool deleted');
        loadTools();
      } else {
        toast.error(data.error || 'Failed to delete tool');
      }
    } catch (e) {
      console.error(e);
      toast.error('Error deleting tool');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Webhook className="w-5 h-5 text-indigo-500" />
            <div>
              <CardTitle>Custom Agent Tools (Webhooks)</CardTitle>
              <CardDescription>Allow AI to call external APIs during the conversation</CardDescription>
            </div>
          </div>
          <Button onClick={() => setShowAdd(!showAdd)} variant="outline" size="sm">
            <Plus className="w-4 h-4 mr-2" /> Add Tool
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showAdd && (
          <div className="bg-gray-50 p-4 rounded-lg border mb-6 space-y-4">
            <h4 className="font-medium text-sm">Add New Tool</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Tool Name</Label>
                <Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. check_inventory" />
                <p className="text-xs text-gray-500 mt-1">Must be snake_case, no spaces.</p>
              </div>
              <div>
                <Label>HTTP Method</Label>
                <select 
                  className="flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  value={form.method} 
                  onChange={e => setForm({...form, method: e.target.value})}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>
            </div>
            
            <div>
              <Label>Description</Label>
              <Input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="What does this tool do? AI uses this to know when to call it." />
            </div>

            <div>
              <Label>API URL</Label>
              <Input value={form.url} onChange={e => setForm({...form, url: e.target.value})} placeholder="https://api.example.com/v1/..." />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Headers (JSON)</Label>
                <Textarea 
                  value={form.headers} 
                  onChange={e => setForm({...form, headers: e.target.value})}
                  className="font-mono text-xs" 
                  rows={4} 
                />
              </div>
              <div>
                <Label>Parameters Schema (JSON)</Label>
                <Textarea 
                  value={form.parameters_schema} 
                  onChange={e => setForm({...form, parameters_schema: e.target.value})}
                  className="font-mono text-xs" 
                  rows={4} 
                  placeholder='{"type":"object","properties":{...}}'
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button onClick={handleAdd} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save Tool
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : tools.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">No custom tools added yet.</p>
        ) : (
          <div className="space-y-3">
            {tools.map(tool => (
              <div key={tool.id} className="p-3 border rounded-lg flex items-center justify-between">
                <div>
                  <h4 className="font-medium text-sm flex items-center gap-2">
                    {tool.name}
                    <span className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono">{tool.method}</span>
                  </h4>
                  <p className="text-xs text-gray-500 mt-1">{tool.description}</p>
                  <p className="text-xs text-gray-400 mt-1 truncate max-w-md font-mono">{tool.url}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(tool.id)}>
                  <Trash2 className="w-4 h-4 text-red-500" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
