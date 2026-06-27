import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/api/apiClient';

// Computes LIVE campaign stats via highly optimized Edge Function.
export function useCampaignLiveStats(campaigns) {
  const [statsMap, setStatsMap] = useState({});

  const computeStats = useCallback(async () => {
    if (!campaigns || campaigns.length === 0) return;
    
    // We only need the client_id to fetch all campaigns for this client at once.
    const clientId = campaigns[0].client_id;
    if (!clientId) return;

    try {
      const res = await apiClient.functions.invoke('getCampaignLiveStats', { client_id: clientId });
      if (res && res.data && res.data.success) {
        setStatsMap(res.data.stats);
      }
    } catch (_) {
      // Ignore errors, defaults to raw campaign counts
    }
  }, [campaigns]);

  useEffect(() => {
    computeStats();
  }, [computeStats]);

  return statsMap;
}