import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Calendar } from 'lucide-react';
import ShareMenu from './ShareMenu';

const statusStyles = {
  pending_approval: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  shared: 'bg-blue-100 text-blue-800',
};

export default function PostPreviewDialog({ post, open, onClose, onShared }) {
  if (!post) return null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{post.title}</span>
            <Badge className={statusStyles[post.status]}>{post.status?.replace('_', ' ')}</Badge>
          </DialogTitle>
        </DialogHeader>
        {post.poster_url && (
          <img src={post.poster_url} alt={post.title} className="w-full rounded-lg" />
        )}
        <p className="text-sm text-gray-700 whitespace-pre-wrap">{post.caption}</p>
        <p className="text-xs text-blue-600">{post.hashtags}</p>
        <div className="flex items-center justify-between pt-2 border-t">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Calendar className="w-3 h-3" /> {post.scheduled_date}
          </div>
          {(post.status === 'approved' || post.status === 'shared') && (
            <ShareMenu post={post} onShared={onShared} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}