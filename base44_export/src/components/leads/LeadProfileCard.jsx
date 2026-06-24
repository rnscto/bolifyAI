import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Phone, Mail, Building2, Tag, MessageSquare } from 'lucide-react';
import LeadScoreBadge from './LeadScoreBadge';

const statusColors = {
  new: 'bg-blue-100 text-blue-800',
  contacted: 'bg-purple-100 text-purple-800',
  interested: 'bg-green-100 text-green-800',
  not_interested: 'bg-red-100 text-red-800',
  callback: 'bg-yellow-100 text-yellow-800',
  converted: 'bg-emerald-100 text-emerald-800',
  do_not_call: 'bg-gray-100 text-gray-800'
};

export default function LeadProfileCard({ lead }) {
  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        {/* Score & Status */}
        <div className="flex items-center justify-between">
          <LeadScoreBadge lead={lead} />
          <Badge className={statusColors[lead.status] || 'bg-gray-100 text-gray-800'}>
            {(lead.status || 'new').replace(/_/g, ' ')}
          </Badge>
        </div>

        {/* Contact info */}
        <div className="space-y-2.5 pt-2">
          {lead.phone && (
            <div className="flex items-center gap-2.5 text-sm">
              <Phone className="w-4 h-4 text-gray-400" />
              <span>{lead.phone}</span>
            </div>
          )}
          {lead.email && (
            <div className="flex items-center gap-2.5 text-sm">
              <Mail className="w-4 h-4 text-gray-400" />
              <span className="truncate">{lead.email}</span>
            </div>
          )}
          {lead.company && (
            <div className="flex items-center gap-2.5 text-sm">
              <Building2 className="w-4 h-4 text-gray-400" />
              <span>{lead.company}</span>
            </div>
          )}
          {lead.source && (
            <div className="flex items-center gap-2.5 text-sm">
              <Tag className="w-4 h-4 text-gray-400" />
              <span>{lead.source}</span>
            </div>
          )}
        </div>

        {/* Notes */}
        {lead.notes && (
          <div className="pt-2 border-t">
            <div className="flex items-center gap-1.5 mb-1">
              <MessageSquare className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-xs font-medium text-gray-500">Notes</span>
            </div>
            <p className="text-xs text-gray-600 leading-relaxed">{lead.notes}</p>
          </div>
        )}

        {/* Tags */}
        {lead.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-2 border-t">
            {lead.tags.map(t => (
              <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}