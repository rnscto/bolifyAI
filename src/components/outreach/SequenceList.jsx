import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Play, Pause, Pencil, Trash2, Users, Mail, CheckCircle2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

const STATUS_COLORS = {
  active: 'bg-green-100 text-green-800',
  paused: 'bg-yellow-100 text-yellow-800',
  draft: 'bg-gray-100 text-gray-600'
};

const TYPE_COLORS = {
  lead_followup: 'bg-blue-100 text-blue-800',
  retention: 'bg-orange-100 text-orange-800',
  re_engagement: 'bg-purple-100 text-purple-800',
  thank_you: 'bg-green-100 text-green-800',
  proposal: 'bg-indigo-100 text-indigo-800',
  callback_reminder: 'bg-cyan-100 text-cyan-800'
};

export default function SequenceList({ sequences, onEdit, onRefresh, onViewEnrollments }) {
  const [toggling, setToggling] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const handleToggle = async (seq) => {
    setToggling(seq.id);
    const newStatus = seq.status === 'active' ? 'paused' : 'active';
    await base44.entities.EmailSequence.update(seq.id, { status: newStatus });
    toast.success(`Sequence ${newStatus === 'active' ? 'activated' : 'paused'}`);
    onRefresh();
    setToggling(null);
  };

  const handleDelete = async (seq) => {
    if (!confirm(`Delete sequence "${seq.name}"? This will not affect already-sent emails.`)) return;
    setDeleting(seq.id);
    await base44.entities.EmailSequence.delete(seq.id);
    toast.success('Sequence deleted');
    onRefresh();
    setDeleting(null);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <CardTitle className="text-lg">Email Sequences</CardTitle>
        <Button onClick={() => onEdit(null)} className="gap-2" size="sm">
          <Plus className="w-4 h-4" /> New Sequence
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead>Enrolled</TableHead>
              <TableHead>Completed</TableHead>
              <TableHead>Opted Out</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sequences.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-12 text-gray-400">
                  No sequences created yet. Click "New Sequence" to get started.
                </TableCell>
              </TableRow>
            ) : sequences.map(seq => (
              <TableRow key={seq.id}>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{seq.name}</span>
                    {seq.auto_generated && (
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" title="AI Generated" />
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge className={TYPE_COLORS[seq.outreach_type] || 'bg-gray-100 text-gray-700'}>
                    {(seq.outreach_type || '').replace(/_/g, ' ')}
                  </Badge>
                </TableCell>
                <TableCell>
                  {seq.tier_target ? (
                    <Badge variant="outline" className="text-xs">
                      {seq.tier_target === 'hot' ? '🔥' : seq.tier_target === 'warm' ? '🟡' : seq.tier_target === 'nurture' ? '🟢' : seq.tier_target === 'cold' ? '❄️' : '🌐'} {seq.tier_target}
                    </Badge>
                  ) : <span className="text-xs text-gray-400">—</span>}
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1 text-sm text-gray-600">
                    <Mail className="w-3.5 h-3.5" /> {seq.steps?.length || 0}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1 text-sm">
                    <Users className="w-3.5 h-3.5 text-blue-500" /> {seq.total_enrolled || 0}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1 text-sm">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> {seq.total_completed || 0}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-gray-500">{seq.total_opted_out || 0}</TableCell>
                <TableCell>
                  <Badge className={STATUS_COLORS[seq.status]}>{seq.status}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => onViewEnrollments(seq)}
                      title="View enrollments"
                    >
                      <Users className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={toggling === seq.id}
                      onClick={() => handleToggle(seq)}
                      title={seq.status === 'active' ? 'Pause' : 'Activate'}
                    >
                      {seq.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onEdit(seq)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-red-500 hover:text-red-700"
                      disabled={deleting === seq.id}
                      onClick={() => handleDelete(seq)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}