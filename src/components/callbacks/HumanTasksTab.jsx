import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle, CheckCircle2, Clock, Phone, Mail, Users,
  Eye, RefreshCw, ChevronDown, ChevronUp, Star, Building2, Zap
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription
} from '@/components/ui/dialog';
import moment from 'moment';

const TASK_UPDATE_STATUSES = [
  { value: 'demo_done', label: 'Demo Done', color: 'bg-green-100 text-green-700' },
  { value: 'demo_rescheduled', label: 'Demo Rescheduled', color: 'bg-blue-100 text-blue-700' },
  { value: 'meeting_done', label: 'Meeting Done', color: 'bg-green-100 text-green-700' },
  { value: 'meeting_rescheduled', label: 'Meeting Rescheduled', color: 'bg-blue-100 text-blue-700' },
  { value: 'email_sent', label: 'Email/Details Sent', color: 'bg-purple-100 text-purple-700' },
  { value: 'proposal_sent', label: 'Proposal Sent', color: 'bg-indigo-100 text-indigo-700' },
  { value: 'converted', label: 'Converted / Deal Won', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'visit_done', label: 'Visit Completed', color: 'bg-green-100 text-green-700' },
  { value: 'visit_rescheduled', label: 'Visit Rescheduled', color: 'bg-blue-100 text-blue-700' },
  { value: 'not_interested', label: 'Not Interested', color: 'bg-gray-100 text-gray-600' },
  { value: 'no_response', label: 'No Response from Lead', color: 'bg-amber-100 text-amber-700' },
  { value: 'ai_followup', label: 'Send to AI for Follow-up', color: 'bg-cyan-100 text-cyan-700' },
  { value: 'cancelled', label: 'Cancelled', color: 'bg-red-100 text-red-700' },
];

const typeIcons = {
  email: Mail, task: CheckCircle2, demo: Eye, visit: Users,
  meeting: Users, appointment: Clock, booking: Clock,
};

