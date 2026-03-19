import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from "@/components/ui/use-toast";
import CalendarHeader from '../components/social/CalendarHeader';
import CalendarGrid from '../components/social/CalendarGrid';
import PostPreviewDialog from '../components/social/PostPreviewDialog';

export default function SocialMediaCalendar() {
  const [client, setClient] = useState(null);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState('month');
  const [selectedPost, setSelectedPost] = useState(null);
  const [customOccasions, setCustomOccasions] = useState([]);

  useEffect(() => {
    const load = async () => {
      const user = await base44.auth.me();
      if (user.role === 'admin') return;
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (clients.length > 0) {
        setClient(clients[0]);
        const brandSettings = await base44.entities.BrandSettings.filter({ client_id: clients[0].id });
        if (brandSettings.length > 0) {
          setCustomOccasions(brandSettings[0].custom_occasions || []);
        }
      }
    };
    load();
  }, []);

  const { data: posts = [], refetch } = useQuery({
    queryKey: ['calendar-posts', client?.id],
    queryFn: () => client ? base44.entities.SocialMediaPost.filter({ client_id: client.id }, '-scheduled_date', 200) : [],
    enabled: !!client?.id,
  });

  const navigate = (dir) => {
    if (dir === 0) { setCurrentDate(new Date()); return; }
    const d = new Date(currentDate);
    if (view === 'month') d.setMonth(d.getMonth() + dir);
    else d.setDate(d.getDate() + dir * 7);
    setCurrentDate(d);
  };

  const handleDrop = async (postId, newDate) => {
    await base44.entities.SocialMediaPost.update(postId, { scheduled_date: newDate });
    toast({ title: "Rescheduled", description: `Post moved to ${newDate}` });
    refetch();
  };

  const handleShared = async (platform) => {
    if (!selectedPost) return;
    const sharedOn = [...(selectedPost.shared_on || [])];
    if (!sharedOn.includes(platform)) sharedOn.push(platform);
    await base44.entities.SocialMediaPost.update(selectedPost.id, { status: 'shared', shared_on: sharedOn });
    refetch();
  };

  if (!client) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Content Calendar</h1>
        <p className="text-gray-500 text-sm">Plan and schedule your social media posts. Drag to reschedule.</p>
      </div>

      <CalendarHeader currentDate={currentDate} view={view} onViewChange={setView} onNavigate={navigate} />

      <div className="flex gap-4 text-xs">
        <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-yellow-400" /> Pending</div>
        <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-400" /> Approved</div>
        <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-blue-400" /> Shared</div>
        <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-400" /> Rejected</div>
      </div>

      <CalendarGrid
        currentDate={currentDate}
        view={view}
        posts={posts}
        customOccasions={customOccasions}
        onDrop={handleDrop}
        onPostClick={setSelectedPost}
      />

      <PostPreviewDialog
        post={selectedPost}
        open={!!selectedPost}
        onClose={() => setSelectedPost(null)}
        onShared={handleShared}
      />
    </div>
  );
}