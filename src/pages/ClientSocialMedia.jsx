import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, Loader2, RefreshCw, Image } from 'lucide-react';
import PostCard from '../components/social/PostCard';
import AddOnAccessGate from '../components/AddOnAccessGate';

export default function ClientSocialMedia() {
  const [client, setClient] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [generating, setGenerating] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const loadClient = async () => {
      const user = await apiClient.auth.me();
      if (user.role === 'admin') return;
      const clients = await apiClient.Client.filter({ user_id: user.id });
      if (clients.length > 0) setClient(clients[0]);
    };
    loadClient();
  }, []);

  const { data: posts = [], isLoading, refetch } = useQuery({
    queryKey: ['social-posts', client?.id],
    queryFn: () => client ? apiClient.SocialMediaPost.filter({ client_id: client.id }, '-created_at', 100) : [],
    enabled: !!client?.id,
  });

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await apiClient.functions.invoke('generateSocialContent', { client_id: client.id });
      refetch();
    } catch (err) {
      console.error('Generation failed:', err);
    }
    setGenerating(false);
  };

  const filteredPosts = statusFilter === 'all' ? posts : posts.filter(p => p.status === statusFilter);

  const stats = {
    total: posts.length,
    pending: posts.filter(p => p.status === 'pending_approval').length,
    approved: posts.filter(p => p.status === 'approved').length,
    shared: posts.filter(p => p.status === 'shared').length,
    rejected: posts.filter(p => p.status === 'rejected').length,
  };

  if (!client) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const reloadClient = async () => {
    const user = await apiClient.auth.me();
    const cs = await apiClient.Client.filter({ user_id: user.id });
    if (cs.length > 0) setClient(cs[0]);
  };

  return (
    <AddOnAccessGate
      client={client}
      onChange={reloadClient}
      featureName="Social Media Content"
      featureIcon={<Image className="w-6 h-6" />}
      statusField="social_media_access_status"
      requestedAtField="social_media_access_requested_at"
      activatedAtField="social_media_access_activated_at"
      feeField="social_media_access_fee"
      notesField="social_media_access_notes"
      description="AI-generated social media posts tailored to your brand. Auto-create, review, approve and share content across platforms."
      bullets={[
        'AI-generated posts based on your brand voice & products',
        'Multi-platform: Instagram, Facebook, LinkedIn, Twitter',
        'Auto-images, scheduling & content calendar',
        'Festival/occasion-based content automation'
      ]}
    >
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Social Media Content</h1>
          <p className="text-gray-500 text-sm">AI-generated posts for your business. Review, approve & share.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refetch} className="gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
          <Button onClick={handleGenerate} disabled={generating} className="gap-2 bg-gradient-to-r from-purple-600 to-blue-600">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {generating ? 'Generating...' : 'Generate Posts'}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="bg-gray-50">
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-xs text-gray-500">Total</div>
          </CardContent>
        </Card>
        <Card className="bg-yellow-50">
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-yellow-700">{stats.pending}</div>
            <div className="text-xs text-yellow-600">Pending</div>
          </CardContent>
        </Card>
        <Card className="bg-green-50">
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-green-700">{stats.approved}</div>
            <div className="text-xs text-green-600">Approved</div>
          </CardContent>
        </Card>
        <Card className="bg-blue-50">
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-blue-700">{stats.shared}</div>
            <div className="text-xs text-blue-600">Shared</div>
          </CardContent>
        </Card>
        <Card className="bg-red-50">
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-red-700">{stats.rejected}</div>
            <div className="text-xs text-red-600">Rejected</div>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Posts</SelectItem>
            <SelectItem value="pending_approval">Pending Approval</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="shared">Shared</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-gray-500">{filteredPosts.length} posts</span>
      </div>

      {/* Posts Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : filteredPosts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Image className="w-16 h-16 text-gray-600 mb-4" />
            <h3 className="font-semibold text-gray-700 mb-2">No posts yet</h3>
            <p className="text-sm text-gray-500 mb-4">Click "Generate Posts" to create AI-powered content for your business</p>
            <Button onClick={handleGenerate} disabled={generating} className="gap-2">
              <Sparkles className="w-4 h-4" /> Generate Now
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPosts.map(post => (
            <PostCard key={post.id} post={post} onUpdate={refetch} />
          ))}
        </div>
      )}
    </div>
    </AddOnAccessGate>
  );
}