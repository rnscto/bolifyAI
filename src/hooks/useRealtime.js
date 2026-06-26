import { useEffect } from 'react';
import { apiClient } from '@/api/apiClient';

/**
 * Custom hook to listen to real-time WebSocket updates for a specific entity.
 * Uses the underlying apiClient WebSocket connection.
 *
 * @param {string} entityKey - The key corresponding to the entity in apiClient (e.g. 'CampaignLead')
 * @param {function} callback - The callback to execute when an event occurs
 */
export function useRealtime(entityKey, callback) {
  useEffect(() => {
    if (!apiClient[entityKey] || typeof apiClient[entityKey].subscribe !== 'function') {
      console.warn(`useRealtime: Cannot subscribe to invalid entity key "${entityKey}"`);
      return;
    }
    
    const unsubscribe = apiClient[entityKey].subscribe(callback);
    
    return () => {
      unsubscribe();
    };
  }, [entityKey, callback]);
}
