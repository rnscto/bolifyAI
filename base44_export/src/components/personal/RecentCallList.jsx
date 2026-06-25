import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Phone, Clock, User } from 'lucide-react';
import moment from 'moment';

const classificationConfig = {
  family: { label: 'Family', className: 'bg-green-100 text-green-800' },
  business: { label: 'Business', className: 'bg-blue-100 text-blue-800' },
  promotional: { label: 'Promotional', className: 'bg-yellow-100 text-yellow-800' },
  spam: { label: 'Spam', className: 'bg-red-100 text-red-800' },
  unknown: { label: 'Unknown', className: 'bg-gray-100 text-gray-700' }
};

function classifyCall(call) {
  const summary = (call.conversation_summary || '').toLowerCase();
  if (summary.includes('spam') || summary.includes('telemarketing') || summary.includes('fraud')) return 'spam';
  if (summary.includes('promotional') || summary.includes('offer') || summary.includes('discount')) return 'promotional';
  if (summary.includes('family') || summary.includes('personal') || summary.includes('friend')) return 'family';
  if (summary.includes('business') || summary.includes('meeting') || summary.includes('work') || summary.includes('office')) return 'business';
  return 'unknown';
}

export default function RecentCallList({ calls }) {
  const recentCalls = calls
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 15);

  if (recentCalls.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Calls</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-gray-500">
            <Phone className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p>No calls yet. Your AI assistant is ready to screen calls.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Recent Calls</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {recentCalls.map((call) => {
          const classification = classifyCall(call);
          const config = classificationConfig[classification];
          const callerDisplay = call.caller_id || call.callee_number || 'Unknown';
          const summary = call.conversation_summary
            ? call.conversation_summary.substring(0, 100) + (call.conversation_summary.length > 100 ? '...' : '')
            : 'No summary available';

          return (
            <div key={call.id} className="flex items-start gap-3 p-3 rounded-lg border hover:bg-gray-50 transition-colors">
              <div className="mt-1 p-2 rounded-full bg-gray-100">
                <User className="w-4 h-4 text-gray-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900 text-sm">{callerDisplay}</span>
                  <Badge className={config.className}>{config.label}</Badge>
                  {call.status === 'no_answer' && (
                    <Badge variant="outline" className="text-orange-600 border-orange-300">Missed</Badge>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1 line-clamp-2">{summary}</p>
                <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {moment(call.created_at).fromNow()}
                  </span>
                  {call.duration > 0 && (
                    <span>{Math.round(call.duration)}s</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}