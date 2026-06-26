import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import NavigationTracker from '@/lib/NavigationTracker'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import RootRedirect from '@/components/RootRedirect';
import PartnerReferral from './pages/PartnerReferral';
import CompliancePolicy from './pages/CompliancePolicy';
import AdminComplaints from './pages/AdminComplaints';
import ClientSocialMedia from './pages/ClientSocialMedia';
import SocialMediaCalendar from './pages/SocialMediaCalendar';
import ClientBrandSettings from './pages/ClientBrandSettings';
import PersonalDashboard from './pages/PersonalDashboard';
import PersonalAIAssistant from './pages/PersonalAIAssistant';
import AdminTopups from './pages/AdminTopups';
import AdminTrustedClients from './pages/AdminTrustedClients';
import AdminWebsiteLeads from './pages/AdminWebsiteLeads';
import AdminResellerBranding from './pages/AdminResellerBranding';
import ClientWhatsAppTemplates from './pages/ClientWhatsAppTemplates';
import AdminPlatformMessaging from './pages/AdminPlatformMessaging';
import AdminAnnouncements from './pages/AdminAnnouncements';
import AdminClientLifecycle from './pages/AdminClientLifecycle';
import AdminPaymentApprovals from './pages/AdminPaymentApprovals';
import ClientWhatsAppHistory from './pages/ClientWhatsAppHistory';
import AdminUsers from './pages/AdminUsers';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AdminLayout from './AdminLayout';

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

const AdminLayoutWrapper = ({ children, currentPageName }) => 
  <AdminLayout currentPageName={currentPageName}>{children}</AdminLayout>;

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  const location = useLocation();
  const PUBLIC_ROUTES = [
    '/', '/Home', '/PartnerReferral', '/CompliancePolicy', 
    '/PrivacyPolicy', '/RefundPolicy', '/TermsOfService', 
    '/PartnerSignup', '/APIDocs', '/ConceptNote', '/Login', '/Signup'
  ];
  const isPublicRoute = PUBLIC_ROUTES.includes(location.pathname);

  // Show loading spinner while checking app public settings or auth
  if ((isLoadingPublicSettings || isLoadingAuth) && !isPublicRoute) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError && !isPublicRoute) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically using React Router to avoid hard reloads
      return <Navigate to="/Login" replace />;
    }
  }

  // Render the main app
  return (
    <Routes>
      {/* Root path auto-redirects: unauthenticated → login, authenticated → role-based dashboard */}
      <Route path="/" element={<RootRedirect />} />
      <Route path="/Login" element={<Login />} />
      <Route path="/Signup" element={<Signup />} />
      {Object.entries(Pages).map(([path, Page]) => {
        const Wrapper = path.startsWith('Admin') ? AdminLayoutWrapper : LayoutWrapper;
        return (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <Wrapper currentPageName={path}>
                <Page />
              </Wrapper>
            }
          />
        );
      })}
      <Route path="/PartnerReferral" element={
        <LayoutWrapper currentPageName="PartnerReferral">
          <PartnerReferral />
        </LayoutWrapper>
      } />
      <Route path="/CompliancePolicy" element={
        <LayoutWrapper currentPageName="CompliancePolicy">
          <CompliancePolicy />
        </LayoutWrapper>
      } />
      <Route path="/AdminComplaints" element={
        <AdminLayoutWrapper currentPageName="AdminComplaints">
          <AdminComplaints />
        </AdminLayoutWrapper>
      } />
      <Route path="/ClientSocialMedia" element={
        <LayoutWrapper currentPageName="ClientSocialMedia">
          <ClientSocialMedia />
        </LayoutWrapper>
      } />
      <Route path="/SocialMediaCalendar" element={
        <LayoutWrapper currentPageName="SocialMediaCalendar">
          <SocialMediaCalendar />
        </LayoutWrapper>
      } />
      <Route path="/ClientBrandSettings" element={
        <LayoutWrapper currentPageName="ClientBrandSettings">
          <ClientBrandSettings />
        </LayoutWrapper>
      } />
      <Route path="/PersonalDashboard" element={
        <LayoutWrapper currentPageName="PersonalDashboard">
          <PersonalDashboard />
        </LayoutWrapper>
      } />
      <Route path="/PersonalAIAssistant" element={
        <LayoutWrapper currentPageName="PersonalAIAssistant">
          <PersonalAIAssistant />
        </LayoutWrapper>
      } />
      <Route path="/AdminTopups" element={
        <AdminLayoutWrapper currentPageName="AdminTopups">
          <AdminTopups />
        </AdminLayoutWrapper>
      } />
      <Route path="/AdminTrustedClients" element={
        <AdminLayoutWrapper currentPageName="AdminTrustedClients">
          <AdminTrustedClients />
        </AdminLayoutWrapper>
      } />
      <Route path="/AdminWebsiteLeads" element={
        <AdminLayoutWrapper currentPageName="AdminWebsiteLeads">
          <AdminWebsiteLeads />
        </AdminLayoutWrapper>
      } />
      <Route path="/AdminResellerBranding" element={
        <AdminLayoutWrapper currentPageName="AdminResellerBranding">
          <AdminResellerBranding />
        </AdminLayoutWrapper>
      } />
      <Route path="/ClientWhatsAppTemplates" element={
        <LayoutWrapper currentPageName="ClientWhatsAppTemplates">
          <ClientWhatsAppTemplates />
        </LayoutWrapper>
      } />
      <Route path="/AdminPlatformMessaging" element={
        <AdminLayoutWrapper currentPageName="AdminPlatformMessaging">
          <AdminPlatformMessaging />
        </AdminLayoutWrapper>
      } />
      <Route path="/AdminAnnouncements" element={
        <AdminLayoutWrapper currentPageName="AdminAnnouncements">
          <AdminAnnouncements />
        </AdminLayoutWrapper>
      } />
      <Route path="/AdminClientLifecycle" element={
        <AdminLayoutWrapper currentPageName="AdminClientLifecycle">
          <AdminClientLifecycle />
        </AdminLayoutWrapper>
      } />
      <Route path="/AdminPaymentApprovals" element={
        <AdminLayoutWrapper currentPageName="AdminPaymentApprovals">
          <AdminPaymentApprovals />
        </AdminLayoutWrapper>
      } />
      <Route path="/AdminUsers" element={
        <AdminLayoutWrapper currentPageName="AdminUsers">
          <AdminUsers />
        </AdminLayoutWrapper>
      } />
      <Route path="/ClientWhatsAppHistory" element={
        <LayoutWrapper currentPageName="ClientWhatsAppHistory">
          <ClientWhatsAppHistory />
        </LayoutWrapper>
      } />
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <NavigationTracker />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App