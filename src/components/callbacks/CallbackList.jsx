import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Phone, Building2, AlertTriangle, ChevronDown, ChevronUp,
  Calendar as CalendarIcon, Star, MessageSquare, Bot
} from 'lucide-react';
import moment from 'moment';

const urgencyStyles = {
  high: 'bg-red-100 text-red-700 border-red-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  low: 'bg-gray-100 text-gray-600 border-gray-200',
};

const confidenceStyles = {
  high: 'bg-green-100 text-green-700',
  medium: 'bg-blue-100 text-blue-700',
  low: 'bg-gray-100 text-gray-500',
};

const tierColors = {
  hot: 'bg-red-500',
  warm: 'bg-orange-500',
  nurture: 'bg-blue-500',
  cold: 'bg-gray-400',
  disqualified: 'bg-gray-300',
};

function CallbackCard({ item, onCall }) {
  const [expanded, setExpanded] = useState(false);
  const ex = item.extracted || {};
  const now = new Date();
  const callbackDate = ex.callback_datetime ? new Date(ex.callback_datetime) : null;
  const isOverdue = callbackDate && callbackDate < now;
  const isToday = callbackDate && moment(callbackDate).isSame(now, 'day');

  return (
    <Card className={`transition-all ${isOverdue ? 'border-red-300 bg-red-50/30' : isToday ? 'border-amber-300 bg-amber-50/30' : ''}`}>
      <CardContent className="p-4">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link to={createPageUrl('LeadDetail') + `?id=${item.lead_id}`} className="font-semibold text-sm truncate text-blue-700 hover:underline">
                {item.lead_name}
              </Link>
              <div className={`w-2 h-2 rounded-full ${tierColors[item.qualification_tier] || 'bg-gray-300'}`} title={item.qualification_tier} />
              {item.lead_score > 0 && (
                <span className="text-xs text-gray-500 flex items-center gap-0.5">
                  <Star className="w-3 h-3" />{item.lead_score}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
              {item.lead_company && (
                <span className="flex items-center gap-1">
                  <Building2 className="w-3 h-3" />{item.lead_company}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Phone className="w-3 h-3" />{item.lead_phone}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Badge className={urgencyStyles[ex.urgency] || urgencyStyles.low} variant="outline">
              {ex.urgency === 'high' && <AlertTriangle className="w-3 h-3 mr-1" />}
              {ex.urgency || 'low'}
            </Badge>
            <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white h-8" onClick={() => onCall(item)}>
              <Phone className="w-3.5 h-3.5 mr-1" /> Call
            </Button>
          </div>
        </div>

        {/* Callback time */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${
            isOverdue ? 'bg-red-100 text-red-700' : isToday ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-700'
          }`}>
            <CalendarIcon className="w-3.5 h-3.5" />
            {ex.callback_description || 'No specific time'}
            {isOverdue && <span className="font-bold ml-1">• OVERDUE</span>}
          </div>
          <Badge className={confidenceStyles[ex.confidence] || confidenceStyles.low}>
            {ex.confidence} confidence
          </Badge>
          {/* Auto-execution badge: shown when a scheduled call/followup Activity
              exists for this lead — the engine will dial automatically at that time. */}
          {item.auto_scheduled && item.auto_scheduled_at && (
            <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 inline-flex items-center gap-1" variant="outline">
              <Bot className="w-3 h-3" />
              Auto-call scheduled · {moment(item.auto_scheduled_at).format('DD MMM, h:mm A')}
            </Badge>
          )}
        </div>

        {/* Reason */}
        <p className="mt-2 text-xs text-gray-600 line-clamp-2">{ex.reason}</p>

        {/* Specific requests */}
        {ex.specific_requests?.length > 0 && (
          <div className="mt-2 flex gap-1.5 flex-wrap">
            {ex.specific_requests.map((r, i) => (
              <Badge key={i} variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                {r}
              </Badge>
            ))}
          </div>
        )}

        {/* Expand for more details */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? 'Less details' : 'More details'}
        </button>

        {expanded && (
          <div className="mt-3 pt-3 border-t space-y-2">
            <div className="text-xs text-gray-500">
              <span className="font-medium text-gray-700">Last Call:</span>{' '}
              {item.call_date ? moment(item.call_date).format('DD MMM YYYY, h:mm A') : 'N/A'}
              {item.call_duration ? ` (${Math.round(item.call_duration)}s)` : ''}
            </div>
            {item.lead_email && (
              <div className="text-xs text-gray-500">
                <span className="font-medium text-gray-700">Email:</span> {item.lead_email}
              </div>
            )}
            {item.intent_signals?.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {item.intent_signals.map((s, i) => (
                  <Badge key={i} variant="outline" className="text-xs">{s.replace(/_/g, ' ')}</Badge>
                ))}
              </div>
            )}
            {item.summary && (
              <div className="text-xs text-gray-600 bg-gray-50 rounded p-2 mt-1">
                <MessageSquare className="w-3 h-3 inline mr-1 text-gray-400" />
                {item.summary}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CallbackList({ callbacks, filter, onCall }) {
  const now = new Date();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  let filtered = [...callbacks];

  if (filter === 'overdue') {
    filtered = filtered.filter(c => c.extracted?.callback_datetime && new Date(c.extracted.callback_datetime) < now);
  } else if (filter === 'today') {
    filtered = filtered.filter(c => {
      if (!c.extracted?.callback_datetime) return false;
      const d = new Date(c.extracted.callback_datetime);
      return d >= todayStart && d <= todayEnd;
    });
  } else if (filter === 'upcoming') {
    filtered = filtered.filter(c => c.extracted?.callback_datetime && new Date(c.extracted.callback_datetime) > now);
  } else if (filter === 'unscheduled') {
    filtered = filtered.filter(c => !c.extracted?.callback_datetime);
  }

  if (filtered.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-gray-500">
          <Phone className="w-10 h-10 mx-auto mb-3 text-gray-300" />
          <p className="font-medium">No callbacks in this category</p>
          <p className="text-sm mt-1">All clear!</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {filtered.map((item) => (
        <CallbackCard key={item.lead_id} item={item} onCall={onCall} />
      ))}
    </div>
  );
}