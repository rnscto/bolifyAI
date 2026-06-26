import React, { useEffect, useState } from 'react';
import { apiClient } from '@/api/apiClient';
import { Navigate } from 'react-router-dom';

/**
 * Auto-redirects the root path (/) based on auth + role state:
 * - Not authenticated → Base44 login page
 * - Admin → /AdminDashboard
 * - Personal account → /PersonalDashboard
 * - Business account → /ClientDashboard
 * - No client record / onboarding not done → /Onboarding
 */
export default function RootRedirect() {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const authed = await apiClient.auth.isAuthenticated();
        if (!authed) {
          setTarget('/Login');
          return;
        }
        const user = await apiClient.auth.me();
        if (cancelled) return;

        if (user.role === 'admin') {
          setTarget('/AdminDashboard');
          return;
        }

        // Look up client record
        let clients = [];
        try { clients = await apiClient.Client.filter({ user_id: user.id }); } catch (_) {}
        if (clients.length === 0) {
          try { clients = await apiClient.Client.filter({ email: user.email }); } catch (_) {}
        }

        if (clients.length === 0 || !clients[0].onboarding_completed) {
          setTarget('/Onboarding');
          return;
        }

        if (clients[0].account_type === 'personal') {
          setTarget('/PersonalDashboard');
        } else {
          setTarget('/ClientDashboard');
        }
      } catch (e) {
        // On any unexpected error, send to login as a safe default
        setTarget('/Login');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!target) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-600" />
      </div>
    );
  }
  return <Navigate to={target} replace />;
}