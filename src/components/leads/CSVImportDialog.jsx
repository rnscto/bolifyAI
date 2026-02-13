import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Upload, Loader2, FileSpreadsheet, CheckCircle2, AlertCircle, ArrowRight, ArrowLeft, X } from 'lucide-react';
import { toast } from 'sonner';

const LEAD_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'company', label: 'Company' },
  { key: 'notes', label: 'Notes' },
  { key: 'source', label: 'Source' },
];

function parseCSVLine(line, delimiter) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  values.push(current.trim());
  return values;
}

function parseCSVLocally(text) {
  // Normalize line endings
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = parseCSVLine(lines[0], delimiter).map(h => h.replace(/^["']|["']$/g, ''));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i], delimiter);
    const row = {};
    headers.forEach((h, idx) => {
      const val = values[idx] !== undefined ? values[idx].replace(/^["']|["']$/g, '') : '';
      if (h && val) row[h] = val;
    });
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return { headers: headers.filter(h => h), rows };
}

function autoMapFields(headers) {
  const autoMap = {};
  LEAD_FIELDS.forEach(field => {
    const match = headers.find(h => {
      const hLower = h.toLowerCase().trim();
      const fLower = field.key.toLowerCase();
      const fLabel = field.label.toLowerCase();
      return hLower === fLower || hLower === fLabel ||
        hLower.includes(fLower) || fLower.includes(hLower) ||
        (fLower === 'phone' && (hLower.includes('mobile') || hLower.includes('contact') || hLower.includes('tel'))) ||
        (fLower === 'name' && (hLower.includes('full name') || hLower.includes('customer') || hLower.includes('lead'))) ||
        (fLower === 'company' && (hLower.includes('org') || hLower.includes('business'))) ||
        (fLower === 'email' && hLower.includes('mail'));
    });
    if (match) autoMap[field.key] = match;
  });
  return autoMap;
}

export default function CSVImportDialog({ open, onOpenChange, clientId, onComplete }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fileHeaders, setFileHeaders] = useState([]);
  const [rawData, setRawData] = useState([]);
  const [fieldMapping, setFieldMapping] = useState({});
  const [result, setResult] = useState(null);

  const handleFileSelect = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    const ext = selectedFile.name.substring(selectedFile.name.lastIndexOf('.')).toLowerCase();
    const validTypes = ['.csv', '.xlsx', '.xls'];
    if (!validTypes.includes(ext)) {
      toast.error('Please upload a CSV or Excel file (.csv, .xlsx, .xls)');
      return;
    }

    setFile(selectedFile);
    setUploading(true);

    if (ext === '.xlsx' || ext === '.xls') {
      // Excel: upload and extract server-side
      const { file_url } = await base44.integrations.Core.UploadFile({ file: selectedFile });
      const extracted = await base44.integrations.Core.ExtractDataFromUploadedFile({
        file_url,
        json_schema: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: { type: "string" }
              }
            }
          }
        }
      });

      if (extracted.status === 'error') {
        toast.error('Failed to read file: ' + (extracted.details || 'Unknown error'));
        setFile(null);
        setUploading(false);
        return;
      }

      const rows = Array.isArray(extracted.output?.rows) ? extracted.output.rows :
                   Array.isArray(extracted.output) ? extracted.output : [];
      if (rows.length === 0) {
        toast.error('No data found in file');
        setFile(null);
        setUploading(false);
        return;
      }

      const headers = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(h => h && h.trim());
      setFileHeaders(headers);
      setRawData(rows);
      setFieldMapping(autoMapFields(headers));
      setUploading(false);
      setStep(2);
    } else {
      // CSV: parse locally
      const reader = new FileReader();
      reader.onload = (event) => {
        const { headers, rows } = parseCSVLocally(event.target.result);
        if (rows.length === 0) {
          toast.error('No data found in file');
          setFile(null);
          setUploading(false);
          return;
        }
        setFileHeaders(headers);
        setRawData(rows);
        setFieldMapping(autoMapFields(headers));
        setUploading(false);
        setStep(2);
      };
      reader.onerror = () => {
        toast.error('Failed to read file');
        setFile(null);
        setUploading(false);
      };
      reader.readAsText(selectedFile);
    }
  };

  const getMappedLeads = () => {
    return rawData.map((row, idx) => {
      const lead = {};
      LEAD_FIELDS.forEach(field => {
        const sourceCol = fieldMapping[field.key];
        if (sourceCol && row[sourceCol] !== undefined && row[sourceCol] !== null) {
          lead[field.key] = String(row[sourceCol]).trim();
        }
      });
      lead._row = idx + 1;
      return lead;
    });
  };

  const getValidLeads = () => {
    return getMappedLeads().filter(l =>
      (l.phone && l.phone.length > 0) || (l.name && l.name.length > 0) || (l.email && l.email.length > 0)
    );
  };

  const getSkippedLeads = () => {
    return getMappedLeads().filter(l =>
      !(l.phone && l.phone.length > 0) && !(l.name && l.name.length > 0) && !(l.email && l.email.length > 0)
    );
  };

  const handleImport = async () => {
    const validLeads = getValidLeads();
    if (validLeads.length === 0) {
      toast.error('No valid leads to import.');
      return;
    }
    setImporting(true);

    const leadsToCreate = validLeads.map(lead => ({
      client_id: clientId,
      name: lead.name || '',
      phone: lead.phone || '',
      email: lead.email || '',
      company: lead.company || '',
      notes: lead.notes || '',
      source: lead.source || 'file_import',
      status: 'new',
    }));

    const chunkSize = 50;
    let imported = 0;
    for (let i = 0; i < leadsToCreate.length; i += chunkSize) {
      const chunk = leadsToCreate.slice(i, i + chunkSize);
      await base44.entities.Lead.bulkCreate(chunk);
      imported += chunk.length;
    }

    setResult({ imported, total: rawData.length, skipped: rawData.length - imported });
    setStep(4);
    setImporting(false);
    toast.success(`${imported} leads imported!`);
    if (onComplete) onComplete();
  };

  const handleClose = () => {
    setFile(null);
    setStep(1);
    setFileHeaders([]);
    setRawData([]);
    setFieldMapping({});
    setResult(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-blue-600" />
            Import Leads
          </DialogTitle>
        </DialogHeader>

        {/* Step indicators */}
        {step < 4 && (
          <div className="flex items-center gap-2 mb-2">
            {['Upload', 'Map Fields', 'Preview'].map((label, i) => (
              <React.Fragment key={label}>
                <div className={`flex items-center gap-1.5 ${step >= i + 1 ? 'text-blue-600' : 'text-gray-400'}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                    step > i + 1 ? 'bg-blue-600 text-white' : step === i + 1 ? 'bg-blue-100 text-blue-700 border border-blue-300' : 'bg-gray-100 text-gray-400'
                  }`}>
                    {step > i + 1 ? '✓' : i + 1}
                  </div>
                  <span className="text-xs font-medium hidden sm:inline">{label}</span>
                </div>
                {i < 2 && <div className={`flex-1 h-0.5 ${step > i + 1 ? 'bg-blue-600' : 'bg-gray-200'}`} />}
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Step 1: Upload */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center hover:border-blue-300 transition-colors">
              <Upload className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-700 mb-1">Upload CSV or Excel file</p>
              <p className="text-xs text-gray-400 mb-4">Supports .csv, .xlsx, .xls</p>
              <label className="cursor-pointer">
                <Input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} className="hidden" />
                <Button variant="outline" asChild disabled={uploading}>
                  <span>{uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Reading file...</> : 'Choose File'}</span>
                </Button>
              </label>
            </div>
            <div className="bg-blue-50 rounded-lg p-4">
              <p className="text-sm font-medium text-blue-800 mb-2">💡 Tips</p>
              <ul className="text-xs text-blue-700 space-y-1">
                <li>• All fields are optional — map only what you have</li>
                <li>• Your file needs at least one of: Name, Phone, or Email per row</li>
                <li>• Column names are auto-detected and matched</li>
              </ul>
            </div>
          </div>
        )}

        {/* Step 2: Field Mapping */}
        {step === 2 && (
          <div className="space-y-4">
            {file && (
              <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                <FileSpreadsheet className="w-4 h-4 text-blue-600" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-700 truncate">{file.name}</p>
                  <p className="text-xs text-gray-400">{rawData.length} rows detected</p>
                </div>
              </div>
            )}
            <p className="text-sm font-medium text-gray-700">Map your file columns to lead fields</p>
            <div className="space-y-2">
              {LEAD_FIELDS.map(field => (
                <div key={field.key} className="flex items-center gap-3">
                  <div className="w-28 flex-shrink-0">
                    <span className="text-sm text-gray-600">{field.label}</span>
                  </div>
                  <ArrowLeft className="w-4 h-4 text-gray-300 flex-shrink-0" />
                  <Select
                    value={fieldMapping[field.key] || '_skip'}
                    onValueChange={(val) => {
                      setFieldMapping(prev => {
                        const updated = { ...prev };
                        if (val === '_skip') delete updated[field.key];
                        else updated[field.key] = val;
                        return updated;
                      });
                    }}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Skip this field" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_skip"><span className="text-gray-400">— Skip —</span></SelectItem>
                      {fileHeaders.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {fieldMapping[field.key] && (
                    <button onClick={() => setFieldMapping(prev => { const u = { ...prev }; delete u[field.key]; return u; })} className="text-gray-400 hover:text-red-500">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {Object.keys(fieldMapping).length === 0 && (
              <div className="flex items-center gap-2 p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                <AlertCircle className="w-4 h-4 text-yellow-600 flex-shrink-0" />
                <p className="text-xs text-yellow-700">Map at least one field to continue</p>
              </div>
            )}
            <div className="flex gap-3 justify-between">
              <Button variant="outline" onClick={() => { setStep(1); setFile(null); setFileHeaders([]); setRawData([]); setFieldMapping({}); }}>
                <ArrowLeft className="w-4 h-4 mr-1" /> Back
              </Button>
              <Button onClick={() => setStep(3)} disabled={Object.keys(fieldMapping).length === 0} className="bg-blue-600 hover:bg-blue-700">
                Preview <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex gap-3">
              <div className="flex-1 bg-green-50 rounded-lg p-3 border border-green-200">
                <p className="text-lg font-bold text-green-700">{getValidLeads().length}</p>
                <p className="text-xs text-green-600">Ready to import</p>
              </div>
              <div className="flex-1 bg-yellow-50 rounded-lg p-3 border border-yellow-200">
                <p className="text-lg font-bold text-yellow-700">{getSkippedLeads().length}</p>
                <p className="text-xs text-yellow-600">Will be skipped</p>
              </div>
              <div className="flex-1 bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-lg font-bold text-gray-700">{rawData.length}</p>
                <p className="text-xs text-gray-500">Total rows</p>
              </div>
            </div>
            {getSkippedLeads().length > 0 && (
              <div className="flex items-start gap-2 p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                <AlertCircle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-700">{getSkippedLeads().length} row(s) have no name, phone, or email and will be skipped.</p>
              </div>
            )}
            <div className="border rounded-lg overflow-auto max-h-56">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs w-10">#</TableHead>
                    {LEAD_FIELDS.filter(f => fieldMapping[f.key]).map(f => (
                      <TableHead key={f.key} className="text-xs">{f.label}</TableHead>
                    ))}
                    <TableHead className="text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {getMappedLeads().slice(0, 20).map((lead, i) => {
                    const isValid = (lead.phone && lead.phone.length > 0) || (lead.name && lead.name.length > 0) || (lead.email && lead.email.length > 0);
                    return (
                      <TableRow key={i} className={!isValid ? 'bg-yellow-50/50' : ''}>
                        <TableCell className="text-xs text-gray-400">{lead._row}</TableCell>
                        {LEAD_FIELDS.filter(f => fieldMapping[f.key]).map(f => (
                          <TableCell key={f.key} className="text-xs max-w-[120px] truncate">
                            {lead[f.key] || <span className="text-gray-300">—</span>}
                          </TableCell>
                        ))}
                        <TableCell>
                          {isValid ? (
                            <Badge className="bg-green-100 text-green-700 text-[10px]">Ready</Badge>
                          ) : (
                            <Badge className="bg-yellow-100 text-yellow-700 text-[10px]">Skip</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {rawData.length > 20 && (
                <p className="text-xs text-gray-400 text-center py-2">Showing first 20 of {rawData.length} rows</p>
              )}
            </div>
            <div className="flex gap-3 justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                <ArrowLeft className="w-4 h-4 mr-1" /> Edit Mapping
              </Button>
              <Button onClick={handleImport} disabled={importing || getValidLeads().length === 0} className="bg-blue-600 hover:bg-blue-700">
                {importing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</> : <><Upload className="w-4 h-4 mr-2" /> Import {getValidLeads().length} Leads</>}
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Result */}
        {step === 4 && result && (
          <div className="text-center py-6 space-y-4">
            <CheckCircle2 className="w-14 h-14 text-green-600 mx-auto" />
            <div>
              <p className="text-xl font-bold text-gray-900">{result.imported} leads imported!</p>
              {result.skipped > 0 && (
                <p className="text-sm text-gray-500 mt-1">{result.skipped} rows skipped</p>
              )}
            </div>
            <Button onClick={handleClose} className="bg-blue-600 hover:bg-blue-700">Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}