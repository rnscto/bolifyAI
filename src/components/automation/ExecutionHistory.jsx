import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Clock, Phone, Mail, Calendar, AlertTriangle } from 'lucide-react';
import moment from 'moment';

const statusConfig = {
  completed: { icon: CheckCircle2, color: 'text-green-600', badge: 'bg-green-100 text-green-800' },
  overdue: { icon: XCircle, color: 'text-red-600', badge: 'bg-red-100 text-red-800' },
  cancelled: { icon: XCircle, color: 'text-gray-500', badge: 'bg-gray-100 text-gray-800' },
  no_show: { icon: AlertTriangle, color: 'text-amber-600', badge: 'bg-amber-100 text-amber-800' },
  scheduled: { icon: Clock, color: 'text-blue-600', badge: 'bg-blue-100 text-blue-800' },
};

const typeIcons = { call: Phone, followup: Phone, email: Mail, demo: Calendar, appointment: Calendar, visit: Calendar, meeting: Calendar, task: Clock };

export default function ExecutionHistory({ activities, leads }) {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Execution History (Last 50)</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y max-h-[500px] overflow-y-auto">
          {history.map(activity => {
            const cfg = statusConfig[activity.status] || statusConfig.scheduled;
            const StatusIcon = cfg.icon;
            const TypeIcon = typeIcons[activity.type] || Clock;
            const lead = leadMap[activity.lead_id];

            return (
              <div key={activity.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-start gap-3">
                  <StatusIcon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${cfg.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-gray-900 truncate">{activity.title || activity.type}</span>
                      <Badge className={`text-[10px] ${cfg.badge}`}>{activity.status}</Badge>
                      <TypeIcon className="w-3 h-3 text-gray-400" />
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      {lead && <span className="font-medium text-gray-700">{lead.name}</span>}
                      {activity.outcome && <span className="text-gray-600">→ {activity.outcome}</span>}
                      <span>{moment(activity.completed_date || activity.updated_date).format('DD MMM, hh:mm A')}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}