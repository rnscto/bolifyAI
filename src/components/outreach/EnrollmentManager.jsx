import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ArrowLeft, Plus, UserX, Play, Pause, Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import moment from 'moment';

const STATUS_COLORS = {
  active: 'bg-green-100 text-green-800',
  completed: 'bg-blue-100 text-blue-800',
  opted_out: 'bg-red-100 text-red-800',
  paused: 'bg-yellow-100 text-yellow-800',
  failed: 'bg-red-100 text-red-700'
};

export default function EnrollmentManager({ sequence, onBack }) {
  const [enrollments, setEnrollments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showEnroll, setShowEnroll] = useState(false);
  const [enrollForm, setEnrollForm] = useState({ email: '', name: '', client_id: '', lead_id: '' });
  const [enrolling, setEnrolling] = useState(false);
  const [actionId, setActionId] = useState(null);

  useEffect(() => { loadEnrollments(); }, [sequence.id]);

  const loadEnrollments = async () => {
    setLoading(true);
    const data = await base44.entities.SequenceEnrollment.filter({ sequence_id: sequence.id }, '-created_date', 100);
    setEnrollments(data);
    setLoading(false);
  };

  const handleEnroll = async () => {
    if (!enrollForm.email) { toast.error('Email is required'); return; }
    setEnrolling(true);

    const firstStep = sequence.steps?.[0];
    const nextSend = new Date();
    nextSend.setDate(nextSend.getDate() + (firstStep?.delay_days || 1));

    await base44.entities.SequenceEnrollment.create({
      sequence_id: sequence.id,
      recipient_email: enrollForm.email,
      recipient_name: enrollForm.name,
      client_id: enrollForm.client_id || undefined,
      lead_id: enrollForm.lead_id || undefined,
      status: 'active',
      current_step: 0,
      steps_completed: 0,
      total_steps: sequence.steps?.length || 0,
      next_send_date: nextSend.toISOString(),
      enrolled_date: new Date().toISOString(),
      send_log: []
    });

    // Update sequence counters
    await base44.entities.EmailSequence.update(sequence.id, {
      total_enrolled: (sequence.total_enrolled || 0) + 1
    });

    toast.success(`${enrollForm.email} enrolled in sequence`);
    setShowEnroll(false);
    setEnrollForm({ email: '', name: '', client_id: '', lead_id: '' });
    setEnrolling(false);
    loadEnrollments();
  };

  const handleOptOut = async (enrollment) => {
    if (!confirm(`Opt out ${enrollment.recipient_email}?`)) return;
    setActionId(enrollment.id);
    await base44.entities.SequenceEnrollment.update(enrollment.id, {
      status: 'opted_out',
      opt_out_date: new Date().toISOString()
    });
    await base44.entities.EmailSequence.update(sequence.id, {
      total_opted_out: (sequence.total_opted_out || 0) + 1
    });
    toast.success('Contact opted out');
    loadEnrollments();
    setActionId(null);
  };

  const handleTogglePause = async (enrollment) => {
    setActionId(enrollment.id);
    const newStatus = enrollment.status === 'paused' ? 'active' : 'paused';
    await base44.entities.SequenceEnrollment.update(enrollment.id, { status: newStatus });
    toast.success(newStatus === 'paused' ? 'Enrollment paused' : 'Enrollment resumed');
    loadEnrollments();
    setActionId(null);
  };

  const activeCount = enrollments.filter(e => e.status === 'active').length;
  const completedCount = enrollments.filter(e => e.status === 'completed').length;
  const optedOutCount = enrollments.filter(e => e.status === 'opted_out').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h2 className="text-xl font-bold">{sequence.name}</h2>
            <p className="text-sm text-gray-500">{sequence.steps?.length || 0} steps • {sequence.outreach_type?.replace(/_/g, ' ')}</p>
          </div>
        </div>
        <Button onClick={() => setShowEnroll(true)} className="gap-2" size="sm">
          <Plus className="w-4 h-4" /> Enroll Contact
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5 text-center">
            <p className="text-2xl font-bold text-green-600">{activeCount}</p>
            <p className="text-xs text-gray-500">Active</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 text-center">
            <p className="text-2xl font-bold text-blue-600">{completedCount}</p>
            <p className="text-xs text-gray-500">Completed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 text-center">
            <p className="text-2xl font-bold text-red-500">{optedOutCount}</p>
            <p className="text-xs text-gray-500">Opted Out</p>
          </CardContent>
        </Card>
      </div>

      {/* Enrollments table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Next Send</TableHead>
                  <TableHead>Last Sent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {enrollments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12 text-gray-400">
                      No contacts enrolled yet
                    </TableCell>
                  </TableRow>
                ) : enrollments.map(e => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{e.recipient_name || e.recipient_email}</p>
                        {e.recipient_name && <p className="text-xs text-gray-400">{e.recipient_email}</p>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-gray-100 rounded-full w-20">
                          <div
                            className="h-2 bg-blue-500 rounded-full transition-all"
                            style={{ width: `${e.total_steps ? (e.steps_completed / e.total_steps) * 100 : 0}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{e.steps_completed || 0}/{e.total_steps || 0}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {e.status === 'active' && e.next_send_date ? moment(e.next_send_date).fromNow() : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {e.last_sent_date ? moment(e.last_sent_date).format('DD MMM, hh:mm A') : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge className={STATUS_COLORS[e.status]}>{e.status?.replace(/_/g, ' ')}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {(e.status === 'active' || e.status === 'paused') && (
                          <Button
                            size="icon" variant="ghost" className="h-7 w-7"
                            disabled={actionId === e.id}
                            onClick={() => handleTogglePause(e)}
                            title={e.status === 'paused' ? 'Resume' : 'Pause'}
                          >
                            {e.status === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                          </Button>
                        )}
                        {e.status !== 'opted_out' && e.status !== 'completed' && (
                          <Button
                            size="icon" variant="ghost" className="h-7 w-7 text-red-400"
                            disabled={actionId === e.id}
                            onClick={() => handleOptOut(e)}
                            title="Opt out"
                          >
                            <UserX className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Send log per enrollment (expandable - for now show latest) */}

      {/* Enroll Dialog */}
      <Dialog open={showEnroll} onOpenChange={setShowEnroll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll Contact in Sequence</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Email *</Label>
              <Input value={enrollForm.email} onChange={e => setEnrollForm({ ...enrollForm, email: e.target.value })} placeholder="contact@example.com" />
            </div>
            <div>
              <Label>Name</Label>
              <Input value={enrollForm.name} onChange={e => setEnrollForm({ ...enrollForm, name: e.target.value })} placeholder="Contact name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Client ID (optional)</Label>
                <Input value={enrollForm.client_id} onChange={e => setEnrollForm({ ...enrollForm, client_id: e.target.value })} placeholder="Client ID" />
              </div>
              <div>
                <Label>Lead ID (optional)</Label>
                <Input value={enrollForm.lead_id} onChange={e => setEnrollForm({ ...enrollForm, lead_id: e.target.value })} placeholder="Lead ID" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEnroll(false)}>Cancel</Button>
            <Button onClick={handleEnroll} disabled={enrolling} className="gap-2">
              {enrolling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
              Enroll
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}