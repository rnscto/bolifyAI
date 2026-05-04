import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Clock, XCircle, Send, Link2, Languages, BarChart3 } from 'lucide-react';
import { ACTION_BY_VALUE } from './PLATFORM_ACTIONS';

const STATUS_STYLES = {
  APPROVED: { color: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  PENDING: { color: 'bg-yellow-100 text-yellow-800', icon: Clock },
  REJECTED: { color: 'bg-red-100 text-red-800', icon: XCircle },
  PAUSED: { color: 'bg-orange-100 text-orange-800', icon: Clock },
  DISABLED: { color: 'bg-gray-100 text-gray-700', icon: XCircle },
  draft: { color: 'bg-gray-100 text-gray-600', icon: Clock },
};

const CATEGORY_COLORS = {
  MARKETING: 'bg-purple-100 text-purple-700',
  UTILITY: 'bg-blue-100 text-blue-700',
  AUTHENTICATION: 'bg-orange-100 text-orange-700',
};

export default function TemplateCard({ template, onSend, onEditLinks }) {
  const StatusIcon = STATUS_STYLES[template.status]?.icon || Clock;
  const statusColor = STATUS_STYLES[template.status]?.color || 'bg-gray-100';
  const linkedCount = (template.linked_actions || []).filter(a => a !== 'manual_only').length;

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 truncate">{template.name}</h3>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <Badge className={statusColor}>
                <StatusIcon className="w-3 h-3 mr-1" /> {template.status}
              </Badge>
              {template.category && (
                <Badge className={CATEGORY_COLORS[template.category] || 'bg-gray-100'}>
                  {template.category}
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                <Languages className="w-3 h-3 mr-1" /> {template.language}
              </Badge>
            </div>
          </div>
        </div>

        {template.header_text && (
          <p className="text-xs font-semibold text-gray-700 truncate">{template.header_text}</p>
        )}

        <p className="text-sm text-gray-600 line-clamp-3 whitespace-pre-wrap">
          {template.body_text}
        </p>

        {template.footer_text && (
          <p className="text-xs text-gray-400 italic truncate">{template.footer_text}</p>
        )}

        {template.buttons && template.buttons.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {template.buttons.map((b, i) => (
              <span key={i} className="text-xs px-2 py-0.5 border rounded-full text-blue-600 bg-blue-50 truncate max-w-[140px]">
                {b.text}
              </span>
            ))}
          </div>
        )}

        {/* Linked Actions / Use Points */}
        <div className="border-t pt-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Use Points</p>
          {linkedCount > 0 ? (
            <div className="flex flex-wrap gap-1">
              {(template.linked_actions || []).filter(a => a !== 'manual_only').map(a => (
                <Badge key={a} className="bg-cyan-50 text-cyan-700 border border-cyan-200 text-xs">
                  {ACTION_BY_VALUE[a]?.label || a}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">Manual send only — not auto-linked</p>
          )}
        </div>

        {template.status === 'REJECTED' && template.rejected_reason && (
          <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
            <strong>Rejected:</strong> {template.rejected_reason}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-xs text-gray-400 flex items-center gap-1">
            <BarChart3 className="w-3 h-3" /> Sent {template.send_count || 0}×
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onEditLinks(template)} className="gap-1">
              <Link2 className="w-3.5 h-3.5" /> Links
            </Button>
            <Button
              size="sm"
              onClick={() => onSend(template)}
              disabled={template.status !== 'APPROVED'}
              className="gap-1 bg-green-600 hover:bg-green-700"
            >
              <Send className="w-3.5 h-3.5" /> Send
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}