function TaskCard({ activity, lead, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const isOverdue = activity.status === 'overdue';
  const scheduledIST = moment(activity.scheduled_date).format('DD MMM YYYY, h:mm A');
  const Icon = typeIcons[activity.type] || CheckCircle2;
  const hoursPast = (Date.now() - new Date(activity.scheduled_date).getTime()) / 3600000;

  return (
    <Card className={`transition-all ${isOverdue ? 'border-red-300 bg-red-50/40' : 'border-gray-200'}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className={`p-1.5 rounded-md ${isOverdue ? 'bg-red-100' : 'bg-blue-50'}`}>
                <Icon className={`w-4 h-4 ${isOverdue ? 'text-red-600' : 'text-blue-600'}`} />
              </div>
              <span className="font-semibold text-sm text-gray-900 truncate">{activity.title || activity.type}</span>
              <Badge variant="outline" className="text-xs capitalize">{activity.type}</Badge>
              {isOverdue && (
                <Badge className="bg-red-100 text-red-700 border-red-200" variant="outline">
                  <AlertTriangle className="w-3 h-3 mr-1" /> OVERDUE
                </Badge>
              )}
              {activity.priority === 'high' && (
                <Badge className="bg-orange-100 text-orange-700" variant="outline">High Priority</Badge>
              )}
            </div>

            {lead && (
              <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                <span className="flex items-center gap-1 font-medium text-gray-700">
                  <Phone className="w-3 h-3" /> {lead.name || 'Unknown'}
                </span>
                {lead.company && <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{lead.company}</span>}
                {lead.phone && <span>{lead.phone}</span>}
                {lead.score > 0 && <span className="flex items-center gap-0.5"><Star className="w-3 h-3" />{lead.score}</span>}
              </div>
            )}

            <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" /> Scheduled: {scheduledIST}
              </span>
              {isOverdue && <span className="text-red-600 font-medium">{Math.round(hoursPast)}h overdue</span>}
            </div>
          </div>

          <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white shrink-0" onClick={() => onUpdate(activity, lead)}>
            Update
          </Button>
        </div>

        {activity.description && (
          <button onClick={() => setExpanded(!expanded)} className="mt-2 text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'Less' : 'Details'}
          </button>
        )}
        {expanded && activity.description && (
          <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded p-3">{activity.description}</div>
        )}
      </CardContent>
    </Card>
  );
}

export default function HumanTasksTab({ clientId }) {
  const [tasks, setTasks] = useState([]);
  const [leads, setLeads] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [updateDialog, setUpdateDialog] = useState(null);
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateNotes, setUpdateNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const humanTypes = ['email', 'task', 'demo', 'visit', 'meeting', 'appointment', 'booking'];

  useEffect(() => {
    if (clientId) loadTasks();
  }, [clientId]);

  const loadTasks = async () => {
    setLoading(true);
    const svc = base44;
    const [scheduled, overdue] = await Promise.all([
      svc.entities.Activity.filter({ client_id: clientId, status: 'scheduled' }, 'scheduled_date', 200),
      svc.entities.Activity.filter({ client_id: clientId, status: 'overdue' }, 'scheduled_date', 200),
    ]);
    const allTasks = [...scheduled, ...overdue].filter(a => humanTypes.includes(a.type));
    setTasks(allTasks);

    // Load leads in parallel (avoids N+1 sequential round-trips that blocked render)
    const leadIds = [...new Set(allTasks.map(t => t.lead_id).filter(Boolean))];
    const leadMap = {};
    const fetched = await Promise.all(
      leadIds.map(lid => svc.entities.Lead.get(lid).catch(() => null))
    );
    leadIds.forEach((lid, i) => { if (fetched[i]) leadMap[lid] = fetched[i]; });
    setLeads(leadMap);
    setLoading(false);
  };

  const handleOpenUpdate = (activity, lead) => {
    setUpdateDialog({ activity, lead });
    setUpdateStatus('');
    setUpdateNotes('');
  };

  const handleSaveUpdate = async () => {
    if (!updateStatus || !updateDialog) return;
    setSaving(true);

    const { activity, lead } = updateDialog;
    const statusConfig = TASK_UPDATE_STATUSES.find(s => s.value === updateStatus);

    // Determine activity final status
    const completedStatuses = ['demo_done', 'meeting_done', 'email_sent', 'proposal_sent', 'converted', 'visit_done', 'not_interested', 'cancelled'];
    const rescheduleStatuses = ['demo_rescheduled', 'meeting_rescheduled', 'visit_rescheduled', 'no_response'];
    const aiFollowup = updateStatus === 'ai_followup';

    const newActivityStatus = completedStatuses.includes(updateStatus) ? 'completed' : 'scheduled';
    const noteAppend = `\n[Admin Update: ${statusConfig.label}] ${updateNotes || ''} — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

    await apiClient.Activity.update(activity.id, {
      status: newActivityStatus,
      completed_date: newActivityStatus === 'completed' ? new Date().toISOString() : undefined,
      outcome: statusConfig.label,
      notes: (activity.notes || '') + noteAppend,
    });

    // Update lead status based on outcome
    if (lead?.id) {
      const leadUpdates = {};
      if (updateStatus === 'converted') {
        leadUpdates.status = 'converted';
        leadUpdates.qualification_tier = 'hot';
      } else if (updateStatus === 'not_interested') {
        leadUpdates.status = 'not_interested';
      } else if (['demo_done', 'meeting_done', 'visit_done', 'email_sent', 'proposal_sent'].includes(updateStatus)) {
        leadUpdates.status = 'interested';
        leadUpdates.last_engagement_date = new Date().toISOString();
      }
      if (Object.keys(leadUpdates).length > 0) {
        await apiClient.Lead.update(lead.id, leadUpdates);
      }
    }

    // If AI follow-up requested, create a new call activity for the automation engine
    if (aiFollowup && lead?.id) {
      const followupDate = new Date();
      followupDate.setHours(followupDate.getHours() + 2);
      await apiClient.Activity.create({
        client_id: clientId,
        lead_id: lead.id,
        type: 'call',
        title: `AI Follow-up: ${lead.name || 'Lead'} (re-assigned by admin)`,
        description: `Admin requested AI to take over follow-up.\nOriginal task: ${activity.title}\nAdmin notes: ${updateNotes || 'N/A'}`,
        scheduled_date: followupDate.toISOString(),
        status: 'scheduled',
        priority: 'high',
        auto_created: true,
      });
      // Mark original as completed
      await apiClient.Activity.update(activity.id, { status: 'completed', outcome: 'Reassigned to AI' });
    }

    // If rescheduled, create a new activity for tomorrow
    if (rescheduleStatuses.includes(updateStatus) && !aiFollowup && lead?.id) {
      const newDate = new Date();
      newDate.setDate(newDate.getDate() + 1);
      newDate.setHours(10, 0, 0, 0);
      await apiClient.Activity.create({
        client_id: clientId,
        lead_id: lead.id,
        type: activity.type,
        title: `[Rescheduled] ${activity.title || activity.type}`,
        description: `Rescheduled from ${moment(activity.scheduled_date).format('DD MMM')}.\nReason: ${statusConfig.label}\nNotes: ${updateNotes || 'N/A'}`,
        scheduled_date: newDate.toISOString(),
        status: 'scheduled',
        priority: activity.priority || 'medium',
        auto_created: true,
      });
    }

    setSaving(false);
    setUpdateDialog(null);
    loadTasks();
  };

  const filteredTasks = tasks.filter(t => {
    if (filter === 'overdue') return t.status === 'overdue';
    if (filter === 'pending') return t.status === 'scheduled';
    return true;
  });

  const overdueCount = tasks.filter(t => t.status === 'overdue').length;
  const pendingCount = tasks.filter(t => t.status === 'scheduled').length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter('all')}>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50"><Zap className="w-5 h-5 text-blue-600" /></div>
            <div>
              <p className="text-2xl font-bold">{tasks.length}</p>
              <p className="text-xs text-gray-500">Total Tasks</p>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter('overdue')}>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-50"><AlertTriangle className="w-5 h-5 text-red-600" /></div>
            <div>
              <p className="text-2xl font-bold text-red-600">{overdueCount}</p>
              <p className="text-xs text-gray-500">Overdue</p>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter('pending')}>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-50"><Clock className="w-5 h-5 text-amber-600" /></div>
            <div>
              <p className="text-2xl font-bold text-amber-600">{pendingCount}</p>
              <p className="text-xs text-gray-500">Pending</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {['all', 'overdue', 'pending'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${filter === f ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'}`}>
            {f === 'all' ? 'All' : f === 'overdue' ? `Overdue (${overdueCount})` : `Pending (${pendingCount})`}
          </button>
        ))}
        <Button variant="outline" size="sm" className="ml-auto" onClick={loadTasks}>
          <RefreshCw className="w-4 h-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Task list */}
      {filteredTasks.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-gray-500">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-green-400" />
            <p className="font-medium">No tasks in this category</p>
            <p className="text-sm mt-1">All caught up!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredTasks.map(t => (
            <TaskCard key={t.id} activity={t} lead={leads[t.lead_id]} onUpdate={handleOpenUpdate} />
          ))}
        </div>
      )}

      {/* Update Dialog */}
      <Dialog open={!!updateDialog} onOpenChange={() => setUpdateDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update Task</DialogTitle>
            <DialogDescription>
              {updateDialog?.activity?.title || 'Update task status'}
            </DialogDescription>
          </DialogHeader>

          {updateDialog?.lead && (
            <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
              <Phone className="w-4 h-4" />
              <span className="font-medium">{updateDialog.lead.name}</span>
              <span className="text-gray-400">•</span>
              <span>{updateDialog.lead.phone}</span>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1.5 block">Status Update</label>
              <Select value={updateStatus} onValueChange={setUpdateStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Select outcome..." />
                </SelectTrigger>
                <SelectContent>
                  {TASK_UPDATE_STATUSES.map(s => (
                    <SelectItem key={s.value} value={s.value}>
                      <span className="flex items-center gap-2">
                        {s.value === 'ai_followup' && <Zap className="w-3 h-3 text-cyan-600" />}
                        {s.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {updateStatus === 'ai_followup' && (
              <div className="p-3 bg-cyan-50 border border-cyan-200 rounded-lg text-xs text-cyan-800">
                <Zap className="w-4 h-4 inline mr-1" />
                AI will automatically call this lead within 2 hours for follow-up using the same agent.
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-gray-700 mb-1.5 block">Notes (optional)</label>
              <Textarea value={updateNotes} onChange={e => setUpdateNotes(e.target.value)} placeholder="Add any notes about the outcome..." rows={3} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdateDialog(null)}>Cancel</Button>
            <Button onClick={handleSaveUpdate} disabled={!updateStatus || saving} className="bg-blue-600 hover:bg-blue-700">
              {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null}
              Save Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}