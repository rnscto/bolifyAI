import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from './utils';
import { apiClient } from '@/api/apiClient';
import {
  LayoutDashboard,
  Users,
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
  MessageSquare
} from 'lucide-react';
import AnnouncementMarquee from './components/AnnouncementMarquee';

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

  const isMainAdmin = user.email === 'yadavnand886@gmail.com';
  const isReseller = user.role === 'reseller' || user.role === 'master_reseller';

  const adminNav = [
    { name: 'Dashboard', path: 'AdminDashboard', icon: LayoutDashboard },
    { name: 'Clients', path: 'AdminClients', icon: Users },
    { name: 'CRM Access Requests', path: 'AdminCRMRequests', icon: Database },
    { name: 'Payment Approvals', path: 'AdminPaymentApprovals', icon: ShieldCheck },
    ...(isMainAdmin ? [{ name: 'Client Lifecycle', path: 'AdminClientLifecycle', icon: ShieldCheck }] : []),
    { name: 'Website Leads', path: 'AdminWebsiteLeads', icon: Globe },
    { name: 'Agents', path: 'AdminAgents', icon: Cpu },
    { name: 'DIDs', path: 'AdminDIDs', icon: Phone },
    { name: 'Retention', path: 'AdminRetention', icon: PhoneCall },
    { name: 'Subscriptions', path: 'AdminSubscriptions', icon: CreditCard },
    { name: 'Payments', path: 'AdminPayments', icon: IndianRupee },
    { name: 'Wallet Top-Ups', path: 'AdminTopups', icon: Wallet },
    { name: 'Outreach', path: 'AdminOutreach', icon: Activity },
    { name: 'API Docs', path: 'APIDocs', icon: FileText },
    { name: 'Concept Note', path: 'ConceptNote', icon: FileText },
    { name: 'Trusted Logos', path: 'AdminTrustedClients', icon: Globe },
    { name: 'Complaints', path: 'AdminComplaints', icon: Megaphone },
    { name: 'Announcements', path: 'AdminAnnouncements', icon: Megaphone },
    { name: 'Platform Messaging', path: 'AdminPlatformMessaging', icon: MessageSquare },
    { name: 'Partners', path: 'AdminPartners', icon: Handshake },
    ...(isReseller ? [{ name: 'Custom Domain', path: 'AdminResellerBranding', icon: Globe }] : []),
  ];

  return (
    <div className="min-h-screen bg-[#0f1115] text-gray-100 flex overflow-hidden selection:bg-cyan-500/30">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sleek Dark Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-72 bg-[#161920] border-r border-white/5 transform transition-transform duration-300 ease-out lg:translate-x-0 flex flex-col shadow-2xl ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo Area */}
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <SparklesIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg text-white tracking-tight">Bolify<span className="text-cyan-400">AI</span></h1>
              <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mt-0.5">Admin Workspace</p>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-gray-400 hover:text-white transition-colors p-2 rounded-lg hover:bg-white/5">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-4 space-y-1 custom-scrollbar">
          {adminNav.map((item) => {
            const Icon = item.icon;
            const isActive = currentPageName === item.path;
            return (
              <Link
                key={item.path}
                to={createPageUrl(item.path)}
                className={`flex items-center gap-3.5 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 group ${
                  isActive
                    ? 'bg-gradient-to-r from-cyan-500/10 to-blue-500/5 text-cyan-400 shadow-sm border border-cyan-500/20'
                    : 'text-gray-400 hover:text-gray-100 hover:bg-white/5'
                }`}
              >
                <Icon className={`w-5 h-5 transition-transform duration-200 ${isActive ? 'scale-110' : 'group-hover:scale-110'}`} />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* User Profile */}
        <div className="p-4 border-t border-white/5 bg-[#12141a]">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition-colors">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold shadow-inner">
              {user.display_name?.charAt(0) || user.email?.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">{user.display_name || user.email}</p>
              <p className="text-xs text-cyan-400 font-medium truncate capitalize">{user.role.replace('_', ' ')}</p>
            </div>
            <button onClick={handleLogout} className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-72 transition-all duration-300">
        <AnnouncementMarquee audience="admins" />
        
        {/* Glassmorphic Header */}
        <header className="sticky top-0 z-30 bg-[#0f1115]/80 backdrop-blur-xl border-b border-white/5 shadow-sm">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-4">
              <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-gray-400 hover:text-white p-2 rounded-lg hover:bg-white/5 transition-colors">
                <Menu className="w-6 h-6" />
              </button>
              <h2 className="text-xl font-semibold text-white tracking-tight hidden sm:block">
                {adminNav.find(n => n.path === currentPageName)?.name || 'Admin Panel'}
              </h2>
            </div>
            
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
                <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></div>
                <span className="text-xs font-medium text-cyan-400 tracking-wide uppercase">System Operational</span>
              </div>
            </div>
          </div>
        </header>

        {/* Dynamic Page Content */}
        <main className="flex-1 p-6 lg:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto space-y-8 fade-in-up text-gray-900">
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
