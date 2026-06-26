import React, { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { apiClient } from '@/api/apiClient';
import { Upload, FileText, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export default function ContactImporter({ clientId, onImported }) {
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState(null);
  const fileRef = useRef(null);

  const handleFileSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setImporting(true);
    setResults(null);

    try {
      const text = await file.text();
      let contacts = [];

      if (file.name.endsWith('.csv')) {
        contacts = parseCSV(text);
      } else if (file.name.endsWith('.vcf')) {
        contacts = parseVCF(text);
      } else {
        toast.error('Unsupported file. Use CSV or VCF (vCard) files.');
        setImporting(false);
        return;
      }

      if (contacts.length === 0) {
        toast.error('No contacts found in the file');
        setImporting(false);
        return;
      }

      // Import contacts
      let added = 0;
      let skipped = 0;
      const existing = await apiClient.TrustedContact.filter({ client_id: clientId });
      const existingPhones = new Set(existing.map(c => c.phone.replace(/\D/g, '').slice(-10)));

      for (const contact of contacts) {
        const cleanPhone = contact.phone.replace(/\D/g, '').slice(-10);
        if (cleanPhone.length < 10 || existingPhones.has(cleanPhone)) {
          skipped++;
          continue;
        }
        await apiClient.TrustedContact.create({
          client_id: clientId,
          name: contact.name || '',
          phone: contact.phone,
          relationship: 'other',
          always_connect: true
        });
        existingPhones.add(cleanPhone);
        added++;
      }

      setResults({ added, skipped, total: contacts.length });
      if (added > 0) {
        toast.success(`${added} contacts imported`);
        onImported?.();
      }
    } catch (err) {
      toast.error('Failed to import: ' + err.message);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
    const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('first'));
    const phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('number') || h.includes('tel'));

    if (phoneIdx === -1) return [];

    return lines.slice(1).map(line => {
      const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
      return {
        name: nameIdx >= 0 ? cols[nameIdx] || '' : '',
        phone: cols[phoneIdx] || ''
      };
    }).filter(c => c.phone);
  };

  const parseVCF = (text) => {
    const contacts = [];
    const cards = text.split('BEGIN:VCARD');
    for (const card of cards) {
      if (!card.trim()) continue;
      let name = '';
      let phone = '';
      const lines = card.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('FN:') || trimmed.startsWith('FN;')) {
          name = trimmed.split(':').slice(1).join(':').trim();
        }
        if (trimmed.startsWith('TEL') && !phone) {
          phone = trimmed.split(':').slice(1).join(':').trim();
        }
      }
      if (phone) contacts.push({ name, phone });
    }
    return contacts;
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <Upload className="w-4 h-4" /> Import
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Contacts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <p className="text-sm text-gray-600">
            Import contacts from a CSV or vCard (.vcf) file. Exported from Google Contacts, iPhone, or any phone.
          </p>

          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-gray-50 border">
              <p className="text-xs font-medium text-gray-700 mb-2">How to export contacts:</p>
              <ul className="text-xs text-gray-500 space-y-1 list-disc pl-4">
                <li><strong>Google Contacts:</strong> Go to contacts.google.com → Select contacts → Export → CSV or vCard</li>
                <li><strong>iPhone:</strong> Use iCloud.com → Contacts → Export vCard</li>
                <li><strong>Android:</strong> Contacts app → Settings → Export → .vcf file</li>
              </ul>
            </div>

            <div className="relative">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.vcf"
                onChange={handleFileSelect}
                className="hidden"
                id="contact-import"
              />
              <label
                htmlFor="contact-import"
                className="flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
              >
                {importing ? (
                  <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                ) : (
                  <FileText className="w-8 h-8 text-gray-400" />
                )}
                <span className="text-sm text-gray-600 mt-2">
                  {importing ? 'Importing...' : 'Click to upload CSV or VCF file'}
                </span>
              </label>
            </div>

            {results && (
              <div className="p-3 rounded-lg bg-green-50 border border-green-200 space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-green-800">
                  <CheckCircle2 className="w-4 h-4" /> Import Complete
                </div>
                <p className="text-xs text-green-700">
                  {results.added} added • {results.skipped} skipped (duplicates or invalid) • {results.total} total in file
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}