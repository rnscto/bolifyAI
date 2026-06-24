import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  PhoneCall, PhoneOutgoing, PhoneIncoming, PhoneMissed,
  Mail, Calendar, Clock, Activity, Megaphone,
  ChevronDown, ChevronUp, Play, FileText
} from 'lucide-react';
import AudioPlayer from '../calls/AudioPlayer';

const typeFilters = [
  { key: 'all', label: 'All' },
  { key: 'call', label: 'Calls' },
  { key: 'email', label: 'Emails' },
  { key: 'activity', label: 'Activities' },
  { key: 'campaign', label: 'Campaigns' },
];

function buildTimelineItems(callLogs, activities, outreachLogs, campaignLeads) {
  const items = [];

  callLogs.forEach(c => {
    items.push({
      id: c.id,
      type: 'call',
      date: c.call_start_time || c.created_date,
      title: c.status === 'no_answer' ? 'Missed Call' :
             c.status === 'failed' ? 'Failed Call' :
             `${c.direction === 'inbound' ? 'Inbound' : 'Outbound'} Call`,
      subtitle: c.conversation_summary || null,
      status: c.status,
      duration: c.duration,
      direction: c.direction,
      transcript: c.transcript,
      recording_url: c.recording_url,
      lead_status_updated: c.lead_status_updated,
      raw: c,
    });
  });

  outreachLogs.forEach(o => {
    items.push({
      id: o.id,
      type: 'email',
      date: o.created_date,
      title: o.subject || 'Email Sent',
      subtitle: o.outreach_type?.replace(/_/g, ' ') || null,
      status: o.status,
      body: o.body,
      channel: o.channel,
      raw: o,
    });
  });

  activities.forEach(a => {
    items.push({
      id: a.id,
      type: 'activity',
      date: a.scheduled_date || a.created_date,
      title: a.title || a.type,
      subtitle: a.description || null,
      status: a.status,
      activityType: a.type,
      priority: a.priority,
      auto_created: a.auto_created,
      raw: a,
    });
  });

  campaignLeads.forEach(cl => {
    items.push({
      id: cl.id,
      type: 'campaign',
      date: cl.created_date,
      title: `Campaign: ${cl.outcome || cl.status}`,
      subtitle: cl.conversation_summary || null,
      status: cl.status,
      outcome: cl.outcome,
      attempt_count: cl.attempt_count,
      raw: cl,
    });
  });

  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items;
}

function TimelineItem({ item }) {
  const [expanded, setExpanded] = useState(false);

  const iconMap = {
    call: item.status === 'no_answer' || item.status === 'failed'
      ? PhoneMissed
      : item.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing,
    email: Mail,
    activity: item.activityType === 'call' ? PhoneCall : item.activityType === 'followup' ? Clock : Calendar,
    campaign: Megaphone,
  };
  const colorMap = {
    call: item.status === 'completed' ? 'bg-green-100 text-green-600' : item.status === 'no_answer' || item.status === 'failed' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600',
    email: 'bg-purple-100 text-purple-600',
    activity: item.status === 'completed' ? 'bg-green-100 text-green-600' : item.status === 'overdue' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600',
    campaign: 'bg-indigo-100 text-indigo-600',
  };

  const Icon = iconMap[item.type];
  const color = colorMap[item.type];
  const hasExtra = item.transcript || item.recording_url || item.body || item.subtitle;

  const formatDuration = (s) => {
    if (!s) return null;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div className="flex gap-3">
      {/* Icon */}
      <div className="flex flex-col items-center">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="w-px flex-1 bg-gray-200 mt-1" />
      </div>

      {/* Content */}
      <div className="pb-6 flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">{item.title}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {new Date(item.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {item.type === 'call' && item.duration > 0 && (
              <Badge variant="outline" className="text-[10px]">{formatDuration(item.duration)}</Badge>
            )}
            {item.status && (
              <Badge variant="secondary" className="text-[10px] capitalize">
                {item.status.replace(/_/g, ' ')}
              </Badge>
            )}
            {item.priority && (
              <Badge variant={item.priority === 'high' ? 'destructive' : 'outline'} className="text-[10px]">
                {item.priority}
              </Badge>
            )}
            {item.auto_created && (
              <Badge variant="outline" className="text-[10px] text-blue-500 border-blue-200">AI</Badge>
            )}
          </div>
        </div>

        {/* Summary preview */}
        {item.subtitle && !expanded && (
          <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.subtitle}</p>
        )}

        {/* Expand button */}
        {hasExtra && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-blue-600 hover:text-blue-700 mt-1.5 flex items-center gap-1"
          >
            {expanded ? <><ChevronUp className="w-3 h-3" /> Less</> : <><ChevronDown className="w-3 h-3" /> More</>}
          </button>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="mt-2 space-y-2">
            {item.subtitle && (
              <p className="text-xs text-gray-600 bg-gray-50 p-2.5 rounded-lg whitespace-pre-wrap">{item.subtitle}</p>
            )}
            {item.lead_status_updated && (
              <div className="text-xs">
                <span className="text-gray-400">Lead status → </span>
                <Badge variant="outline" className="text-[10px]">{item.lead_status_updated}</Badge>
              </div>
            )}
            {item.transcript && (
              <div>
                <div className="flex items-center gap-1 mb-1">
                  <FileText className="w-3 h-3 text-gray-400" />
                  <span className="text-[10px] font-medium text-gray-500">Transcript</span>
                </div>
                <div className="text-xs bg-gray-50 p-2.5 rounded-lg max-h-40 overflow-y-auto whitespace-pre-wrap text-gray-600">
                  {item.transcript}
                </div>
              </div>
            )}
            {item.recording_url && (
              <AudioPlayer url={item.recording_url} />
            )}
            {item.body && item.type === 'email' && (
              <div className="text-xs bg-gray-50 p-2.5 rounded-lg max-h-40 overflow-y-auto" dangerouslySetInnerHTML={{ __html: item.body }} />
            )}
            {item.type === 'campaign' && (
              <div className="text-xs text-gray-500">
                Attempts: {item.attempt_count || 1} · Outcome: {item.outcome || '-'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LeadTimeline({ callLogs, activities, outreachLogs, campaignLeads, lead }) {
  const [filter, setFilter] = useState('all');
  const items = buildTimelineItems(callLogs, activities, outreachLogs, campaignLeads);
  const filtered = filter === 'all' ? items : items.filter(i => i.type === filter);

  const counts = {
    all: items.length,
    call: items.filter(i => i.type === 'call').length,
    email: items.filter(i => i.type === 'email').length,
    activity: items.filter(i => i.type === 'activity').length,
    campaign: items.filter(i => i.type === 'campaign').length,
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-600" />
            Interaction Timeline
          </CardTitle>
        </div>
        <div className="flex gap-1.5 flex-wrap pt-2">
          {typeFilters.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
              <span className={`ml-1 ${filter === f.key ? 'text-blue-200' : 'text-gray-400'}`}>
                {counts[f.key]}
              </span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <Activity className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No interactions yet</p>
          </div>
        ) : (
          <div className="mt-1">
            {filtered.map(item => (
              <TimelineItem key={`${item.type}-${item.id}`} item={item} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}