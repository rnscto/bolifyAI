import React, { useEffect, useState } from 'react';
import { supportApi } from '@/api/supportApi';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { LifeBuoy, Plus, Send, ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';

export default function ClientTickets() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTicket, setActiveTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  
  const [form, setForm] = useState({ subject: '', category: 'technical_issue', priority: 'medium', description: '' });
  const [replyText, setReplyText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadTickets = async () => {
    setLoading(true);
    try {
      const list = await supportApi.getTickets();
      setTickets(list || []);
    } catch (e) {
      toast.error('Failed to load tickets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.id) loadTickets();
  }, [user]);

  const loadMessages = async (ticketId) => {
    setLoadingMessages(true);
    try {
      const list = await supportApi.getMessages(ticketId);
      setMessages(list || []);
    } catch (e) {
      toast.error('Failed to load messages');
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleOpenTicket = (ticket) => {
    setActiveTicket(ticket);
    loadMessages(ticket.id);
  };

  const createTicket = async (e) => {
    e.preventDefault();
    if (!form.subject.trim()) { toast.error('Subject is required'); return; }
    setSubmitting(true);
    try {
      const newTicket = await supportApi.createTicket({
        subject: form.subject,
        category: form.category,
        priority: form.priority,
        description: form.description
      });
      toast.success('Ticket created successfully');
      setDialogOpen(false);
      setForm({ subject: '', category: 'technical_issue', priority: 'medium', description: '' });
      loadTickets();
      handleOpenTicket(newTicket);
    } catch (e) {
      toast.error('Failed to create ticket: ' + (e.message || 'unknown'));
    } finally {
      setSubmitting(false);
    }
  };

  const sendReply = async (e) => {
    e.preventDefault();
    if (!replyText.trim() || !activeTicket) return;
    setSubmitting(true);
    try {
      await supportApi.sendMessage(activeTicket.id, replyText);
      // Optionally update status to open if it was resolved
      if (activeTicket.status === 'resolved' || activeTicket.status === 'closed') {
        await supportApi.updateTicketStatus(activeTicket.id, 'open');
        loadTickets();
      }
      setReplyText('');
      loadMessages(activeTicket.id);
    } catch (e) {
      toast.error('Failed to send message');
    } finally {
      setSubmitting(false);
    }
  };

  const statusColors = {
    open: 'bg-blue-100 text-blue-800',
    in_progress: 'bg-amber-100 text-amber-800',
    resolved: 'bg-emerald-100 text-emerald-800',
    closed: 'bg-gray-100 text-gray-800',
  };

  if (activeTicket) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto flex flex-col h-[calc(100vh-120px)]">
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setActiveTicket(null)}>
              <ArrowLeft className="w-4 h-4 mr-2" /> Back
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                {activeTicket.subject}
              </h1>
              <div className="flex items-center gap-2 mt-1">
                <Badge className={statusColors[activeTicket.status]}>{activeTicket.status}</Badge>
                <span className="text-xs text-gray-500 capitalize">{activeTicket.category.replace('_', ' ')}</span>
              </div>
            </div>
          </div>
        </div>

        <Card className="flex-1 flex flex-col overflow-hidden">
          <CardContent className="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50/50">
            {loadingMessages ? (
              <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
            ) : messages.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">No messages yet. Write a message to begin.</p>
            ) : (
              messages.map(msg => {
                const isMe = msg.sender_role === 'client';
                return (
                  <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-700">{isMe ? 'You' : (msg.sender_role === 'AI_AGENT' ? 'AI Support' : 'Support Team')}</span>
                      <span className="text-[10px] text-gray-400">{new Date(msg.created_at).toLocaleString()}</span>
                    </div>
                    <div className={`px-4 py-2 rounded-2xl max-w-[85%] text-sm ${isMe ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-white border rounded-tl-sm text-gray-800 shadow-sm'}`}>
                      {msg.message}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
          <div className="p-4 bg-white border-t shrink-0">
            <form onSubmit={sendReply} className="flex gap-2">
              <Textarea 
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                placeholder="Type your message..." 
                className="resize-none min-h-[44px] h-[44px]"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(e); } }}
              />
              <Button type="submit" disabled={submitting || !replyText.trim()} className="bg-blue-600 hover:bg-blue-700 h-[44px]">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </form>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <LifeBuoy className="w-7 h-7 text-blue-600" /> Support Tickets
          </h1>
          <p className="text-gray-600 mt-1">Need help? Open a ticket and our team (or AI) will assist you.</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700">
          <Plus className="w-4 h-4 mr-2" /> New Ticket
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
          ) : tickets.length === 0 ? (
            <div className="text-center py-12 px-4">
              <LifeBuoy className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-gray-900">No support tickets</h3>
              <p className="text-gray-500 text-sm mt-1 mb-4">You haven't opened any support tickets yet.</p>
              <Button onClick={() => setDialogOpen(true)} variant="outline">Create your first ticket</Button>
            </div>
          ) : (
            <div className="divide-y">
              {tickets.map(ticket => (
                <div key={ticket.id} onClick={() => handleOpenTicket(ticket)} className="flex items-center justify-between p-4 hover:bg-gray-50 cursor-pointer transition-colors group">
                  <div className="flex items-start gap-4">
                    <div className={`mt-1 w-2 h-2 rounded-full ${ticket.status === 'open' ? 'bg-blue-500' : ticket.status === 'in_progress' ? 'bg-amber-500' : 'bg-gray-300'}`} />
                    <div>
                      <h4 className="text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors">{ticket.subject}</h4>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        <span className="capitalize">{ticket.category.replace('_', ' ')}</span>
                        <span>•</span>
                        <span>{new Date(ticket.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={statusColors[ticket.status] || 'bg-gray-100 text-gray-800'}>{ticket.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open New Ticket</DialogTitle>
            <DialogDescription>Please provide details about your issue below.</DialogDescription>
          </DialogHeader>
          <form onSubmit={createTicket} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Subject</Label>
              <Input value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} placeholder="Brief description of the issue" />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Please explain your issue in detail..." className="min-h-[100px]" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={v => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="technical_issue">Technical Issue</SelectItem>
                    <SelectItem value="billing">Billing</SelectItem>
                    <SelectItem value="sales">Sales & Upgrades</SelectItem>
                    <SelectItem value="feature_request">Feature Request</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={v => setForm({ ...form, priority: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
                {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Submit Ticket
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
