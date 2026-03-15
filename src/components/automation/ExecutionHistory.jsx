import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Clock, Phone, Mail, Calendar, AlertTriangle, User, ChevronDown, ChevronUp } from 'lucide-react';
import moment from 'moment';

const statusConfig = {
  completed: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50', badge: 'bg-green-100 text-green-800', label: 'Completed' },
  overdue: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50', badge: 'bg-red-100 text-red-800', label: 'Overdue' },
  cancelled: { icon: XCircle, color: 'text-gray-500', bg: 'bg-gray-50', badge: 'bg-gray-100 text-gray-700', label: 'Cancelled' },
  no_show: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50', badge: 'bg-amber-100 text-amber-800', label: 'No Show' },
  scheduled: { icon: Clock, color: 'text-blue-600', bg: 'bg-blue-50', badge: 'bg-blue-100 text-blue-800', label: 'Scheduled' },
};

const typeConfig = {
  call: { icon: Phone, label: 'Call', color: 'text-blue-600 bg-blue-50' },
  followup: { icon: Phone, label: 'Follow-up', color: 'text-indigo-600 bg-indigo-50' },
  email: { icon: Mail, label: 'Email', color: 'text-purple-600 bg-purple-50' },
  demo: { icon: Calendar, label: 'Demo', color: 'text-teal-600 bg-teal-50' },
  appointment: { icon: Calendar, label: 'Appointment', color: 'text-green-600 bg-green-50' },
  visit: { icon: Calendar, label: 'Visit', color: 'text-orange-600 bg-orange-50' },
  meeting: { icon: Calendar, label: 'Meeting', color: 'text-cyan-600 bg-cyan-50' },
  task: { icon: Clock, label: 'Task', color: 'text-gray-600 bg-gray-100' },
  booking: { icon: Calendar, label: 'Booking', color: 'text-pink-600 bg-pink-50' },
};

export default function ExecutionHistory({ activities, leads }) {
  const [expandedId, setExpandedId] = useState(null);

  const history = activities
    .filter(a => ['completed', 'overdue', 'cancelled', 'no_show'].includes(a.status))
    .sort((a, b) => new Date(b.completed_date || b.updated_date) - new Date(a.completed_date || a.updated_date))
    .slice(0, 50);

  const leadMap = {};
  leads.forEach(l => { leadMap[l.id] = l; });

  if (history.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Execution History</CardTitle></CardHeader>
        <CardContent>
          <p className="text-gray-500 text-sm text-center py-8">No execution history yet.</p>
        </CardContent>
      </Card>
    );
  }

  const counts = { completed: 0, overdue: 0, cancelled: 0, no_show: 0 };
  history.forEach(a => { if (counts[a.status] !== undefined) counts[a.status]++; });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base">Execution History (Last 50)</CardTitle>
          <div className="flex gap-2 flex-wrap">
            {counts.completed > 0 && <Badge className="bg-green-100 text-green-800 text-xs">{counts.completed} completed</Badge>}
            {counts.overdue > 0 && <Badge className="bg-red-100 text-red-800 text-xs">{counts.overdue} overdue</Badge>}
            {counts.cancelled > 0 && <Badge className="bg-gray-100 text-gray-700 text-xs">{counts.cancelled} cancelled</Badge>}
            {counts.no_show > 0 && <Badge className="bg-amber-100 text-amber-800 text-xs">{counts.no_show} no-show</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {/* Table header */}
        <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2 bg-gray-50 border-y text-xs font-medium text-gray-500 uppercase tracking-wider">
          <div className="col-span-1">Status</div>
          <div className="col-span-3">Lead</div>
          <div className="col-span-3">Activity</div>
          <div className="col-span-2">Outcome</div>
          <div className="col-span-2">When</div>
          <div className="col-span-1"></div>
        </div>

        <div className="divide-y max-h-[500px] overflow-y-auto">
          {history.map(activity => {
            const cfg = statusConfig[activity.status] || statusConfig.scheduled;
            const StatusIcon = cfg.icon;
            const tCfg = typeConfig[activity.type] || typeConfig.task;
            const TypeIcon = tCfg.icon;
            const lead = leadMap[activity.lead_id];
            const isExpanded = expandedId === activity.id;
            const ts = activity.completed_date || activity.updated_date;

            return (
              <div key={activity.id}>
                {/* Desktop row */}
                <div
                  className="hidden sm:grid grid-cols-12 gap-2 px-4 py-3 items-center hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : activity.id)}
                >
                  <div className="col-span-1">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center ${cfg.bg}`}>
                      <StatusIcon className={`w-3.5 h-3.5 ${cfg.color}`} />
                    </div>
                  </div>
                  <div className="col-span-3 min-w-0">
                    {lead ? (
                      <div>
                        <p className="text-sm font-medium text-gray-900 truncate">{lead.name}</p>
                        <p className="text-xs text-gray-500 truncate">{lead.phone || lead.email || ''}</p>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400 italic">No lead linked</span>
                    )}
                  </div>
                  <div className="col-span-3 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${tCfg.color}`}>
                        <TypeIcon className="w-3 h-3" />
                        {tCfg.label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 truncate mt-0.5" title={activity.title}>{activity.title}</p>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <Badge className={`text-[10px] ${cfg.badge}`}>{cfg.label}</Badge>
                    {activity.outcome && (
                      <p className="text-[11px] text-gray-500 mt-0.5 truncate" title={activity.outcome}>{activity.outcome}</p>
                    )}
                  </div>
                  <div className="col-span-2">
                    <p className="text-xs text-gray-700">{moment(ts).format('DD MMM YYYY')}</p>
                    <p className="text-[11px] text-gray-400">{moment(ts).format('hh:mm A')}</p>
                  </div>
                  <div className="col-span-1 flex justify-end">
                    {(activity.notes || activity.description) && (
                      isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                </div>

                {/* Mobile row */}
                <div
                  className="sm:hidden p-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : activity.id)}
                >
                  <div className="flex items-start gap-2.5">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${cfg.bg}`}>
                      <StatusIcon className={`w-3.5 h-3.5 ${cfg.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium text-gray-900 truncate">{lead?.name || 'Unknown'}</span>
                        <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${tCfg.color}`}>
                          <TypeIcon className="w-2.5 h-2.5" />
                          {tCfg.label}
                        </span>
                        <Badge className={`text-[10px] ${cfg.badge}`}>{cfg.label}</Badge>
                      </div>
                      <p className="text-xs text-gray-600 truncate mt-0.5">{activity.title}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">{moment(ts).format('DD MMM, hh:mm A')}</p>
                    </div>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (activity.notes || activity.description || activity.outcome) && (
                  <div className="px-4 sm:pl-16 pb-3 bg-gray-50 border-t border-dashed border-gray-200">
                    <div className="py-2 space-y-1.5">
                      {activity.outcome && (
                        <div>
                          <span className="text-[10px] font-semibold text-gray-500 uppercase">Result:</span>
                          <p className="text-xs text-gray-700">{activity.outcome}</p>
                        </div>
                      )}
                      {activity.description && (
                        <div>
                          <span className="text-[10px] font-semibold text-gray-500 uppercase">Details:</span>
                          <p className="text-xs text-gray-600 whitespace-pre-line">{activity.description}</p>
                        </div>
                      )}
                      {activity.notes && (
                        <div>
                          <span className="text-[10px] font-semibold text-gray-500 uppercase">Notes:</span>
                          <p className="text-xs text-gray-600 whitespace-pre-line">{activity.notes}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}