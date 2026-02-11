import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Upload, Loader2, FileText, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export default function CSVImportDialog({ open, onOpenChange, clientId, onComplete }) {
  const [file, setFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);

  const handleImport = async () => {
    if (!file) { toast.error('Please select a CSV file'); return; }
    setImporting(true);
    setResult(null);

    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    
    const extracted = await base44.integrations.Core.ExtractDataFromUploadedFile({
      file_url,
      json_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
            company: { type: "string" },
            notes: { type: "string" },
            source: { type: "string" },
          }
        }
      }
    });

    if (extracted.status === 'error') {
      toast.error('Failed to parse file: ' + (extracted.details || 'Unknown error'));
      setImporting(false);
      return;
    }

    const rows = Array.isArray(extracted.output) ? extracted.output : [];
    if (rows.length === 0) {
      toast.error('No leads found in file');
      setImporting(false);
      return;
    }

    // Bulk create leads
    const leadsToCreate = rows
      .filter(r => r.phone || r.name)
      .map(r => ({
        client_id: clientId,
        name: r.name || 'Unknown',
        phone: r.phone || '',
        email: r.email || '',
        company: r.company || '',
        notes: r.notes || '',
        source: r.source || 'csv_import',
        status: 'new',
      }));

    await base44.entities.Lead.bulkCreate(leadsToCreate);
    setResult({ imported: leadsToCreate.length, total: rows.length });
    toast.success(`${leadsToCreate.length} leads imported!`);
    setImporting(false);
    if (onComplete) onComplete();
  };

  const handleClose = () => {
    setFile(null);
    setResult(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Leads from CSV</DialogTitle>
        </DialogHeader>
        
        {result ? (
          <div className="text-center py-6 space-y-4">
            <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto" />
            <div>
              <p className="text-lg font-semibold">{result.imported} leads imported</p>
              <p className="text-sm text-gray-500">out of {result.total} rows in file</p>
            </div>
            <Button onClick={handleClose} className="bg-blue-600 hover:bg-blue-700">Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>CSV File</Label>
              <Input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={(e) => setFile(e.target.files[0])}
              />
              <p className="text-xs text-gray-400 mt-1">
                Columns: name, phone, email, company, notes, source
              </p>
            </div>

            {file && (
              <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                <FileText className="w-4 h-4 text-blue-600" />
                <span className="text-sm text-gray-700">{file.name}</span>
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={handleClose} disabled={importing}>Cancel</Button>
              <Button onClick={handleImport} disabled={importing || !file} className="bg-blue-600 hover:bg-blue-700">
                {importing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</> : <><Upload className="w-4 h-4 mr-2" /> Import</>}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}