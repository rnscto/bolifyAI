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
import { Calendar, CheckCircle2, XCircle, Mail, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
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

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await apiClient.auth.me();
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
        <CardHeader>
          <CardTitle>All Activities</CardTitle>
        </CardHeader>
        <CardContent>
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
              {activities.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500">
                    No activities scheduled
                  </TableCell>
                </TableRow>
              ) : (
                activities.map((activity) => (
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
                      {isHumanEmailAction(activity) && (
                        <Button
                          size="sm" variant="outline"
                          className="gap-1 text-blue-700 border-blue-200 hover:bg-blue-50"
                          onClick={() => openEmailComposer(activity)}
                        >
                          <Mail className="w-3.5 h-3.5" /> Compose
                        </Button>
                      )}
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
    </FeatureGate>
  );
}