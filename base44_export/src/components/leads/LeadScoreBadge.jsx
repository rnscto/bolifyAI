import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Flame, TrendingUp, Sprout, Snowflake, Ban } from 'lucide-react';

const tierConfig = {
  hot: { label: 'Hot', icon: Flame, color: 'bg-red-100 text-red-700 border-red-200', ring: 'ring-red-400' },
  warm: { label: 'Warm', icon: TrendingUp, color: 'bg-orange-100 text-orange-700 border-orange-200', ring: 'ring-orange-400' },
  nurture: { label: 'Nurture', icon: Sprout, color: 'bg-blue-100 text-blue-700 border-blue-200', ring: 'ring-blue-400' },
  cold: { label: 'Cold', icon: Snowflake, color: 'bg-slate-100 text-slate-600 border-slate-200', ring: 'ring-slate-400' },
  disqualified: { label: 'Disqualified', icon: Ban, color: 'bg-gray-100 text-gray-500 border-gray-200', ring: 'ring-gray-400' },
};

const sentimentColors = {
  very_positive: 'text-green-600',
  positive: 'text-green-500',
  neutral: 'text-gray-500',
  negative: 'text-orange-500',
  very_negative: 'text-red-500',
};

function ScoreRing({ score }) {
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 75 ? '#ef4444' : score >= 50 ? '#f97316' : score >= 25 ? '#3b82f6' : '#94a3b8';

  return (
    <div className="relative w-9 h-9 flex items-center justify-center">
      <svg width="36" height="36" className="rotate-[-90deg]">
        <circle cx="18" cy="18" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="3" />
        <circle cx="18" cy="18" r={radius} fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" />
      </svg>
      <span className="absolute text-[10px] font-bold" style={{ color }}>{score}</span>
    </div>
  );
}

export default function LeadScoreBadge({ lead }) {
  const tier = lead.qualification_tier || null;
  const score = lead.score || 0;
  const sentiment = lead.sentiment || null;
  const config = tier ? tierConfig[tier] : null;
  const Icon = config?.icon;

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2">
        <ScoreRing score={score} />
        <div className="flex flex-col gap-0.5">
          {config ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className={`${config.color} text-[10px] px-1.5 py-0 gap-1 cursor-default`}>
                  <Icon className="w-3 h-3" /> {config.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                <p>{lead.qualification_reason || 'No details'}</p>
                {lead.intent_signals?.length > 0 && (
                  <p className="mt-1 text-muted-foreground">Signals: {lead.intent_signals.join(', ')}</p>
                )}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-[10px] text-gray-400">Unscored</span>
          )}
          {sentiment && (
            <span className={`text-[10px] capitalize ${sentimentColors[sentiment] || 'text-gray-400'}`}>
              {sentiment.replace('_', ' ')}
            </span>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}