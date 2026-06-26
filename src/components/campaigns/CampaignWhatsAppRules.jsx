import React, { useEffect, useState } from 'react';
import { apiClient } from '@/api/apiClient';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { MessageSquare, AlertCircle } from 'lucide-react';
import TemplateVariableMapper from './TemplateVariableMapper';

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
  const varMap = value?.template_variable_map || {};
  const missedEnabled = value?.missed_call_enabled || false;
  const missedWhen = value?.missed_call_when || 'after_final_retry';
  const missedTemplateId = value?.missed_call_template_id || '';
  const answeredEnabled = value?.answered_call_enabled || false;
  const answeredTemplateId = value?.answered_call_template_id || '';

  const merge = (patch) => onChange({
    enabled,
    intent_template_map: intentMap,
    template_variable_map: varMap,
    answered_call_enabled: answeredEnabled,
    answered_call_template_id: answeredTemplateId,
    missed_call_enabled: missedEnabled,
    missed_call_when: missedWhen,
    missed_call_template_id: missedTemplateId,
    ...patch
  });

  const templateById = (id) => templates.find(t => t.id === id);
  const setVarMapping = (templateId, slots) => {
    merge({ template_variable_map: { ...varMap, [templateId]: slots } });
  };

  useEffect(() => {
    if (!clientId) return;
    (async () => {
      try {
        const all = await apiClient.WhatsAppTemplate.filter({ client_id: clientId }, '-updated_date', 200);
        setTemplates(all.filter(t => t.status === 'APPROVED'));
      } finally {
        setLoading(false);
      }
    })();
  }, [clientId]);

  const setEnabled = (v) => merge({ enabled: !!v });
  const setMapping = (intent, templateId) => {
    const next = { ...intentMap };
    if (templateId === '__none__') delete next[intent];
    else next[intent] = templateId;
    merge({ intent_template_map: next });
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
              {Object.values(intentMap).filter(Boolean).length === 0 && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span><strong>Auto-send is ON but no templates are mapped.</strong> No WhatsApp will be sent until you map at least one intent below to an approved template.</span>
                </div>
              )}
              <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Map intents → templates</Label>
              <div className="space-y-2">
                {INTENTS.map(intent => (
                  <div key={intent.key} className="space-y-1">
                    <div className="grid grid-cols-5 gap-2 items-center">
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
                    {intentMap[intent.key] && (
                      <TemplateVariableMapper
                        template={templateById(intentMap[intent.key])}
                        mapping={varMap[intentMap[intent.key]]}
                        onChange={(slots) => setVarMapping(intentMap[intent.key], slots)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* === ANSWERED CALL (fixed template, no AI) section === */}
      <div className="pt-3 mt-3 border-t border-emerald-200/60">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={answeredEnabled}
            onCheckedChange={(v) => merge({ answered_call_enabled: !!v })}
            id="wa-answered-toggle"
          />
          <label htmlFor="wa-answered-toggle" className="font-semibold text-sm text-gray-700 cursor-pointer">
            ✅ Send WhatsApp after EVERY answered call
          </label>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Sends a fixed template to every lead who picked up — no AI needed, works even when AI credits are exhausted.
        </p>

        {answeredEnabled && (
          <div className="space-y-3 mt-3 pl-6">
            {templates.length === 0 ? (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>No APPROVED WhatsApp templates found. Sync templates from the WhatsApp Templates page first.</span>
              </div>
            ) : (
              <div>
                <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Template to send</Label>
                <Select
                  value={answeredTemplateId || '__none__'}
                  onValueChange={(v) => merge({ answered_call_template_id: v === '__none__' ? '' : v })}
                >
                  <SelectTrigger className="h-9 mt-1">
                    <SelectValue placeholder="-- select template --" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— Select template —</SelectItem>
                    {templates.map(t => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.language})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {answeredTemplateId && (
                  <TemplateVariableMapper
                    template={templateById(answeredTemplateId)}
                    mapping={varMap[answeredTemplateId]}
                    onChange={(slots) => setVarMapping(answeredTemplateId, slots)}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* === MISSED CALL section === */}
      <div className="pt-3 mt-3 border-t border-emerald-200/60">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={missedEnabled}
            onCheckedChange={(v) => merge({ missed_call_enabled: !!v })}
            id="wa-missed-toggle"
          />
          <label htmlFor="wa-missed-toggle" className="font-semibold text-sm text-gray-700 cursor-pointer">
            📵 Send WhatsApp when call is NOT answered
          </label>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Sends a template silently to leads who didn't pick up.
        </p>

        {missedEnabled && (
          <div className="space-y-3 mt-3 pl-6">
            {templates.length === 0 ? (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>No APPROVED WhatsApp templates found. Sync templates from the WhatsApp Templates page first.</span>
              </div>
            ) : (
              <>
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">When to send</Label>
                  <Select value={missedWhen} onValueChange={(v) => merge({ missed_call_when: v })}>
                    <SelectTrigger className="h-9 mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="after_final_retry">After final retry (recommended)</SelectItem>
                      <SelectItem value="first_miss">On first miss only</SelectItem>
                      <SelectItem value="every_miss">Every missed attempt</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Template to send</Label>
                  <Select
                    value={missedTemplateId || '__none__'}
                    onValueChange={(v) => merge({ missed_call_template_id: v === '__none__' ? '' : v })}
                  >
                    <SelectTrigger className="h-9 mt-1">
                      <SelectValue placeholder="-- select template --" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— Select template —</SelectItem>
                      {templates.map(t => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name} ({t.language})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {missedTemplateId && (
                    <TemplateVariableMapper
                      template={templateById(missedTemplateId)}
                      mapping={varMap[missedTemplateId]}
                      onChange={(slots) => setVarMapping(missedTemplateId, slots)}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}