import React from 'react';
import { getOccasionsForDate } from '@/lib/marketingCalendar';

const statusDot = {
  pending_approval: 'bg-yellow-400',
  approved: 'bg-green-400',
  shared: 'bg-blue-400',
  rejected: 'bg-red-400',
};

function DayCell({ date, posts, customOccasions, isToday, isCurrentMonth, onDrop, onPostClick }) {
  const dateStr = date.toISOString().split('T')[0];
  const dayPosts = posts.filter(p => p.scheduled_date === dateStr);
  const occasions = getOccasionsForDate(dateStr, customOccasions);

  const handleDragOver = (e) => { e.preventDefault(); e.currentTarget.classList.add('bg-blue-50'); };
  const handleDragLeave = (e) => { e.currentTarget.classList.remove('bg-blue-50'); };
  const handleDrop = (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('bg-blue-50');
    const postId = e.dataTransfer.getData('text/plain');
    if (postId) onDrop(postId, dateStr);
  };

  return (
    <div
      className={`min-h-[90px] border border-gray-100 p-1.5 transition-colors ${!isCurrentMonth ? 'bg-gray-50 opacity-50' : ''} ${isToday ? 'bg-blue-50 border-blue-200' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`text-xs font-medium mb-1 ${isToday ? 'text-blue-700 font-bold' : 'text-gray-500'}`}>
        {date.getDate()}
      </div>
      {occasions.map(o => (
        <div key={o.id} className="text-xs truncate px-1 py-0.5 rounded bg-orange-50 text-orange-700 mb-1" title={o.name}>
          {o.emoji} {o.name}
        </div>
      ))}
      <div className="space-y-1">
        {dayPosts.slice(0, 3).map(post => (
          <div
            key={post.id}
            draggable
            onDragStart={e => e.dataTransfer.setData('text/plain', post.id)}
            onClick={() => onPostClick?.(post)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-white border shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow truncate"
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot[post.status] || 'bg-gray-300'}`} />
            <span className="truncate">{post.title || 'Post'}</span>
          </div>
        ))}
        {dayPosts.length > 3 && (
          <div className="text-xs text-gray-400 pl-1">+{dayPosts.length - 3} more</div>
        )}
      </div>
    </div>
  );
}

export default function CalendarGrid({ currentDate, view, posts, customOccasions = [], onDrop, onPostClick }) {
  const days = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date().toISOString().split('T')[0];

  if (view === 'month') {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startPad = firstDay.getDay();
    const start = new Date(firstDay);
    start.setDate(start.getDate() - startPad);

    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      if (i >= 35 && d.getMonth() !== month) break;
      days.push(d);
    }
  } else {
    const start = new Date(currentDate);
    start.setDate(currentDate.getDate() - currentDate.getDay());
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="grid grid-cols-7 bg-gray-50">
        {dayNames.map(d => (
          <div key={d} className="text-center text-xs font-semibold text-gray-500 py-2 border-b">{d}</div>
        ))}
      </div>
      <div className={`grid grid-cols-7 ${view === 'week' ? 'min-h-[300px]' : ''}`}>
        {days.map((date, i) => (
          <DayCell
            key={i}
            date={date}
            posts={posts}
            customOccasions={customOccasions}
            isToday={date.toISOString().split('T')[0] === today}
            isCurrentMonth={date.getMonth() === currentDate.getMonth()}
            onDrop={onDrop}
            onPostClick={onPostClick}
          />
        ))}
      </div>
    </div>
  );
}