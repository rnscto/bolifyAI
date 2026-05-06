import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { MessageSquare, AlertCircle } from 'lucide-react';

const INTENTS = [
  { key: 'pricing_details', label: 'Pricing / Cost', hint: 'Customer asks "send me pricing"' },
  { key: 'brochure_request', label: 'Brochure / Catalog', hint: 'Customer asks for brochure or product info' },
  { key: 'demo_booking', label: 'Demo / Trial', hint: 'Customer agrees to a demo or trial' },
  { key: 'callback_confirmation', label: 'Callback Confirmation', hint: 'Customer confirms callback time' },
  { key: 'location_address', label: 'Location / Address', hint: 'Customer asks for office address' },
  { key: 'payment_link', label: 'Payment Link', hint: 'Customer asks how to pay' },
  { key: 'general_details', label: 'General Details', hint: 'Customer asks "send details" without specifying' },
];

export default function CampaignWhatsAppRules({ clientId, value, onChange }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  const enabled = value?.enabled || false;
  const intentMap = value?.intent_template_map || {};

  useEffect(() => {
    if (!clientId) return;
    (async () => {
      try {
        const all = await base44.entities.WhatsAppTemplate.filter({ client_id: clientId }, '-updated_date', 200);
        setTemplates(all.filter(t => t.status === 'APPROVED'));
      } finally {
        setLoading(false);
      }
    })();
  }, [clientId]);

  const setEnabled = (v) => onChange({ enabled: !!v, intent_template_map: intentMap });
  const setMapping = (intent, templateId) => {
    const next = { ...intentMap };
    if (templateId === '__none__') delete next[intent];
    else next[intent] = templateId;
    onChange({ enabled, intent_template_map: next });
  };

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-emerald-50/30">
      <div className="flex items-center gap-2">
        <Checkbox checked={enabled} onCheckedChange={setEnabled} id="wa-auto-toggle" />
        <label htmlFor="wa-auto-toggle" className="font-semibold text-sm text-gray-700 cursor-pointer flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-emerald-600" />
          Auto-send WhatsApp template after call
        </label>
      </div>
      <p className="text-xs text-gray-500">
        When AI detects a customer request in the call transcript (e.g. "send me pricing on WhatsApp"), the matching approved template is sent silently after the call ends.
      </p>

      {enabled && (
        <div className="space-y-2 pt-2">
          {loading ? (
            <p className="text-xs text-gray-500">Loading templates…</p>
          ) : templates.length === 0 ? (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>No APPROVED WhatsApp templates found. Sync templates from the WhatsApp Templates page first.</span>
            </div>
          ) : (
            <>
              <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Map intents → templates</Label>
              <div className="space-y-2">
                {INTENTS.map(intent => (
                  <div key={intent.key} className="grid grid-cols-5 gap-2 items-center">
                    <div className="col-span-2">
                      <p className="text-sm font-medium text-gray-800">{intent.label}</p>
                      <p className="text-xs text-gray-500">{intent.hint}</p>
                    </div>
                    <div className="col-span-3">
                      <Select
                        value={intentMap[intent.key] || '__none__'}
                        onValueChange={(v) => setMapping(intent.key, v)}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="-- not mapped --" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— Not mapped (skip) —</SelectItem>
                          {templates.map(t => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name} ({t.language})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}