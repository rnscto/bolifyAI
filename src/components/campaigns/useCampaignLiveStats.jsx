import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/api/apiClient';

// Computes LIVE campaign stats directly from CampaignLead records.
// This does NOT depend on integration credits — the denormalized counters on the
// Campaign record (calls_completed / calls_failed / outcomes_summary) are only kept
// fresh by the entity-triggered automation, which is blocked when credits run out.
// Reading the leads directly gives accurate, real-time status regardless of credits.
export function useCampaignLiveStats(campaigns) {
  const [statsMap, setStatsMap] = useState({});

  const computeStats = useCallback(async () => {
    if (!campaigns || campaigns.length === 0) return;
    const next = {};
    await Promise.all(
      campaigns.map(async (c) => {
        try {
          const leads = await apiClient.CampaignLead.filter(
            { campaign_id: c.id }, 'created_at', 2000
          );
          const outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
          let completed = 0, failed = 0;
          leads.forEach((l) => {
            if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
            if (l.status === 'completed') completed++;
            if (l.status === 'failed') failed++;
          });
          next[c.id] = {
            total_leads: leads.length || c.total_leads || 0,
            calls_completed: completed,
            calls_failed: failed,
            outcomes_summary: outcomes,
          };
        } catch (_) {
          // fall back to the stored counters on error
        }
      })
    );
    setStatsMap(next);
  }, [campaigns]);

  useEffect(() => {
    computeStats();
  }, [computeStats]);

  return statsMap;
}