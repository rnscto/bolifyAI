import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Play, Pause, Eye, Phone, Users, CheckCircle2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';

const statusColors = {
  draft: 'bg-gray-100 text-gray-700',
  scheduled: 'bg-blue-100 text-blue-700',
  running: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};

const typeLabels = { cold_call: 'Cold Call', followup: 'Follow-up' };

export default function CampaignCard({ campaign, onStart, onPause }) {
  const outcomes = campaign.outcomes_summary || {};
  const progress = campaign.total_leads > 0
    ? Math.round(((campaign.calls_completed + campaign.calls_failed) / campaign.total_leads) * 100)
    : 0;

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-gray-900">{campaign.name}</h3>
            <div className="flex gap-2 mt-1">
              <Badge className={statusColors[campaign.status]}>{campaign.status}</Badge>
              <Badge variant="outline">{typeLabels[campaign.type] || campaign.type}</Badge>
            </div>
          </div>
          <div className="flex gap-1">
            {['draft', 'paused'].includes(campaign.status) && (
              <Button size="sm" variant="outline" onClick={() => onStart(campaign.id)} title="Start">
                <Play className="w-4 h-4" />
              </Button>
            )}
            {campaign.status === 'running' && (
              <Button size="sm" variant="outline" onClick={() => onPause(campaign.id)} title="Pause">
                <Pause className="w-4 h-4" />
              </Button>
            )}
            <Link to={createPageUrl(`CampaignDetail?id=${campaign.id}`)}>
              <Button size="sm" variant="ghost"><Eye className="w-4 h-4" /></Button>
            </Link>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{campaign.calls_completed + campaign.calls_failed} / {campaign.total_leads} calls</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {/* Outcome badges */}
        <div className="flex flex-wrap gap-2 text-xs">
          {outcomes.interested > 0 && (
            <span className="flex items-center gap-1 text-green-700">
              <CheckCircle2 className="w-3 h-3" /> {outcomes.interested} interested
            </span>
          )}
          {outcomes.callback > 0 && (
            <span className="flex items-center gap-1 text-yellow-700">
              <Phone className="w-3 h-3" /> {outcomes.callback} callback
            </span>
          )}
          {outcomes.not_interested > 0 && (
            <span className="flex items-center gap-1 text-red-600">
              <XCircle className="w-3 h-3" /> {outcomes.not_interested} not interested
            </span>
          )}
          {outcomes.no_answer > 0 && (
            <span className="flex items-center gap-1 text-gray-500">
              <Users className="w-3 h-3" /> {outcomes.no_answer} no answer
            </span>
          )}
        </div>

        {campaign.created_date && (
          <p className="text-xs text-gray-400 mt-3">
            Created {new Date(campaign.created_date).toLocaleDateString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}