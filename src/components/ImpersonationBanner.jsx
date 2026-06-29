import React from 'react';
import { useAuth } from '../lib/AuthContext';
import { apiClient } from '../api/apiClient';
import { AlertTriangle, LogOut } from 'lucide-react';

export default function ImpersonationBanner() {
  const { user } = useAuth();
  
  // Check if original token exists
  const isImpersonating = !!localStorage.getItem("bolifyai_original_token");

  if (!isImpersonating) {
    return null;
  }

  return (
    <div className="bg-amber-500 text-black px-4 py-2 flex items-center justify-center gap-4 text-sm font-medium z-[9999] relative shadow-md">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" />
        <span>You are currently impersonating <strong>{user?.email || 'a user'}</strong>. Actions taken will be logged under this account.</span>
      </div>
      <button 
        onClick={() => apiClient.auth.stopImpersonating()}
        className="flex items-center gap-1.5 px-3 py-1 bg-black/10 hover:bg-black/20 rounded-md transition-colors"
      >
        <LogOut className="w-3.5 h-3.5" />
        Switch Back
      </button>
    </div>
  );
}
