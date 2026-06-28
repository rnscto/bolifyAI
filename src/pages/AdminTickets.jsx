import React, { useEffect, useState } from 'react';
import { supportApi } from '@/api/supportApi';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LifeBuoy, Send, ArrowLeft, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';

export default function AdminTickets() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTicket, setActiveTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  
  const [replyText, setReplyText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [filterStatus, setFilterStatus] = useState('all');

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

  useEffect(() => { loadTickets(); }, []);

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

  const sendReply = async (e) => {
    e.preventDefault();
    if (!replyText.trim() || !activeTicket) return;
    setSubmitting(true);
    try {
      await supportApi.sendMessage(activeTicket.id, replyText);
      // Optionally update status to in_progress
      if (activeTicket.status === 'open') {
        await supportApi.updateTicketStatus(activeTicket.id, 'in_progress');
        loadTickets();
        setActiveTicket(prev => ({ ...prev, status: 'in_progress' }));
      }
      setReplyText('');
      loadMessages(activeTicket.id);
    } catch (e) {
      toast.error('Failed to send message');
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (newStatus) => {
    if (!activeTicket) return;
    try {
      await supportApi.updateTicketStatus(activeTicket.id, newStatus);
      toast.success('Status updated');
      setActiveTicket(prev => ({ ...prev, status: newStatus }));
      loadTickets();
    } catch (e) {
      toast.error('Failed to update status');
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
                <Select value={activeTicket.status} onValueChange={updateStatus}>
                  <SelectTrigger className={`h-6 text-xs w-[120px] ${statusColors[activeTicket.status]}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-gray-500 capitalize">{activeTicket.category.replace('_', ' ')}</span>
                <span className="text-xs text-gray-500">•</span>
                <span className="text-xs text-gray-500">Client ID: {activeTicket.client_id}</span>
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
                const isAdmin = msg.sender_role === 'admin' || msg.sender_role === 'AI_AGENT';
                return (
                  <div key={msg.id} className={`flex flex-col ${isAdmin ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-700">{msg.sender_role === 'AI_AGENT' ? 'AI Auto-Responder' : (isAdmin ? 'You (Admin)' : 'Client')}</span>
                      <span className="text-[10px] text-gray-400">{new Date(msg.created_at).toLocaleString()}</span>
                    </div>
                    <div className={`px-4 py-2 rounded-2xl max-w-[85%] text-sm ${isAdmin ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-white border rounded-tl-sm text-gray-800 shadow-sm'}`}>
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
                placeholder="Type your response to the client..." 
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

  const filteredTickets = filterStatus === 'all' ? tickets : tickets.filter(t => t.status === filterStatus);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <LifeBuoy className="w-7 h-7 text-blue-600" /> Ticket Management
          </h1>
          <p className="text-gray-600 mt-1">Manage and respond to client support tickets.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Filter Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
          ) : filteredTickets.length === 0 ? (
            <div className="text-center py-12 px-4">
              <CheckCircle2 className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-gray-900">No tickets found</h3>
              <p className="text-gray-500 text-sm mt-1 mb-4">There are no tickets matching this filter.</p>
            </div>
          ) : (
            <div className="divide-y">
              {filteredTickets.map(ticket => (
                <div key={ticket.id} onClick={() => handleOpenTicket(ticket)} className="flex items-center justify-between p-4 hover:bg-gray-50 cursor-pointer transition-colors group">
                  <div className="flex items-start gap-4">
                    <div className={`mt-1 w-2 h-2 rounded-full ${ticket.status === 'open' ? 'bg-blue-500' : ticket.status === 'in_progress' ? 'bg-amber-500' : 'bg-gray-300'}`} />
                    <div>
                      <h4 className="text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors">{ticket.subject}</h4>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        <span className="capitalize">{ticket.category.replace('_', ' ')}</span>
                        <span>•</span>
                        <span>{new Date(ticket.created_at).toLocaleDateString()}</span>
                        <span>•</span>
                        <span>Client: {ticket.client_id?.substring(0, 8)}...</span>
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
    </div>
  );
}
