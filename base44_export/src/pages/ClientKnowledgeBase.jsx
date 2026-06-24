import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Upload, FileText, Trash2, Loader2, Type } from 'lucide-react';
import { toast } from 'sonner';
import FeatureGate from '../components/FeatureGate';
import { uploadFile as azureUpload } from '@/lib/azureBlob';

export default function ClientKnowledgeBase() {
  const [documents, setDocuments] = useState([]);
  const [client, setClient] = useState(null);
  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [inputMode, setInputMode] = useState('file'); // 'file' or 'text'
  const [formData, setFormData] = useState({
    title: '',
    category: '',
    file: null,
    textContent: ''
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const [docsData, agentsData] = await Promise.all([
          base44.entities.KnowledgeBase.filter(
            { client_id: clientData.id },
            '-created_date'
          ),
          base44.entities.Agent.filter({ client_id: clientData.id })
        ]);

        setDocuments(docsData);
        if (agentsData.length > 0) {
          setAgent(agentsData[0]);
        }
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (inputMode === 'file' && !formData.file) {
      toast.error('Please select a file');
      return;
    }
    if (inputMode === 'text' && !formData.textContent.trim()) {
      toast.error('Please enter some text content');
      return;
    }

    setUploading(true);
    try {
      let docData;

      if (inputMode === 'text') {
        let textContent = formData.textContent;
        let fileUrl = '';
        // If content is too large for entity field, upload as file
        if (textContent.length > 100000) {
          const blob = new Blob([textContent], { type: 'text/plain' });
          const file = new File([blob], `${formData.title || 'content'}.txt`, { type: 'text/plain' });
          const uploadResponse = await azureUpload(file, 'kb');
          fileUrl = uploadResponse.file_url;
          textContent = textContent.substring(0, 100000) + '\n\n[Full content available in uploaded file]';
        }
        docData = {
          client_id: client.id,
          title: formData.title,
          category: formData.category,
          content: textContent,
          file_url: fileUrl || undefined,
          file_type: 'txt',
          status: 'ready'
        };
      } else {
        const uploadResponse = await azureUpload(formData.file, 'kb');

        docData = {
          client_id: client.id,
          title: formData.title,
          category: formData.category,
          file_url: uploadResponse.file_url,
          file_type: formData.file.type.includes('pdf') ? 'pdf' : 'txt',
          status: 'processing'
        };
      }

      const kbDoc = await base44.entities.KnowledgeBase.create(docData);

      // For uploaded files, extract text content directly (no automation / integration credits needed)
      if (inputMode === 'file') {
        try {
          await base44.functions.invoke('extractKBContent', { kb_id: kbDoc.id });
        } catch (extractErr) {
          console.error('KB extraction failed:', extractErr);
        }
      }

      // Auto-sync with assigned agent
      if (agent) {
        const currentKbIds = agent.knowledge_base_ids || [];
        if (!currentKbIds.includes(kbDoc.id)) {
          await base44.entities.Agent.update(agent.id, {
            knowledge_base_ids: [...currentKbIds, kbDoc.id]
          });
          toast.success('Document uploaded and synced with agent');
        } else {
          toast.success('Document uploaded');
        }
      } else {
        toast.success('Document uploaded (no agent assigned yet)');
      }
      setDialogOpen(false);
      setFormData({ title: '', category: '', file: null, textContent: '' });
      setInputMode('file');
      loadData();
    } catch (error) {
      console.error('Error uploading document:', error);
      toast.error('Failed to upload document');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this document?')) return;

    try {
      await base44.entities.KnowledgeBase.delete(id);

      // Remove from agent's knowledge base
      if (agent && agent.knowledge_base_ids?.includes(id)) {
        await base44.entities.Agent.update(agent.id, {
          knowledge_base_ids: agent.knowledge_base_ids.filter(kbId => kbId !== id)
        });
      }

      toast.success('Document deleted and removed from agent');
      loadData();
    } catch (error) {
      console.error('Error deleting document:', error);
      toast.error('Failed to delete document');
    }
  };

  const statusColors = {
    processing: 'bg-yellow-100 text-yellow-800',
    ready: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800'
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <FeatureGate client={client} featureName="Knowledge Base">
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Knowledge Base</h1>
          <p className="text-gray-600 mt-1">Upload training documents for your AI agents</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Upload className="w-4 h-4 mr-2" />
              Upload Document
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload Training Document</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Mode toggle */}
              <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setInputMode('file')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    inputMode === 'file' ? 'bg-white shadow text-blue-700' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Upload className="w-4 h-4" /> Upload File
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('text')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    inputMode === 'text' ? 'bg-white shadow text-blue-700' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Type className="w-4 h-4" /> Paste Text
                </button>
              </div>

              <div>
                <Label htmlFor="title">Document Title</Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Product FAQs"
                  required
                />
              </div>
              <div>
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  placeholder="FAQs, Product Info, Scripts, etc."
                />
              </div>

              {inputMode === 'file' ? (
                <div>
                  <Label htmlFor="file">File (PDF, TXT, DOCX)</Label>
                  <Input
                    id="file"
                    type="file"
                    accept=".pdf,.txt,.docx"
                    onChange={(e) => setFormData({ ...formData, file: e.target.files[0] })}
                    required
                  />
                </div>
              ) : (
                <div>
                  <Label htmlFor="textContent">Paste your content below</Label>
                  <Textarea
                    id="textContent"
                    value={formData.textContent}
                    onChange={(e) => setFormData({ ...formData, textContent: e.target.value })}
                    placeholder="Paste your product info, FAQs, scripts, or any training content here..."
                    className="min-h-[200px]"
                    required
                  />
                  <p className="text-xs text-gray-400 mt-1">{formData.textContent.length} characters</p>
                </div>
              )}
              <div className="flex gap-3 justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  disabled={uploading}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-700"
                  disabled={uploading}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    inputMode === 'text' ? 'Save' : 'Upload'
                  )}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FileText className="w-16 h-16 text-gray-300 mb-4" />
            <p className="text-gray-500 mb-4">No documents uploaded yet</p>
            <Button onClick={() => setDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700">
              <Upload className="w-4 h-4 mr-2" />
              Upload Your First Document
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {documents.map((doc) => (
            <Card key={doc.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <FileText className="w-8 h-8 text-blue-600" />
                    <div>
                      <CardTitle className="text-base">{doc.title}</CardTitle>
                      {doc.category && (
                        <p className="text-sm text-gray-500 mt-1">{doc.category}</p>
                      )}
                    </div>
                  </div>
                  <Badge className={statusColors[doc.status]}>
                    {doc.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">
                    {doc.file_type?.toUpperCase()}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.open(doc.file_url, '_blank')}
                    >
                      View
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(doc.id)}
                    >
                      <Trash2 className="w-4 h-4 text-red-600" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
    </FeatureGate>
  );
}