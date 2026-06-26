import React, { useState } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Check, X, Pencil, Calendar, Save } from 'lucide-react';
import { apiClient } from '@/api/apiClient';
import ShareMenu from './ShareMenu';

const statusStyles = {
  pending_approval: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  shared: 'bg-blue-100 text-blue-800',
};

const typeStyles = {
  promotional: 'bg-orange-100 text-orange-700',
  educational: 'bg-blue-100 text-blue-700',
  tips: 'bg-purple-100 text-purple-700',
  engagement: 'bg-pink-100 text-pink-700',
  behind_the_scenes: 'bg-teal-100 text-teal-700',
  testimonial: 'bg-green-100 text-green-700',
  announcement: 'bg-red-100 text-red-700',
  festival: 'bg-amber-100 text-amber-700',
};

export default function PostCard({ post, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [editCaption, setEditCaption] = useState(post.caption);
  const [editHashtags, setEditHashtags] = useState(post.hashtags);
  const [loading, setLoading] = useState(false);
  const [showFullCaption, setShowFullCaption] = useState(false);

  const handleApprove = async () => {
    setLoading(true);
    await apiClient.SocialMediaPost.update(post.id, { status: 'approved' });
    onUpdate?.();
    setLoading(false);
  };

  const handleReject = async () => {
    setLoading(true);
    await apiClient.SocialMediaPost.update(post.id, { status: 'rejected' });
    onUpdate?.();
    setLoading(false);
  };

  const handleSaveEdit = async () => {
    setLoading(true);
    await apiClient.SocialMediaPost.update(post.id, { caption: editCaption, hashtags: editHashtags });
    setEditing(false);
    onUpdate?.();
    setLoading(false);
  };

  const handleShared = async (platform) => {
    const sharedOn = [...(post.shared_on || [])];
    if (!sharedOn.includes(platform)) sharedOn.push(platform);
    await apiClient.SocialMediaPost.update(post.id, { status: 'shared', shared_on: sharedOn });
    onUpdate?.();
  };

  const displayCaption = showFullCaption ? post.caption : post.caption?.substring(0, 200);

  return (
    <Card className="overflow-hidden hover:shadow-lg transition-shadow">
      {/* Poster Image */}
      {post.poster_url && (
        <div className="relative aspect-square bg-gray-100">
          <img src={post.poster_url} alt={post.title} className="w-full h-full object-cover" />
          <div className="absolute top-2 right-2 flex gap-1">
            <Badge className={statusStyles[post.status] || 'bg-gray-100'}>
              {post.status?.replace('_', ' ')}
            </Badge>
          </div>
        </div>
      )}

      <CardContent className="p-4 space-y-3">
        {/* Title & Type */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-sm">{post.title}</h3>
          <Badge className={`text-xs ${typeStyles[post.content_type] || 'bg-gray-100'}`}>
            {post.content_type?.replace('_', ' ')}
          </Badge>
        </div>

        {/* Caption */}
        {editing ? (
          <div className="space-y-2">
            <Textarea value={editCaption} onChange={e => setEditCaption(e.target.value)} rows={4} className="text-sm" />
            <Textarea value={editHashtags} onChange={e => setEditHashtags(e.target.value)} rows={2} placeholder="Hashtags" className="text-sm" />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveEdit} disabled={loading} className="gap-1">
                <Save className="w-3 h-3" /> Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">
              {displayCaption}
              {post.caption?.length > 200 && (
                <button onClick={() => setShowFullCaption(!showFullCaption)} className="text-blue-600 text-xs ml-1">
                  {showFullCaption ? 'Show less' : '...more'}
                </button>
              )}
            </p>
            <p className="text-xs text-blue-600 mt-1">{post.hashtags}</p>
          </div>
        )}

        {/* Date & Shared On */}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Calendar className="w-3 h-3" />
          {post.scheduled_date}
          {post.shared_on?.length > 0 && (
            <span className="ml-2">• Shared on: {post.shared_on.join(', ')}</span>
          )}
        </div>

        {/* Actions */}
        {!editing && (
          <div className="flex items-center gap-2 pt-2 border-t">
            {post.status === 'pending_approval' && (
              <>
                <Button size="sm" variant="outline" onClick={handleApprove} disabled={loading} className="gap-1 text-green-700 border-green-300 hover:bg-green-50">
                  <Check className="w-3 h-3" /> Approve
                </Button>
                <Button size="sm" variant="outline" onClick={handleReject} disabled={loading} className="gap-1 text-red-700 border-red-300 hover:bg-red-50">
                  <X className="w-3 h-3" /> Reject
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => { setEditCaption(post.caption); setEditHashtags(post.hashtags); setEditing(true); }} className="gap-1">
              <Pencil className="w-3 h-3" /> Edit
            </Button>
            {(post.status === 'approved' || post.status === 'shared') && (
              <ShareMenu post={post} onShared={handleShared} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}