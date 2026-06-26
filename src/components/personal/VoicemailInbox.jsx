import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/api/apiClient';
import { MessageSquare, Check, AlertTriangle, Clock } from 'lucide-react';
import moment from 'moment';

const urgencyConfig = {
  urgent: { label: 'Urgent', className: 'bg-red-100 text-red-800', icon: AlertTriangle },
  high: { label: 'High', className: 'bg-orange-100 text-orange-800', icon: AlertTriangle },
  medium: { label: 'Medium', className: 'bg-yellow-100 text-yellow-800', icon: Clock },
  low: { label: 'Low', className: 'bg-green-100 text-green-800', icon: Clock }
};

const categoryConfig = {
  family: { label: 'Family', className: 'bg-green-100 text-green-700' },
  business: { label: 'Business', className: 'bg-blue-100 text-blue-700' },
  promotional: { label: 'Promo', className: 'bg-yellow-100 text-yellow-700' },
  spam: { label: 'Spam', className: 'bg-red-100 text-red-700' },
  unknown: { label: 'Unknown', className: 'bg-gray-100 text-gray-700' }
};

export default function VoicemailInbox({ messages, onRefresh }) {
  const [expandedId, setExpandedId] = useState(null);

  const handleMarkRead = async (msg) => {
    if (msg.is_read) return;
    // The parent subscribes to VoicemailMessage updates, so the state patches live —
    // no need to force a full reload here.
    await apiClient.VoicemailMessage.update(msg.id, { is_read: true });
  };

  const unreadCount = messages.filter(m => !m.is_read).length;
  const sorted = [...messages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg flex items-center gap-2">
          <MessageSquare className="w-5 h-5" />
          Messages
          {unreadCount > 0 && (
            <Badge className="bg-purple-600 text-white ml-1">{unreadCount} new</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <MessageSquare className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm">No messages yet.</p>
            <p className="text-xs mt-1">Messages taken by your AI will appear here.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.slice(0, 20).map((msg) => {
              const urg = urgencyConfig[msg.urgency] || urgencyConfig.medium;
              const cat = categoryConfig[msg.category] || categoryConfig.unknown;
              const isExpanded = expandedId === msg.id;

              return (
                <div
                  key={msg.id}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    msg.is_read ? 'bg-white' : 'bg-purple-50 border-purple-200'
                  }`}
                  onClick={() => {
                    setExpandedId(isExpanded ? null : msg.id);
                    handleMarkRead(msg);
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">
                          {msg.caller_name || msg.caller_number}
                        </span>
                        {!msg.is_read && (
                          <span className="w-2 h-2 rounded-full bg-purple-600 flex-shrink-0" />
                        )}
                        <Badge className={urg.className}>{urg.label}</Badge>
                        <Badge className={cat.className}>{cat.label}</Badge>
                      </div>
                      <p className={`text-xs text-gray-500 mt-1 ${isExpanded ? '' : 'line-clamp-2'}`}>
                        {msg.message || 'No message content'}
                      </p>
                      <span className="text-xs text-gray-400 mt-1 block">
                        {moment(msg.created_at).fromNow()}
                      </span>
                    </div>
                    {msg.is_read && (
                      <Check className="w-4 h-4 text-green-500 flex-shrink-0 ml-2" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}