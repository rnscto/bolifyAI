import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Phone, Mail, Calendar, MapPin, Users, FileText, Clock } from 'lucide-react';
import moment from 'moment';

const typeIcons = {
  call: Phone,
  followup: Phone,
  email: Mail,
  demo: Calendar,
  appointment: Calendar,
  visit: MapPin,
  meeting: Users,
  booking: Calendar,
  task: FileText,
};

const typeBadgeColors = {
  call: 'bg-blue-100 text-blue-800',
  followup: 'bg-indigo-100 text-indigo-800',
  email: 'bg-purple-100 text-purple-800',
  demo: 'bg-pink-100 text-pink-800',
  appointment: 'bg-amber-100 text-amber-800',
  visit: 'bg-green-100 text-green-800',
  meeting: 'bg-cyan-100 text-cyan-800',
  task: 'bg-gray-100 text-gray-800',
};

const priorityColors = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-yellow-100 text-yellow-800',
  low: 'bg-green-100 text-green-800',
};

export default function UpcomingQueue({ activities, leads }) {
  const upcoming = activities
    .filter(a => a.status === 'scheduled')
    .sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date));

  const leadMap = {};
  leads.forEach(l => { leadMap[l.id] = l; });

  if (upcoming.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Upcoming Queue</CardTitle></CardHeader>
        <CardContent>
          <p className="text-gray-500 text-sm text-center py-8">No scheduled follow-ups in the queue.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Upcoming Queue ({upcoming.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y max-h-[500px] overflow-y-auto">
          {upcoming.map(activity => {
            const Icon = typeIcons[activity.type] || FileText;
            const lead = leadMap[activity.lead_id];
            const isOverdue = new Date(activity.scheduled_date) < new Date();
            const isHumanAction = ['appointment', 'demo', 'visit', 'meeting', 'booking'].includes(activity.type);

            return (
              <div key={activity.id} className={`p-4 hover:bg-gray-50 ${isOverdue ? 'bg-red-50/50' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isHumanAction ? 'bg-orange-100' : 'bg-blue-100'}`}>
                    <Icon className={`w-4 h-4 ${isHumanAction ? 'text-orange-600' : 'text-blue-600'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-gray-900 truncate">{activity.title || activity.type}</span>
                      <Badge className={`text-[10px] ${typeBadgeColors[activity.type] || 'bg-gray-100 text-gray-800'}`}>
                        {activity.type}
                      </Badge>
                      <Badge className={`text-[10px] ${priorityColors[activity.priority] || priorityColors.medium}`}>
                        {activity.priority || 'medium'}
                      </Badge>
                      {isHumanAction && (
                        <Badge className="text-[10px] bg-orange-100 text-orange-800">Human Action</Badge>
                      )}
                      {isOverdue && (
                        <Badge className="text-[10px] bg-red-100 text-red-800">Overdue</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      {lead && <span className="font-medium text-gray-700">{lead.name}</span>}
                      {lead?.phone && <span>{lead.phone}</span>}
                      <span>📅 {moment(activity.scheduled_date).format('DD MMM, hh:mm A')}</span>
                      <span className="text-gray-400">{moment(activity.scheduled_date).fromNow()}</span>
                    </div>
                    {activity.description && (
                      <p className="text-xs text-gray-500 mt-1 line-clamp-1">{activity.description}</p>
                    )}
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