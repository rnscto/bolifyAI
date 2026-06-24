import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DollarSign, User, Calendar } from 'lucide-react';

export default function DealKanban({ deals, stages, onDealClick, onStageDrop }) {
  const handleDragStart = (e, dealId) => {
    e.dataTransfer.setData('dealId', dealId);
  };

  const handleDrop = (e, stageName) => {
    e.preventDefault();
    const dealId = e.dataTransfer.getData('dealId');
    if (dealId && onStageDrop) onStageDrop(dealId, stageName);
  };

  const handleDragOver = (e) => e.preventDefault();

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {stages.map((stage) => {
        const stageDeals = deals.filter(d => d.stage === stage.name);
        const totalValue = stageDeals.reduce((s, d) => s + (d.value || 0), 0);

        return (
          <div
            key={stage.name}
            className="min-w-[280px] flex-shrink-0"
            onDrop={(e) => handleDrop(e, stage.name)}
            onDragOver={handleDragOver}
          >
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
                <span className="font-semibold text-sm text-gray-700">{stage.name}</span>
                <Badge variant="secondary" className="text-xs">{stageDeals.length}</Badge>
              </div>
              <span className="text-xs text-gray-500">₹{totalValue.toLocaleString()}</span>
            </div>

            <div className="space-y-2 min-h-[200px] bg-gray-50 rounded-xl p-2">
              {stageDeals.map((deal) => (
                <Card
                  key={deal.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, deal.id)}
                  onClick={() => onDealClick?.(deal)}
                  className="cursor-pointer hover:shadow-md transition-shadow bg-white"
                >
                  <CardContent className="p-3 space-y-2">
                    <p className="font-medium text-sm text-gray-900 line-clamp-1">{deal.title}</p>
                    {deal.value > 0 && (
                      <div className="flex items-center gap-1 text-xs text-green-700">
                        <DollarSign className="w-3 h-3" />
                        ₹{deal.value.toLocaleString()}
                      </div>
                    )}
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      {deal.assigned_to && (
                        <div className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          <span className="truncate max-w-[100px]">{deal.assigned_to}</span>
                        </div>
                      )}
                      {deal.expected_close_date && (
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {new Date(deal.expected_close_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                        </div>
                      )}
                    </div>
                    {deal.probability > 0 && (
                      <div className="w-full bg-gray-200 rounded-full h-1">
                        <div className="bg-indigo-500 h-1 rounded-full" style={{ width: `${deal.probability}%` }} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
              {stageDeals.length === 0 && (
                <div className="flex items-center justify-center h-20 text-xs text-gray-400">
                  Drop deals here
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}