import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, AlertCircle, CheckCircle2 } from 'lucide-react';

const priorityStyles = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-blue-100 text-blue-700',
};

export default function ActiveTasks({ activities }) {
  const activeTasks = activities
    .filter(a => a.status === 'scheduled' || a.status === 'overdue')
    .sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date))
    .slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Active Tasks & Upcoming Activities</CardTitle>
      </CardHeader>
      <CardContent>
        {activeTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400">
            <CheckCircle2 className="w-8 h-8 mb-2" />
            <p className="text-sm">No pending tasks</p>
          </div>
        ) : (
          <div className="space-y-3">
            {activeTasks.map(task => {
              const isOverdue = new Date(task.scheduled_date) < new Date();
              return (
                <div key={task.id} className={`flex items-start gap-3 p-3 rounded-lg border ${isOverdue ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-gray-50'}`}>
                  {isOverdue ? (
                    <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                  ) : (
                    <Calendar className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{task.title}</p>
                    {task.description && (
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{task.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1.5">
                      <Badge className={`text-[10px] px-1.5 py-0 ${priorityStyles[task.priority] || priorityStyles.medium}`}>
                        {task.priority || 'medium'}
                      </Badge>
                      <span className="text-[10px] text-gray-400">
                        {new Date(task.scheduled_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">{task.type}</Badge>
                    </div>
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