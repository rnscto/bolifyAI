import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from './utils';
import { base44 } from '@/api/base44Client';
import {
  LayoutDashboard,
  Users,
  Phone,
  Cpu,
  FileText,
  CreditCard,
  Settings,
  LogOut,
  Menu,
  X,
  PhoneCall,
  Database,
  Activity,
  BookOpen
} from 'lucide-react';

export default function Layout({ children, currentPageName }) {
  const [user, setUser] = useState(null);
  const [client, setClient] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  const isPublicPage = ['Home', 'PrivacyPolicy', 'TermsOfService'].includes(currentPageName);
  const isOnboardingPage = currentPageName === 'Onboarding';

  useEffect(() => {
    if (!isPublicPage && !isOnboardingPage) {
      loadUser();
    }
  }, [isPublicPage, isOnboardingPage]);

  const loadUser = async () => {
    try {
      const currentUser = await base44.auth.me();
      setUser(currentUser);
      
      if (currentUser.role !== 'admin') {
        const clients = await base44.entities.Client.filter({ user_id: currentUser.id });
        if (clients.length > 0) {
          setClient(clients[0]);
          // If onboarding not completed, redirect
          if (!clients[0].onboarding_completed) {
            window.location.href = createPageUrl('Onboarding');
            return;
          }
        } else {
          // No client record - redirect to onboarding
          window.location.href = createPageUrl('Onboarding');
          return;
        }
      }
    } catch (error) {
      console.error('Error loading user:', error);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    base44.auth.logout();
  };

  if (isPublicPage || isOnboardingPage) {
    return <>{children}</>;
  }

  const isAdmin = user?.role === 'admin';

  const adminNav = [
    { name: 'Dashboard', path: 'AdminDashboard', icon: LayoutDashboard },
    { name: 'Clients', path: 'AdminClients', icon: Users },
    { name: 'Agents', path: 'AdminAgents', icon: Cpu },
    { name: 'DIDs', path: 'AdminDIDs', icon: Phone },
    { name: 'Subscriptions', path: 'AdminSubscriptions', icon: CreditCard },
    { name: 'API Docs', path: 'APIDocs', icon: FileText },
  ];

  const clientNav = [
    { name: 'Dashboard', path: 'ClientDashboard', icon: LayoutDashboard },
    { name: 'Agents', path: 'ClientAgents', icon: Cpu },
    { name: 'Leads', path: 'ClientLeads', icon: Users },
    { name: 'Call Logs', path: 'ClientCallLogs', icon: PhoneCall },
    { name: 'Knowledge Base', path: 'ClientKnowledgeBase', icon: BookOpen },
    { name: 'Activities', path: 'ClientActivities', icon: Activity },
    { name: 'CRM Integration', path: 'ClientCRM', icon: Database },
    { name: 'Subscription', path: 'ClientSubscription', icon: CreditCard },
    { name: 'API Docs', path: 'APIDocs', icon: FileText },
  ];

  // CRM sub-navigation (shown when CRM is active)
  const crmNav = client?.has_custom_crm ? [
    { name: 'CRM Dashboard', path: 'ClientCRMDashboard', icon: LayoutDashboard },
    { name: 'Deals', path: 'ClientCRMDeals', icon: Activity },
    { name: 'Contacts', path: 'ClientCRMContacts', icon: Users },
    { name: 'Reports', path: 'ClientCRMReports', icon: FileText },
  ] : [];

  const navigation = isAdmin ? adminNav : clientNav;

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 gap-4">
        <p className="text-gray-600">Please log in to access the dashboard.</p>
        <button onClick={() => base44.auth.redirectToLogin()} className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          Log In
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-gray-900 bg-opacity-50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-64 bg-white border-r border-gray-200 transform transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between p-6 border-b">
            <div className="flex items-center gap-2">
              <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png" alt="VaaniAI" className="h-[68px] object-contain" />
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden text-gray-500 hover:text-gray-700"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto p-4">
            <div className="space-y-1">
                  {navigation.map((item) => {
                    const Icon = item.icon;
                    const isActive = currentPageName === item.path;
                    return (
                      <Link
                        key={item.path}
                        to={createPageUrl(item.path)}
                        className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                          isActive
                            ? 'bg-blue-50 text-blue-700'
                            : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                        {item.name}
                      </Link>
                    );
                  })}
                  {crmNav.length > 0 && (
                    <>
                      <div className="px-4 pt-4 pb-2">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">CRM</p>
                      </div>
                      {crmNav.map((item) => {
                        const Icon = item.icon;
                        const isActive = currentPageName === item.path;
                        return (
                          <Link
                            key={item.path}
                            to={createPageUrl(item.path)}
                            className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                              isActive
                                ? 'bg-indigo-50 text-indigo-700'
                                : 'text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            <Icon className="w-5 h-5" />
                            {item.name}
                          </Link>
                        );
                      })}
                    </>
                  )}
                </div>
          </nav>

          {/* User info */}
          <div className="p-4 border-t">
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {user.full_name}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {isAdmin ? 'Administrator' : client?.company_name}
                </p>
              </div>
              <button
                onClick={handleLogout}
                className="text-gray-400 hover:text-gray-600"
                title="Logout"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
          <div className="flex items-center justify-between px-4 py-4">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden text-gray-500 hover:text-gray-700"
            >
              <Menu className="w-6 h-6" />
            </button>
            <div className="flex-1 lg:flex lg:justify-end">
              <div className="text-sm text-gray-600">
                {isAdmin ? (
                  <span className="font-medium">Admin Panel</span>
                ) : (
                  <span>
                    Plan: <span className="font-medium">₹6,500/mo × {client?.total_channels || 1} channel(s)</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="p-6">
          {children}
        </main>
      </div>
    </div>
  );
}