import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import NavigationTracker from '@/lib/NavigationTracker'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
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
import ClientWhatsAppTemplates from './pages/ClientWhatsAppTemplates';
import AdminPlatformMessaging from './pages/AdminPlatformMessaging';
import AdminAnnouncements from './pages/AdminAnnouncements';
import AdminClientLifecycle from './pages/AdminClientLifecycle';
import AdminPaymentApprovals from './pages/AdminPaymentApprovals';
import ClientWhatsAppHistory from './pages/ClientWhatsAppHistory';

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Routes>
      {/* Root path auto-redirects: unauthenticated → login, authenticated → role-based dashboard */}
      <Route path="/" element={<RootRedirect />} />
      {Object.entries(Pages).map(([path, Page]) => (
        <Route
          key={path}
          path={`/${path}`}
          element={
            <LayoutWrapper currentPageName={path}>
              <Page />
            </LayoutWrapper>
          }
        />
      ))}
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
        <LayoutWrapper currentPageName="AdminComplaints">
          <AdminComplaints />
        </LayoutWrapper>
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
        <LayoutWrapper currentPageName="AdminTopups">
          <AdminTopups />
        </LayoutWrapper>
      } />
      <Route path="/ClientWhatsAppTemplates" element={
        <LayoutWrapper currentPageName="ClientWhatsAppTemplates">
          <ClientWhatsAppTemplates />
        </LayoutWrapper>
      } />
      <Route path="/AdminPlatformMessaging" element={
        <LayoutWrapper currentPageName="AdminPlatformMessaging">
          <AdminPlatformMessaging />
        </LayoutWrapper>
      } />
      <Route path="/AdminAnnouncements" element={
        <LayoutWrapper currentPageName="AdminAnnouncements">
          <AdminAnnouncements />
        </LayoutWrapper>
      } />
      <Route path="/AdminClientLifecycle" element={
        <LayoutWrapper currentPageName="AdminClientLifecycle">
          <AdminClientLifecycle />
        </LayoutWrapper>
      } />
      <Route path="/AdminPaymentApprovals" element={
        <LayoutWrapper currentPageName="AdminPaymentApprovals">
          <AdminPaymentApprovals />
        </LayoutWrapper>
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