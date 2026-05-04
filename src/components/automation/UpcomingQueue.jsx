import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Phone, Mail, Calendar, MapPin, Users, FileText, Clock, Search, ArrowDownUp } from 'lucide-react';
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
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all'); // all | overdue | today | tomorrow | this_week | upcoming
  const [sortOrder, setSortOrder] = useState('asc'); // asc = soonest first, desc = latest first

  const leadMap = useMemo(() => {
    const m = {};
    leads.forEach(l => { m[l.id] = l; });
    return m;
  }, [leads]);

  const filtered = useMemo(() => {
    const now = new Date();
    const startOfToday = moment().startOf('day');
    const endOfToday = moment().endOf('day');
    const startOfTomorrow = moment().add(1, 'day').startOf('day');
    const endOfTomorrow = moment().add(1, 'day').endOf('day');
    const endOfWeek = moment().endOf('week');

    return activities
      .filter(a => a.status === 'scheduled')
      .filter(a => typeFilter === 'all' || a.type === typeFilter)
      .filter(a => priorityFilter === 'all' || (a.priority || 'medium') === priorityFilter)
      .filter(a => {
        if (dateFilter === 'all') return true;
        const d = moment(a.scheduled_date);
        if (dateFilter === 'overdue') return new Date(a.scheduled_date) < now;
        if (dateFilter === 'today') return d.isBetween(startOfToday, endOfToday, null, '[]');
        if (dateFilter === 'tomorrow') return d.isBetween(startOfTomorrow, endOfTomorrow, null, '[]');
        if (dateFilter === 'this_week') return d.isBetween(startOfToday, endOfWeek, null, '[]');
        if (dateFilter === 'upcoming') return new Date(a.scheduled_date) >= now;
        return true;
      })
      .filter(a => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        const lead = leadMap[a.lead_id];
        return (
          (a.title || '').toLowerCase().includes(q) ||
          (a.description || '').toLowerCase().includes(q) ||
          (lead?.name || '').toLowerCase().includes(q) ||
          (lead?.phone || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const diff = new Date(a.scheduled_date) - new Date(b.scheduled_date);
        return sortOrder === 'asc' ? diff : -diff;
      });
  }, [activities, leadMap, search, typeFilter, priorityFilter, dateFilter, sortOrder]);

  // Group by day for date-wise sequence display
  const grouped = useMemo(() => {
    const groups = {};
    filtered.forEach(a => {
      const dayKey = moment(a.scheduled_date).format('YYYY-MM-DD');
      if (!groups[dayKey]) groups[dayKey] = [];
      groups[dayKey].push(a);
    });
    const orderedKeys = Object.keys(groups).sort((a, b) =>
      sortOrder === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
    );
    return orderedKeys.map(k => ({ key: k, items: groups[k] }));
  }, [filtered, sortOrder]);

  const allTypes = useMemo(() => {
    const s = new Set();
    activities.forEach(a => { if (a.status === 'scheduled') s.add(a.type); });
    return Array.from(s).sort();
  }, [activities]);

  const formatDayLabel = (key) => {
    const d = moment(key);
    if (d.isSame(moment(), 'day')) return `Today — ${d.format('DD MMM YYYY')}`;
    if (d.isSame(moment().add(1, 'day'), 'day')) return `Tomorrow — ${d.format('DD MMM YYYY')}`;
    if (d.isSame(moment().subtract(1, 'day'), 'day')) return `Yesterday — ${d.format('DD MMM YYYY')}`;
    return d.format('dddd, DD MMM YYYY');
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Upcoming Queue ({filtered.length})
          </CardTitle>
        </div>

        {/* Filters Row */}
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="Search title, lead, phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>

          <Select value={dateFilter} onValueChange={setDateFilter}>
            <SelectTrigger className="w-[140px] h-9"><SelectValue placeholder="Date" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Dates</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="tomorrow">Tomorrow</SelectItem>
              <SelectItem value="this_week">This Week</SelectItem>
              <SelectItem value="upcoming">Upcoming Only</SelectItem>
            </SelectContent>
          </Select>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {allTypes.map(t => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue placeholder="Priority" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priority</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>

          <Select value={sortOrder} onValueChange={setSortOrder}>
            <SelectTrigger className="w-[150px] h-9">
              <ArrowDownUp className="w-3.5 h-3.5 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asc">Soonest First</SelectItem>
              <SelectItem value="desc">Latest First</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-12">No activities match your filters.</p>
        ) : (
          <div className="divide-y">
            {grouped.map(group => (
              <div key={group.key}>
                <div className="bg-gray-50 px-4 py-2 sticky top-0 z-10 border-b">
                  <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                    {formatDayLabel(group.key)} <span className="text-gray-400 normal-case font-normal ml-1">· {group.items.length}</span>
                  </h4>
                </div>
                {group.items.map(activity => {
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
                          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
                            {lead && <span className="font-medium text-gray-700">{lead.name}</span>}
                            {lead?.phone && <span>{lead.phone}</span>}
                            <span>📅 {moment(activity.scheduled_date).format('DD MMM, hh:mm A')}</span>
                            <span className="text-gray-400">{moment(activity.scheduled_date).fromNow()}</span>
                          </div>
                          {activity.description && (
                            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{activity.description}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}