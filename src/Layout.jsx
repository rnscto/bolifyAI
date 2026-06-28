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
  Settings,
  LogOut,
  Menu,
  X,
  PhoneCall,
  Database,
  Activity,
  BookOpen,
  IndianRupee,
  Wallet,
  UserCog,
  Megaphone,
  BarChart3,
  Globe,
  Handshake,
  Zap,
  PhoneForwarded,
  Image,
  ShieldCheck,
  MessageSquare,
  LifeBuoy
} from 'lucide-react';
import AgreementGate from './components/client/AgreementGate';
import AnnouncementMarquee from './components/AnnouncementMarquee';
import SetDisplayNameDialog from './components/SetDisplayNameDialog';
import AccountStatusGate from './components/AccountStatusGate';
import AccountStatusBanner from './components/AccountStatusBanner';
import { useAuth } from './lib/AuthContext';

export default function Layout({ children, currentPageName }) {
  const [user, setUser] = useState(null);
  const [client, setClient] = useState(null);
  const { appPublicSettings } = useAuth();
  const [brand, setBrand] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [needsAgreement, setNeedsAgreement] = useState(false);
  const [needsDisplayName, setNeedsDisplayName] = useState(false);

  // Only legal pages remain publicly accessible (required for OAuth compliance).
  // All marketing / landing pages now require login.
  const isPublicPage = ['PrivacyPolicy', 'TermsOfService', 'RefundPolicy', 'CompliancePolicy'].includes(currentPageName);
  const isOnboardingPage = currentPageName === 'Onboarding';

  useEffect(() => {
    if (!isPublicPage && !isOnboardingPage) {
      loadUser();
    }
  }, [isPublicPage, isOnboardingPage]);

  const loadUser = async () => {
    try {
      const currentUser = await apiClient.auth.me();
      setUser(currentUser);
      const pureAdminRoles = ['admin', 'master_admin'];
      const isReseller = currentUser.role === 'reseller' || currentUser.role === 'master_reseller';
      // Prompt non-admin users to set a proper display name if missing
      if (currentUser.role !== 'admin' && !currentUser.display_name && !currentUser.data?.display_name) {
        setNeedsDisplayName(true);
      }
      
      if (currentUser.role !== 'admin') {
        let clients = [];
        try {
          clients = await apiClient.Client.filter({ user_id: currentUser.id });
        } catch (e) {
          console.log('Client filter by user_id failed:', e.message);
        }
        // Fallback: match by email if no user_id-linked client found (e.g. admin-created accounts)
        if (clients.length === 0) {
        try {
          const byEmail = await apiClient.Client.filter({ email: currentUser.email });
          if (byEmail.length > 0) {
            // Link user_id for future lookups
            try { await apiClient.Client.update(byEmail[0].id, { user_id: currentUser.id }); } catch (_) {}
            try { await apiClient.auth.updateMe({ client_id: byEmail[0].id }); } catch (_) {}
            clients = byEmail;
            }
          } catch (e) {
            console.log('Client filter by email failed:', e.message);
          }
        }
        if (clients.length > 0) {
          setClient(clients[0]);
          // Ensure client_id is stored on the user for RLS matching
          if (!currentUser.client_id || currentUser.client_id !== clients[0].id) {
            try { await apiClient.auth.updateMe({ client_id: clients[0].id }); } catch (_) {}
          }
          // Load client's white-label branding (logo, app name, color, favicon)
          try {
            const brandRows = await apiClient.BrandSettings.filter({ client_id: clients[0].id });
            if (brandRows.length > 0) setBrand(brandRows[0]);
          } catch (_) {}
          // If onboarding not completed, redirect
          if (!clients[0].onboarding_completed && !pureAdminRoles.includes(currentUser.role)) {
            window.location.href = createPageUrl('Onboarding');
            return;
          }
          // Redirect personal users from business dashboard to personal dashboard
          if (clients[0].account_type === 'personal' && currentPageName === 'ClientDashboard') {
            window.location.href = createPageUrl('PersonalDashboard');
            return;
          }
            // Check if trial expired and not subscribed — flip status so the gate kicks in
            if (clients[0].account_status === 'trial' && clients[0].trial_end_date) {
              const trialEnd = new Date(clients[0].trial_end_date);
              if (trialEnd < new Date()) {
                try { await apiClient.Client.update(clients[0].id, { account_status: 'expired' }); } catch (_) {}
                clients[0].account_status = 'expired';
              }
            }
        // Check if client has signed agreement
          if (clients[0].onboarding_completed) {
            const signedAgreements = await apiClient.ClientAgreement.filter({
              client_id: clients[0].id,
              status: 'signed'
            });
            if (signedAgreements.length === 0) {
              // Check if there's an active template requiring signing
              const activeTemplates = await apiClient.ClientAgreementTemplate.filter({ status: 'active' });
              if (activeTemplates.length > 0) {
                setNeedsAgreement(true);
              }
            }
          }
        } else {
          // No client record found — try broader search using created_by
          try {
            const byCreator = await apiClient.Client.filter({ created_by: currentUser.email });
            if (byCreator.length > 0) {
              try { await apiClient.Client.update(byCreator[0].id, { user_id: currentUser.id }); } catch (_) {}
              try { await apiClient.auth.updateMe({ client_id: byCreator[0].id }); } catch (_) {}
              setClient(byCreator[0]);
              if (!byCreator[0].onboarding_completed && !adminRoles.includes(currentUser.role)) {
                window.location.href = createPageUrl('Onboarding');
                return;
              }
            } else {
              console.log('No client found for user:', currentUser.email, currentUser.id);
              if (!pureAdminRoles.includes(currentUser.role)) {
                window.location.href = createPageUrl('Onboarding');
              }
              return;
            }
          } catch (e) {
            console.log('Client filter by created_by failed:', e.message);
            if (!pureAdminRoles.includes(currentUser.role)) {
              window.location.href = createPageUrl('Onboarding');
            }
            return;
          }
        }
      }
      
      // Admin dashboard check
      if (pureAdminRoles.includes(currentUser.role)) {
        if (isOnboardingPage) {
          window.location.href = createPageUrl('AdminDashboard');
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
    apiClient.auth.logout();
  };

  const pureAdminRoles = ['admin', 'master_admin'];
  const isAdmin = pureAdminRoles.includes(user?.role);
  const isReseller = user?.role === 'reseller' || user?.role === 'master_reseller';
  const isMainAdmin = user?.role === 'master_admin' || user?.role === 'admin';
  // White-label branding: use domain brand first, then client brand, then fallback
  const activeBrand = appPublicSettings?.brand || brand;
  
  const wlLogoUrl = !isAdmin && (activeBrand?.dashboard_logo_url || activeBrand?.logo_url) ? (activeBrand.dashboard_logo_url || activeBrand.logo_url) : 'https://media.base44.com/images/public/69c78272bd33d5309cbe2b7c/a1247aabb_generated_image.png';
  const wlAppName = !isAdmin && (activeBrand?.dashboard_app_name || activeBrand?.brand_name) ? (activeBrand.dashboard_app_name || activeBrand.brand_name) : 'Bolify AI';
  const wlPrimary = !isAdmin && (activeBrand?.dashboard_primary_color || activeBrand?.theme_colors?.primary) ? (activeBrand.dashboard_primary_color || activeBrand.theme_colors?.primary) : '#1D4ED8';
  const wlFavicon = !isAdmin && (activeBrand?.dashboard_favicon_url || activeBrand?.favicon_url) ? (activeBrand.dashboard_favicon_url || activeBrand.favicon_url) : null;

  // Update browser tab title + favicon to reflect white-label
  useEffect(() => {
    if (!isAdmin && brand?.dashboard_app_name) document.title = brand.dashboard_app_name;
    if (wlFavicon) {
      let link = document.querySelector("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = wlFavicon;
    }
  }, [brand, wlFavicon, isAdmin]);

  if (isPublicPage || isOnboardingPage) {
    return <>{children}</>;
  }

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
    ...(user?.role === 'reseller' || user?.role === 'master_reseller' ? [{ name: 'Custom Domain', path: 'AdminResellerBranding', icon: Globe }] : []),
    ];

    const personalNav = [
    { name: 'Dashboard', path: 'PersonalDashboard', icon: ShieldCheck },
    { name: 'AI Assistant', path: 'PersonalAIAssistant', icon: Cpu },
    { name: 'Call Logs', path: 'ClientCallLogs', icon: PhoneCall },
    { name: 'Settings', path: 'ClientSettings', icon: UserCog },
    { name: 'Support', path: 'ClientTickets', icon: LifeBuoy },
    ];

    const baseBusinessNav = [
    { name: 'Dashboard', path: 'ClientDashboard', icon: LayoutDashboard },
    { name: 'Agent Performance', path: 'AgentDashboard', icon: BarChart3 },
    { name: 'Agents', path: 'ClientAgents', icon: Cpu },
    { name: 'Leads', path: 'ClientLeads', icon: Users },
    { name: 'Campaigns', path: 'ClientCampaigns', icon: Megaphone },
    { name: 'Call Logs', path: 'ClientCallLogs', icon: PhoneCall },
    { name: 'Callbacks', path: 'ClientCallbacks', icon: PhoneForwarded },
    { name: 'Analytics', path: 'ClientAnalytics', icon: BarChart3 },
    { name: 'Knowledge Base', path: 'ClientKnowledgeBase', icon: BookOpen },
    { name: 'Activities', path: 'ClientActivities', icon: Activity },
    { name: 'Automation Engine', path: 'ClientAutomationEngine', icon: Zap },
    { name: 'Social Media', path: 'ClientSocialMedia', icon: Image },
    { name: 'Content Calendar', path: 'SocialMediaCalendar', icon: Activity },
    { name: 'Brand Settings', path: 'ClientBrandSettings', icon: Settings },
    { name: 'CRM Integration', path: 'ClientCRM', icon: Database },
    { name: 'Integrations', path: 'ClientIntegrations', icon: Activity },
    { name: 'WhatsApp Templates', path: 'ClientWhatsAppTemplates', icon: MessageSquare },
    { name: 'WhatsApp History', path: 'ClientWhatsAppHistory', icon: MessageSquare },
    { name: 'Settings', path: 'ClientSettings', icon: UserCog },
    { name: 'Partner Dashboard', path: 'PartnerDashboard', icon: Handshake },
    { name: 'API Docs', path: 'APIDocs', icon: FileText },
    ];

    const resellerSection = isReseller ? [
      { name: 'My Clients', path: 'AdminClients', icon: Users },
      { name: 'Commission Wallet', path: 'ResellerCommissionWallet', icon: Wallet },
      { name: 'Custom Domain', path: 'AdminResellerBranding', icon: Globe },
      { name: 'Subscriptions', path: 'AdminSubscriptions', icon: CreditCard },
      { name: 'Payments', path: 'AdminPayments', icon: IndianRupee },
    ] : [];

    const businessNav = [...baseBusinessNav, ...resellerSection];

    const clientNav = client?.account_type === 'personal' ? personalNav : businessNav;

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
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 gap-4">
        <p className="text-gray-600">Please log in to access the dashboard.</p>
        <button onClick={() => apiClient.auth.redirectToLogin()} className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          Log In
        </button>
      </div>
    );
  }

  // Block clients who haven't signed the agreement
  if (needsAgreement && !isAdmin) {
    return (
      <AgreementGate
        client={client}
        user={user}
        onSigned={() => setNeedsAgreement(false)}
      />
    );
  }

  // Block clients whose account is expired / suspended / pending activation.
  // Gate self-allows the Subscription + Settings pages so the user can pay/renew.
  const lockedStates = ['expired', 'suspended', 'activation_pending'];
  const showStatusGate = !isAdmin && client && lockedStates.includes(client.account_status);

  return (
    <div className="min-h-screen bg-slate-50">
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
              <img src={wlLogoUrl} alt={wlAppName} className="h-[56px] object-contain rounded-md" />
              {!isAdmin && brand?.dashboard_app_name && (
                <span className="font-semibold text-gray-800 text-sm hidden xl:inline">{wlAppName}</span>
              )}
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
                        style={isActive ? { color: wlPrimary, backgroundColor: `${wlPrimary}1A` } : undefined}
                        className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                          isActive
                            ? 'shadow-sm ring-1 ring-black/5'
                            : 'text-gray-600 hover:bg-slate-50 hover:text-gray-900'
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
                            style={isActive ? { color: wlPrimary, backgroundColor: `${wlPrimary}1A` } : undefined}
                            className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                              isActive ? 'shadow-sm ring-1 ring-black/5' : 'text-gray-600 hover:bg-slate-50 hover:text-gray-900'
                            }`}
                          >
                            <Icon className="w-5 h-5" />
                            {item.name}
                          </Link>
                        );
                      })}
                    </>
                  )}
                  {isReseller && !isAdmin && (
                    <div className="px-4 pt-4 pb-2 mt-4 border-t">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Reseller Admin</p>
                    </div>
                  )}
                </div>
          </nav>

          {/* User info */}
          <div className="p-4 border-t">
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {user.display_name || user.data?.display_name || user.full_name}
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
        {/* Platform-wide announcement marquee (admin-managed) */}
        <AnnouncementMarquee audience={isAdmin ? 'admins' : 'clients'} />
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between px-6 py-4 bg-white/80 backdrop-blur-md border-b border-slate-200/60 shadow-sm transition-all">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 -ml-2 text-gray-500 hover:text-gray-700 rounded-md hover:bg-slate-100 transition-colors"
            >
              <Menu className="w-6 h-6" />
            </button>
            <div className="flex-1 lg:flex lg:justify-end">
              <div className="text-sm text-gray-600">
                {isAdmin ? (
                  <span className="font-medium text-[#0097a7]">Admin Panel — Bolify AI</span>
                ) : !client ? null : (
                  <span>
                    {client?.billing_type === 'unlimited' ? (
                      <span>Plan: <span className="font-medium">Unlimited × {client?.total_channels || 1} channel(s)</span></span>
                    ) : (
                      <span>
                        Wallet: <span className={`font-medium ${(client?.wallet_balance || 0) < 100 && (client?.free_minutes_remaining || 0) <= 0 ? 'text-red-600' : 'text-green-600'}`}>
                          ₹{(client?.wallet_balance || 0).toLocaleString()}
                        </span>
                        {(client?.free_minutes_remaining || 0) > 0 && (
                          <span className="ml-2 text-blue-600">+ {client.free_minutes_remaining} free min</span>
                        )}
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="p-6 lg:p-8 max-w-7xl mx-auto min-h-[calc(100vh-73px)]">
          {!isAdmin && client && <AccountStatusBanner client={client} />}
          {children}
        </main>
      </div>

      {/* Hard lockout overlay for expired / suspended / activation_pending accounts */}
      {showStatusGate && (
        <AccountStatusGate client={client} currentPageName={currentPageName} />
      )}

      {/* First-time display name prompt (clients only) */}
      <SetDisplayNameDialog
        open={needsDisplayName && !isAdmin}
        defaultValue={user?.full_name || ''}
        onClose={(newName) => {
          setUser({ ...user, display_name: newName });
          setNeedsDisplayName(false);
        }}
      />
    </div>
  );
}