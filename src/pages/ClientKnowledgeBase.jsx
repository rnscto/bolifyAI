import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
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
import { Upload, FileText, Trash2, Loader2, Type, AlertCircle, CheckCircle2, Clock, RefreshCw, Eye } from 'lucide-react';
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
  const [uploadProgress, setUploadProgress] = useState('');
  const [previewDoc, setPreviewDoc] = useState(null);


  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await apiClient.auth.me();
      const clients = await apiClient.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const [docsData, agentsData] = await Promise.all([
          apiClient.KnowledgeBase.filter(
            { client_id: clientData.id },
            '-created_at',
            100
          ),
          apiClient.Agent.filter({ client_id: clientData.id })
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
    if (!formData.title.trim()) {
      toast.error('Please enter a document title');
      return;
    }

    setUploading(true);
    setUploadProgress('Preparing...');
    try {
      let docData;

      if (inputMode === 'text') {
        let textContent = formData.textContent;
        let fileUrl = '';
        // If content is too large for entity field, upload as file
        if (textContent.length > 100000) {
          setUploadProgress('Uploading large text...');
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
        setUploadProgress('Uploading file to storage...');
        const uploadResponse = await azureUpload(formData.file, 'kb');

        docData = {
          client_id: client.id,
          title: formData.title,
          category: formData.category,
          file_url: uploadResponse.file_url,
          file_type: formData.file.name.endsWith('.pdf') ? 'pdf' : formData.file.name.endsWith('.docx') ? 'docx' : 'txt',
          status: 'processing'
        };
      }

      setUploadProgress('Saving document...');
      const kbDoc = await apiClient.KnowledgeBase.create(docData);

      // For uploaded files, extract text content directly
      if (inputMode === 'file') {
        setUploadProgress('Extracting text content...');
        try {
          const extractRes = await apiClient.functions.invoke('extractKBContent', { kb_id: kbDoc.id });
          if (extractRes?.data?.success === false) {
            console.warn('KB extraction warning:', extractRes.data.error);
          }
        } catch (extractErr) {
          console.error('KB extraction failed:', extractErr);
          // Don't fail upload for extraction errors — document is saved, extraction can be retried
        }
      }

      // Auto-sync with assigned agent
      setUploadProgress('Syncing with agent...');
      if (agent) {
        const currentKbIds = agent.knowledge_base_ids || [];
        if (!currentKbIds.includes(kbDoc.id)) {
          await apiClient.Agent.update(agent.id, {
            knowledge_base_ids: [...currentKbIds, kbDoc.id]
          });
          toast.success('Document uploaded and synced with your AI agent! ✅');
        } else {
          toast.success('Document uploaded successfully! ✅');
        }
      } else {
        toast.success('Document saved. Assign an agent to use it in calls.');
      }
      setDialogOpen(false);
      setFormData({ title: '', category: '', file: null, textContent: '' });
      setInputMode('file');
      loadData();
    } catch (error) {
      console.error('Error uploading document:', error);
      toast.error(`Upload failed: ${error.message || 'Unknown error'}`);
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  };


  const handleDelete = async (id) => {
    if (!confirm('Delete this document?')) return;

    try {
      await apiClient.KnowledgeBase.delete(id);

      // Remove from agent's knowledge base
      if (agent && agent.knowledge_base_ids?.includes(id)) {
        await apiClient.Agent.update(agent.id, {
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

  const handleRetryExtract = async (doc) => {
    try {
      toast.info('Re-extracting content...');
      await apiClient.functions.invoke('extractKBContent', { kb_id: doc.id });
      toast.success('Re-extraction triggered. Refresh in a moment.');
      setTimeout(loadData, 3000);
    } catch (err) {
      toast.error('Re-extraction failed: ' + err.message);
    }
  };

  const statusConfig = {
    processing: { label: 'Processing', icon: Clock, cls: 'bg-amber-100 text-amber-800 border-amber-200' },
    ready:      { label: 'Ready',      icon: CheckCircle2, cls: 'bg-green-100 text-green-800 border-green-200' },
    failed:     { label: 'Failed',     icon: AlertCircle,  cls: 'bg-red-100 text-red-800 border-red-200'  }
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
                  <p className="text-xs text-gray-500 mt-1">{formData.textContent.length} characters</p>
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
                      {uploadProgress || 'Uploading...'}
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
            <FileText className="w-16 h-16 text-gray-600 mb-4" />
            <p className="text-gray-500 mb-4">No documents uploaded yet</p>
            <Button onClick={() => setDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700">
              <Upload className="w-4 h-4 mr-2" />
              Upload Your First Document
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {documents.map((doc) => {
            const sc = statusConfig[doc.status] || statusConfig.processing;
            const StatusIcon = sc.icon;
            return (
            <Card key={doc.id} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <FileText className="w-8 h-8 text-blue-600 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <CardTitle className="text-base truncate">{doc.title}</CardTitle>
                      {doc.category && (
                        <p className="text-xs text-gray-500 mt-0.5">{doc.category}</p>
                      )}
                    </div>
                  </div>
                  <Badge className={`${sc.cls} text-xs flex items-center gap-1 flex-shrink-0 border`}>
                    <StatusIcon className="w-3 h-3" />
                    {sc.label}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3">
                {doc.content && (
                  <p className="text-xs text-gray-500 line-clamp-3 bg-gray-50 rounded p-2">
                    {doc.content.substring(0, 200)}{doc.content.length > 200 ? '...' : ''}
                  </p>
                )}
                <div className="flex items-center justify-between mt-auto">
                  <span className="text-xs font-medium text-gray-500 uppercase">
                    {doc.file_type || 'TXT'}
                  </span>
                  <div className="flex gap-1.5">
                    {doc.status === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-amber-700 border-amber-300 hover:bg-amber-50 h-7 px-2"
                        onClick={() => handleRetryExtract(doc)}
                      >
                        <RefreshCw className="w-3 h-3 mr-1" /> Retry
                      </Button>
                    )}
                    {doc.file_url && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        onClick={() => window.open(doc.file_url, '_blank')}
                      >
                        <Eye className="w-3 h-3 mr-1" /> View
                      </Button>
                    )}
                    {doc.content && !doc.file_url && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        onClick={() => setPreviewDoc(doc)}
                      >
                        <Eye className="w-3 h-3 mr-1" /> Preview
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => handleDelete(doc.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )})}
        </div>
      )}
    </div>
    </FeatureGate>

    {/* Content Preview Dialog */}
    {previewDoc && (
      <Dialog open={!!previewDoc} onOpenChange={() => setPreviewDoc(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewDoc.title}</DialogTitle>
          </DialogHeader>
          <pre className="text-sm whitespace-pre-wrap text-gray-700 bg-gray-50 p-4 rounded-lg">
            {previewDoc.content}
          </pre>
        </DialogContent>
      </Dialog>
    )}
  );
}