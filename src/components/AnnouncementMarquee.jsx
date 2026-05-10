import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Info, AlertTriangle, AlertOctagon, CheckCircle2, X } from 'lucide-react';

const SEVERITY_STYLES = {
  info:     { bg: 'bg-blue-600',   icon: Info,         label: 'Notice' },
  warning:  { bg: 'bg-amber-500',  icon: AlertTriangle, label: 'Heads up' },
  critical: { bg: 'bg-red-600',    icon: AlertOctagon,  label: 'Important' },
  success:  { bg: 'bg-emerald-600',icon: CheckCircle2,  label: 'Update' },
};

/**
 * Top-of-page running marquee for platform-wide announcements
 * (downtime, maintenance, releases, etc). Admin-managed via AdminAnnouncements.
 *
 * Props:
 *  - audience: 'all' | 'clients' | 'admins' (defaults to 'all'). Used to filter visible items.
 */
export default function AnnouncementMarquee({ audience = 'all' }) {
  const [items, setItems] = useState([]);
  const [dismissedIds, setDismissedIds] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('dismissed_announcements') || '[]'); }
    catch { return []; }
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await base44.entities.PlatformAnnouncement.filter({ is_active: true }, '-created_date', 20);
        const now = Date.now();
        const visible = (all || []).filter(a => {
          if (a.audience && a.audience !== 'all' && a.audience !== audience) return false;
          if (a.starts_at && new Date(a.starts_at).getTime() > now) return false;
          if (a.ends_at && new Date(a.ends_at).getTime() < now) return false;
          return true;
        });
        if (!cancelled) setItems(visible);
      } catch (_) { /* ignore */ }
    };
    load();
    const t = setInterval(load, 60000); // refresh every minute
    return () => { cancelled = true; clearInterval(t); };
  }, [audience]);

  const visibleItems = items.filter(a => !dismissedIds.includes(a.id));
  if (visibleItems.length === 0) return null;

  // Use the highest severity to color the bar (critical > warning > info > success)
  const order = { critical: 3, warning: 2, info: 1, success: 0 };
  const top = [...visibleItems].sort((a, b) => (order[b.severity] || 0) - (order[a.severity] || 0))[0];
  const style = SEVERITY_STYLES[top.severity] || SEVERITY_STYLES.info;
  const Icon = style.icon;

  const dismissAll = () => {
    const ids = visibleItems.map(i => i.id);
    const next = [...dismissedIds, ...ids];
    setDismissedIds(next);
    try { sessionStorage.setItem('dismissed_announcements', JSON.stringify(next)); } catch (_) {}
  };

  // Build a single ticker string repeating the items so the loop looks continuous
  const ticker = visibleItems.map(a => a.message).join('   •   ');

  return (
    <div className={`${style.bg} text-white text-sm relative overflow-hidden`}>
      <div className="flex items-center gap-3 px-4 py-2">
        <div className="flex items-center gap-1.5 shrink-0 font-medium">
          <Icon className="w-4 h-4" />
          <span className="hidden sm:inline">{style.label}</span>
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="whitespace-nowrap animate-marquee inline-block">
            <span className="px-4">{ticker}</span>
            <span className="px-4">{ticker}</span>
          </div>
        </div>
        <button
          onClick={dismissAll}
          className="shrink-0 opacity-80 hover:opacity-100"
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <style>{`
        @keyframes marquee {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .animate-marquee {
          animation: marquee 40s linear infinite;
        }
      `}</style>
    </div>
  );
}