import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from './utils';
import { apiClient } from '@/api/apiClient';
import {
  LayoutDashboard,
  Users,
  UserCog,
  Phone,
  Cpu,
  FileText,
  CreditCard,
  LogOut,
  Menu,
  X,
  PhoneCall,
  Database,
  Activity,
  IndianRupee,
  Wallet,
  Megaphone,
  Globe,
  Handshake,
  ShieldCheck,
  MessageSquare,
  LifeBuoy,
  ChevronRight
} from 'lucide-react';
import AnnouncementMarquee from './components/AnnouncementMarquee';

// ────────────────────────────────────────────────────────────────────────────
// MASTER ADMIN — the one and only super-user of the platform
// ────────────────────────────────────────────────────────────────────────────
const MASTER_ADMIN_EMAIL = 'yadav.nandkishor73@gmail.com';

export default function AdminLayout({ children, currentPageName }) {
  const [user, setUser] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    try {
      const currentUser = await apiClient.auth.me();
      const adminRoles = ['admin', 'master_admin', 'reseller', 'master_reseller'];

      if (!adminRoles.includes(currentUser.role)) {
        window.location.href = createPageUrl('ClientDashboard');
        return;
      }

      setUser(currentUser);
    } catch (error) {
      console.error('Error loading admin user:', error);
      window.location.href = createPageUrl('Login');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiClient.auth.logout();
    } catch (error) {
      console.error('Logout failed', error);
    }
    window.location.href = createPageUrl('Login');
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-500"></div>
      </div>
    );
  }

  if (!user) return null;

  const isMasterAdmin = user.email === MASTER_ADMIN_EMAIL;
  const isReseller = user.role === 'reseller' || user.role === 'master_reseller';
  const isAdminOrAbove = user.role === 'admin' || user.role === 'master_admin';

  // ── Nav structure with section grouping ──────────────────────────────────
  const navSections = [
    {
      label: null, // no label for top items
      items: [
        { name: 'Dashboard', path: 'AdminDashboard', icon: LayoutDashboard },
      ],
    },
    {
      label: 'MASTER CONTROL',
      show: isMasterAdmin,
      items: [
        { name: 'Client Lifecycle', path: 'AdminClientLifecycle', icon: ShieldCheck },
        { name: 'Payment Approvals', path: 'AdminPaymentApprovals', icon: ShieldCheck },
        { name: 'Messaging Configs', path: 'AdminPlatformMessaging', icon: MessageSquare },
        { name: 'Announcements', path: 'AdminAnnouncements', icon: Megaphone },
        { name: 'Support Tickets', path: 'AdminTickets', icon: LifeBuoy },
      ],
    },
    {
      label: 'CLIENTS',
      items: [
        { name: 'Clients', path: 'AdminClients', icon: Users },
        { name: 'Users', path: 'AdminUsers', icon: UserCog },
        { name: 'CRM Access Requests', path: 'AdminCRMRequests', icon: Database },
        { name: 'Retention', path: 'AdminRetention', icon: PhoneCall },
      ],
    },
    {
      label: 'RESELLERS',
      items: [
        { name: 'Partners', path: 'AdminPartners', icon: Handshake },
        ...(isReseller ? [{ name: 'Partner Settings', path: 'AdminResellerBranding', icon: Globe }] : []),
      ],
    },
    {
      label: 'INFRASTRUCTURE',
      items: [
        { name: 'Agents', path: 'AdminAgents', icon: Cpu },
        { name: 'DIDs', path: 'AdminDIDs', icon: Phone },
        { name: 'Outreach', path: 'AdminOutreach', icon: Activity },
        { name: 'Website Leads', path: 'AdminWebsiteLeads', icon: Globe },
        { name: 'Trusted Logos', path: 'AdminTrustedClients', icon: Globe },
      ],
    },
    {
      label: 'BILLING',
      items: [
        { name: 'Subscriptions', path: 'AdminSubscriptions', icon: CreditCard },
        { name: 'Payments', path: 'AdminPayments', icon: IndianRupee },
        { name: 'Invoices', path: 'AdminInvoices', icon: IndianRupee },
        { name: 'Wallet Top-Ups', path: 'AdminTopups', icon: Wallet },
      ],
    },
    {
      label: 'SETTINGS',
      items: [
        { name: 'Account & Billing', path: 'AdminSettings', icon: UserCog },
      ],
    },
    {
      label: 'DOCS & SUPPORT',
      items: [
        { name: 'Complaints', path: 'AdminComplaints', icon: Megaphone },
        { name: 'API Docs', path: 'APIDocs', icon: FileText },
        { name: 'Concept Note', path: 'ConceptNote', icon: FileText },
      ],
    },
  ];

  // flat list for header title lookup
  const allNavItems = navSections.flatMap(s => s.items);

  return (
    <div className="min-h-screen bg-slate-50 text-gray-900 flex overflow-hidden selection:bg-blue-100">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sleek Dark Sidebar ── */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-72 bg-white border-r border-slate-200 transform transition-transform duration-300 ease-out lg:translate-x-0 flex flex-col shadow-lg ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo Area */}
        <div className="flex items-center justify-between p-6 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center shadow-md shadow-blue-500/20">
              <SparklesIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg text-gray-900 tracking-tight">Bolify<span className="text-blue-600">AI</span></h1>
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mt-0.5">
                {isMasterAdmin ? 'Master Admin' : isReseller ? (user.role === 'master_reseller' ? 'Master Reseller' : 'Reseller') : 'Admin Workspace'}
              </p>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-slate-400 hover:text-slate-700 transition-colors p-2 rounded-lg hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar">
          {navSections
            .filter(section => section.show !== false)
            .map((section, sIdx) => (
              <div key={sIdx} className="mb-2">
                {section.label && (
                  <p className="text-[9px] font-bold text-gray-600 uppercase tracking-[0.15em] px-3 pt-4 pb-1.5">
                    {section.label}
                  </p>
                )}
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = currentPageName === item.path;
                  return (
                    <Link
                      key={item.path}
                      to={createPageUrl(item.path)}
                      onClick={() => setSidebarOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group ${
                        isActive
                          ? 'bg-blue-50 text-blue-700 border border-blue-100 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                      }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-blue-600' : 'text-slate-400 group-hover:text-slate-600'}`} />
                      <span className="flex-1">{item.name}</span>
                      {isActive && <ChevronRight className="w-3 h-3 text-blue-400" />}
                    </Link>
                  );
                })}
              </div>
            ))}
        </nav>

        {/* User Profile */}
        <div className="p-4 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-white border border-slate-200 hover:border-slate-300 shadow-sm transition-colors">
            <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-600 to-blue-500 flex items-center justify-center text-white text-sm font-bold shadow-inner shrink-0">
              {user.display_name?.charAt(0) || user.email?.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{user.display_name || user.email}</p>
              <p className="text-xs font-medium truncate capitalize" style={{color: isMasterAdmin ? '#d97706' : '#2563eb'}}>
                {isMasterAdmin ? '★ Master Admin' : user.role.replace('_', ' ')}
              </p>
            </div>
            <button onClick={handleLogout} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-72 transition-all duration-300">
        <AnnouncementMarquee audience="admins" />

        {/* Glassmorphic Header */}
        <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-xl border-b border-slate-200 shadow-sm">
          <div className="flex items-center justify-between px-6 py-3.5">
            <div className="flex items-center gap-4">
              <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-slate-500 hover:text-gray-900 p-2 rounded-lg hover:bg-slate-100 transition-colors">
                <Menu className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-xl font-bold text-gray-900 tracking-tight">{currentPageName.replace(/([A-Z])/g, ' $1').trim()}</h2>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 border border-slate-200">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                <span className="text-xs font-medium text-slate-600">System Operational</span>
              </div>
              {isMasterAdmin && (
                <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
                  <ShieldCheck className="w-3 h-3 text-amber-400" />
                  <span className="text-xs font-medium text-amber-400 tracking-wide">Master Control</span>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Dynamic Page Content — inherits text-gray-100 from root */}
        <main className="flex-1 p-6 lg:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto space-y-8 fade-in-up">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function SparklesIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
      <path d="M5 3v4M3 5h4"/>
    </svg>
  );
}
