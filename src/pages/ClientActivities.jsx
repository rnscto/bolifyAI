import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Calendar, CheckCircle2, XCircle, Mail, AlertCircle, Edit2, Filter } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import FeatureGate from '../components/FeatureGate';
import EmailComposer from '../components/email/EmailComposer';

export default function ClientActivities() {
  const [activities, setActivities] = useState([]);
  const [leads, setLeads] = useState([]);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [emailComposerOpen, setEmailComposerOpen] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState(null);
  const [selectedLead, setSelectedLead] = useState(null);

  // Filtering states
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  // Edit dialog states
  const [editActivity, setEditActivity] = useState(null);
  const [editStatus, setEditStatus] = useState('');
  const [editDate, setEditDate] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await apiClient.auth.me();
      if (user.role === 'admin' || user.role === 'master_admin') {
         // Block admins explicitly as requested
         return;
      }

      const clients = await apiClient.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const [activitiesData, leadsData] = await Promise.all([
          apiClient.Activity.filter({ client_id: clientData.id }, '-scheduled_date', 500),
          apiClient.Lead.filter({ client_id: clientData.id }, '-created_at', 1000)
        ]);

        setActivities(activitiesData);
        setLeads(leadsData);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getLeadName = (leadId) => {
    const lead = leads.find(l => l.id === leadId);
    return lead?.name || '-';
  };

  const getLead = (leadId) => leads.find(l => l.id === leadId);

  const openEmailComposer = (activity) => {
    setSelectedActivity(activity);
    setSelectedLead(getLead(activity.lead_id));
    setEmailComposerOpen(true);
  };

  const isHumanEmailAction = (activity) => {
    // Activities that need human to compose an email
    const humanTypes = ['email', 'appointment', 'demo', 'visit', 'meeting', 'booking'];
    return humanTypes.includes(activity.type) && 
           activity.status === 'scheduled' && 
           getLead(activity.lead_id)?.email;
  };

  const statusColors = {
    scheduled: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    cancelled: 'bg-red-100 text-red-800',
    no_show: 'bg-gray-100 text-gray-800',
    overdue: 'bg-red-100 text-red-800'
  };

  const typeColors = {
    appointment: 'bg-purple-100 text-purple-800',
    booking: 'bg-blue-100 text-blue-800',
    demo: 'bg-green-100 text-green-800',
    visit: 'bg-orange-100 text-orange-800',
    followup: 'bg-yellow-100 text-yellow-800',
    email: 'bg-indigo-100 text-indigo-800',
    call: 'bg-emerald-100 text-emerald-800',
    task: 'bg-amber-100 text-amber-800',
    meeting: 'bg-pink-100 text-pink-800'
  };

  const upcoming = activities.filter(a => 
    a.status === 'scheduled' && new Date(a.scheduled_date) > new Date()
  );

  const handleUpdateActivity = async () => {
    if (!editActivity) return;
    try {
      await apiClient.Activity.update(editActivity.id, {
        status: editStatus,
        scheduled_date: new Date(editDate).toISOString()
      });
      toast.success("Activity updated successfully");
      setEditActivity(null);
      loadData();
    } catch (err) {
      toast.error(err.message || "Failed to update activity");
    }
  };

  const openEditDialog = (activity) => {
    setEditActivity(activity);
    setEditStatus(activity.status || 'scheduled');
    // Format date for datetime-local input
    if (activity.scheduled_date) {
      const d = new Date(activity.scheduled_date);
      // yyyy-MM-ddThh:mm
      const local = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
      setEditDate(local);
    } else {
      setEditDate('');
    }
  };

  const filteredActivities = activities.filter(a => {
    let match = true;
    if (filterType !== 'all' && a.type !== filterType) match = false;
    
    if (filterStatus !== 'all') {
      if (filterStatus === 'overdue') {
        if (a.status !== 'scheduled' || new Date(a.scheduled_date) >= new Date()) match = false;
      } else if (filterStatus === 'upcoming') {
        if (a.status !== 'scheduled' || new Date(a.scheduled_date) <= new Date()) match = false;
      } else {
        if (a.status !== filterStatus) match = false;
      }
    }
    return match;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <FeatureGate client={client} featureName="Activities">
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Activities</h1>
        <p className="text-gray-600 mt-1">Track appointments, demos, and follow-ups</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Calendar className="w-8 h-8 text-blue-600" />
              <div>
                <p className="text-2xl font-bold">{upcoming.length}</p>
                <p className="text-sm text-gray-600">Upcoming</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
              <div>
                <p className="text-2xl font-bold">
                  {activities.filter(a => a.status === 'completed').length}
                </p>
                <p className="text-sm text-gray-600">Completed</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <XCircle className="w-8 h-8 text-red-600" />
              <div>
                <p className="text-2xl font-bold">
                  {activities.filter(a => a.status === 'no_show').length}
                </p>
                <p className="text-sm text-gray-600">No Shows</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
          <CardTitle>All Activities</CardTitle>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Filter className="w-4 h-4 text-gray-400" />
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-32 h-8 text-xs">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {Object.keys(typeColors).map(type => (
                    <SelectItem key={type} value={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-36 h-8 text-xs">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="upcoming">Upcoming</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="no_show">No Show</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Scheduled Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredActivities.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500 py-8">
                    No activities found matching filters
                  </TableCell>
                </TableRow>
              ) : (
                filteredActivities.map((activity) => (
                  <TableRow key={activity.id} className={isHumanEmailAction(activity) ? 'bg-amber-50/50' : ''}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge className={typeColors[activity.type] || 'bg-gray-100 text-gray-800'}>
                          {activity.type}
                        </Badge>
                        {isHumanEmailAction(activity) && (
                          <AlertCircle className="w-3.5 h-3.5 text-amber-500" title="Action needed" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">{activity.title}</TableCell>
                    <TableCell>
                      {activity.lead_id ? (
                        <Link to={createPageUrl('LeadDetail') + `?id=${activity.lead_id}`} className="text-blue-600 hover:underline">
                          {getLeadName(activity.lead_id)}
                        </Link>
                      ) : '-'}
                    </TableCell>
                    <TableCell>
                      {new Date(activity.scheduled_date).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[activity.status] || 'bg-gray-100 text-gray-800'}>
                        {(activity.status || '').replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-gray-500">
                      {activity.notes || '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {isHumanEmailAction(activity) && (
                          <Button
                            size="sm" variant="outline"
                            className="gap-1 text-blue-700 border-blue-200 hover:bg-blue-50"
                            onClick={() => openEmailComposer(activity)}
                          >
                            <Mail className="w-3.5 h-3.5" /> Compose
                          </Button>
                        )}
                        <Button
                          size="sm" variant="ghost"
                          className="text-gray-500 hover:text-gray-900"
                          onClick={() => openEditDialog(activity)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
      <EmailComposer
        open={emailComposerOpen}
        onOpenChange={setEmailComposerOpen}
        lead={selectedLead}
        client={client}
        activity={selectedActivity}
        onEmailSent={loadData}
      />

      <Dialog open={!!editActivity} onOpenChange={(open) => !open && setEditActivity(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Activity</DialogTitle>
          </DialogHeader>
          {editActivity && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={editActivity.title || ''} disabled />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={editStatus} onValueChange={setEditStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                    <SelectItem value="no_show">No Show</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Scheduled Date & Time</Label>
                <Input 
                  type="datetime-local" 
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditActivity(null)}>Cancel</Button>
            <Button onClick={handleUpdateActivity}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FeatureGate>
  );
}